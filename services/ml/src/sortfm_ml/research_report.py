"""Private reproducible figures and a human-readable empirical report."""
from collections import defaultdict
import csv
import json
from pathlib import Path

import numpy as np

from .research_data import audio_count
from .research_diagnostics import measures, reliability


def fmt(value):
    return '—' if value is None else f'{value:.3f}'


def benchmark_table(protocol):
    if not protocol.get('models'):
        return 'Unavailable: '+protocol.get('reason', 'No eligible evaluation tracks')+'.'
    lines = ['| Model | ROC-AUC | AP (PR-AUC) | Log loss | Brier | P@5 | NDCG@5 |',
             '|---|---:|---:|---:|---:|---:|---:|']
    for name,row in protocol.get('models',{}).items():
        m=row['metrics']
        lines.append('| '+name+' | '+' | '.join(fmt(m.get(k)) for k in ('roc_auc','average_precision','log_loss','brier','precision_at_5','ndcg_at_5'))+' |')
    return '\n'.join(lines)


def audio_comparison(original, augmented, package):
    """Same-fold predictions restricted after scoring; never refit subsets."""
    result=[]
    available={r['trackId'] for r in package['audio_augmented'] if audio_count(r)>=3}
    for data_name,data in [('decision_time',original),('retrospective_audio',augmented)]:
        for protocol_name,protocol in data['protocols'].items():
            if not protocol.get('models'): continue
            for cohort in ('all_evaluation_tracks','current_audio_covered'):
                models={}
                for name in ('E2','E3','C1'):
                    preds=protocol['models'][name]['track_mean_oof_predictions']
                    preds=[r for r in preds if cohort=='all_evaluation_tracks' or r['track_id'] in available]
                    models[name]=measures([r['label'] for r in preds],[r['probability'] for r in preds])
                result.append({'dataset':data_name,'protocol':protocol_name,'cohort':cohort,'models':models,
                               'aggregation':'per-track mean out-of-fold probability; secondary diagnostic, not fold-macro primary table'})
    return result


def make_plots(report, output):
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    plt.rcParams.update({'font.size':10,'axes.spines.top':False,'axes.spines.right':False,'figure.facecolor':'white'})
    output=Path(output); output.mkdir(exist_ok=True)
    palette=['#235b8e','#dc7b36','#3b8c80','#8a64ab','#7c872f','#b5526d','#444444']
    def save(fig,name):
        fig.savefig(output/f'{name}.png',dpi=170,bbox_inches='tight');fig.savefig(output/f'{name}.svg',bbox_inches='tight');plt.close(fig)
    audit=report['audit'];diag=report['pinned_diagnostics']
    fig,ax=plt.subplots(2,2,figsize=(13,8),layout='constrained')
    years=sorted(audit['save_years']['library']);x=np.arange(len(years))
    for offset,key,color in [(-.18,'library',palette[0]),(.18,'labeled',palette[1])]:
        counts=audit['save_years'][key]; total=sum(counts.values())
        if not total: continue
        ax[0,0].bar(x+offset,[counts.get(y,0)/total for y in years],.36,label=f'{key} (n={total})',color=color)
    ax[0,0].set(xticks=x,xticklabels=years,title='Save-year selection distribution',ylabel='Fraction within cohort');ax[0,0].tick_params(axis='x',rotation=45);ax[0,0].legend()
    c=audit['coverage'];names=['train','holdout','labeled_audio_augmented','library_current']
    vals=[c[k]['any_audio']/c[k]['n'] if c[k]['n'] else np.nan for k in names]
    ax[0,1].bar(range(4),vals,color=[palette[0],palette[1],palette[2],palette[3]])
    ax[0,1].set(xticks=range(4),xticklabels=['Train at label','Holdout at label','Labels + current audio','Current library'],ylim=(0,1.13),title='Any audio coverage — distinct snapshots')
    ax[0,1].tick_params(axis='x',rotation=15)
    for i,k in enumerate(names):
        ax[0,1].text(i,vals[i]+.03 if c[k]['n'] else .03,
                     f"{c[k]['any_audio']}/{c[k]['n']}" if c[k]['n'] else 'No tracks',ha='center')
    q=audit['label_time_quartiles'];ix=np.arange(len(q))
    ax[1,0].bar(ix-.18,[r['audio']/r['n'] if r['n'] else 0 for r in q],.36,label='Audio observed',color=palette[0])
    ax[1,0].bar(ix+.18,[r['remove']/r['n'] if r['n'] else 0 for r in q],.36,label='Remove fraction',color=palette[1])
    ax[1,0].set(xticks=ix,xticklabels=[f"Q{r['quartile']} (n={r['n']})" for r in q],ylim=(0,1),title='Audio coverage and labels across collection');ax[1,0].legend()
    labels=['Train Keep','Train Remove','Holdout Keep','Holdout Remove']
    ax[1,1].bar(labels,[audit['counts'][s][y] for s in ('train','holdout') for y in ('keep','remove')],color=[palette[0],palette[1]]*2)
    ax[1,1].set(title='Actual human-label balance',ylabel='Tracks')
    fig.suptitle('Private C1 audit — a selected single-listener cohort',fontsize=16);save(fig,'dataset-audit')

    cv=report['original']['protocols']['train_repeated_stratified_cv'];names=list(cv.get('models',{}))
    if names:
        fig,axes=plt.subplots(2,2,figsize=(12,8),layout='constrained')
        for ax,key,title in zip(axes.flat,['roc_auc','average_precision','log_loss','brier'],['ROC-AUC ↑','Average precision ↑','Log loss ↓','Brier score ↓']):
            values=[cv['models'][n]['metrics'][key] for n in names]
            ax.bar(names,values,color=palette[:len(names)])
            for i,n in enumerate(names):
                ci=cv['models'][n]['intervals'].get(key)
                if ci: ax.vlines(i,ci['low'],ci['high'],color='#222',lw=1.4);ax.plot([i-.07,i+.07],[ci['low']]*2,color='#222');ax.plot([i-.07,i+.07],[ci['high']]*2,color='#222')
            ax.set(title=title,ylabel='Fold-macro metric')
        fig.suptitle(f"Training-only CV: {cv['unique_evaluation_tracks']} unique labels; repeated folds are not new evidence\nBars: fold-macro score · Lines: conditional track-bootstrap 95% intervals",fontsize=13)
        save(fig,'benchmark-comparison')

        fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
        for name in ('E0','E2','E3','C1'):
            preds=cv['models'][name]['track_mean_oof_predictions']; y=[p['label'] for p in preds];p=[p['probability'] for p in preds]
            bins=reliability(y,p)
            axes[0].plot([r['mean_probability'] for r in bins],[r['remove_fraction'] for r in bins],marker='o',label=name)
        axes[0].plot([0,1],[0,1],'--',color='#888');axes[0].set(xlim=(0,1),ylim=(0,1),xlabel='OOF probability, averaged within track',ylabel='Observed Remove fraction',title='Reliability: 5 fixed bins, sparse counts');axes[0].legend()
        preds=cv['models']['C1']['track_mean_oof_predictions']
        for label,text,color in [(0,'Keep',palette[0]),(1,'Remove',palette[1])]:
            axes[1].hist([p['probability'] for p in preds if p['label']==label],bins=np.linspace(0,1,11),alpha=.6,color=color,label=text)
        axes[1].set(xlabel='C1 out-of-fold probability',ylabel='Unique tracks',title='C1 score distributions on unseen CV tracks');axes[1].legend()
        save(fig,'calibration-and-oof-scores')

    if diag.get('status')=='available_uncalibrated':
        fig,axes=plt.subplots(1,2,figsize=(13,6),layout='constrained')
        weights=sorted(diag['feature_weights'],key=lambda r:abs(r['weight']),reverse=True)[:12][::-1]
        axes[0].barh([r['feature'] for r in weights],[r['weight'] for r in weights],color=[palette[1] if r['weight']>0 else palette[0] for r in weights]);axes[0].axvline(0,color='#aaa');axes[0].set(title='Pinned C1 coefficients',xlabel='Log-odds per training-IQR unit (values clipped)')
        groups=diag['library_mean_abs_contributions_by_family']
        axes[1].barh(list(groups),list(groups.values()),color=palette[:len(groups)]);axes[1].set(title='Contribution magnitudes on unlabeled library',xlabel='Sum of mean |feature contribution|, log odds')
        fig.suptitle('Associations and sensitivity, not causal feature importance',fontsize=14);save(fig,'feature-contributions')
        fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
        for i,key in enumerate(('train_resubstitution','monitoring_holdout','unlabeled_library')):
            values=diag['scores'][key]['probabilities']
            if values: axes[0].hist(values,bins=np.linspace(0,1,21),density=True,histtype='step',lw=1.7,label=f'{key} n={len(values)}',color=palette[i])
        axes[0].set(xlabel='Removal probability',ylabel='Density',title='Pinned model: distinct populations')
        if axes[0].get_legend_handles_labels()[0]: axes[0].legend(fontsize=8)
        bins=diag['holdout_reliability']
        axes[1].plot([0,1],[0,1],'--',color='#999')
        for b in bins:
            axes[1].errorbar(b['mean_probability'],b['remove_fraction'],yerr=[[b['remove_fraction']-b['wilson_low']],[b['wilson_high']-b['remove_fraction']]],fmt='o',color=palette[1]);axes[1].annotate(f"n={b['n']}",(b['mean_probability'],b['remove_fraction']),xytext=(5,5),textcoords='offset points')
        axes[1].set(xlim=(0,1),ylim=(-.04,1.04),xlabel='Mean probability',ylabel='Observed Remove fraction',title='Monitoring holdout reliability — Wilson intervals')
        save(fig,'pinned-score-distributions')

    summary=report['original']['learning_curves']['summary']
    if summary:
        fig,axes=plt.subplots(1,2,figsize=(12,5),layout='constrained')
        for ax,key in zip(axes,['log_loss','roc_auc']):
            for name,color,style in [('E2_batch',palette[0],'-'),('C1_batch',palette[3],'-'),('SGD_incremental',palette[1],'-'),('SGD_replay',palette[2],'--')]:
                if name not in summary[0]['models']:continue
                ax.plot([r['n_train'] for r in summary],[r['models'][name]['metrics'][key] for r in summary],style,marker='o',label=name,color=color)
                intervals=[r['models'][name].get('intervals',{}).get(key) for r in summary]
                if all(ci and ci.get('low') is not None for ci in intervals) and name!='SGD_replay':
                    ax.fill_between([r['n_train'] for r in summary],[ci['low'] for ci in intervals],[ci['high'] for ci in intervals],alpha=.10,color=color)
            ax.set(xlabel='Training labels (fixed unseen CV evaluation tracks)',ylabel=key,title='Same folds at every prefix');ax.legend()
        fig.suptitle('Retrospective learning curves — conditional track-bootstrap 95% bands\nSGD replay and incremental intentionally share updates; matching scores are expected',fontsize=13)
        save(fig,'learning-curves')


def write_report(report, output):
    output=Path(output);audit=report['audit'];diag=report['pinned_diagnostics']
    c=audit['counts']; cov=audit['coverage']
    lines=['# Private C1 empirical research report', '', f"Snapshot: {audit['snapshot_at']} · feedback revision {audit['revision']}.",
        '', 'This report contains real preference data. Keep it local and out of Git. No production model, ranking, labels, provider state, or shared contracts were changed.',
        '', '## What this evidence can establish', '',
        f"There are {c['all_labels']['n']} active human labels ({c['all_labels']['keep']} Keep/{c['all_labels']['remove']} Remove), with {c['train']['n']} training-assigned tracks and {c['holdout']['n']} monitoring holdouts ({c['holdout']['keep']} Keep/{c['holdout']['remove']} Remove). This is one listener and a selected cohort. It cannot establish population or cross-user generalization.",
        '', 'Existing holdout results have already been inspected. They are monitoring evidence, never a fresh final test. No model selection, hyperparameter search, or probability-calibration fit uses them. All exploration uses training-only CV.',
        '', '## Dataset audit', '',
        f"The verified library has {c['library']} tracks, {c['unlabeled']} without active labels and {c['calibration_eligible']} currently calibration-eligible. {cov['library_current']['any_audio']}/{c['library']} current tracks have audio; {cov['label_time']['any_audio']}/{c['all_labels']['n']} labels had audio at decision time. Retrospective audio covers {cov['labeled_audio_augmented']['any_audio']} labeled tracks. These populations and times must not be conflated.",
        '', f"Selection sources: `{json.dumps(audit['selection']['sources'])}`. Methods: `{json.dumps(audit['selection']['methods'])}`. Known propensities: {audit['selection']['known_propensities']}. Deterministic selection plus human skipping creates unknown inclusion probabilities; no inverse-probability correction is claimed.",
        '', f"Exposure-feature mismatches: {audit['exposure_feature_mismatches']}; labels before exposure: {audit['label_before_exposure']}. Fixed splits and model/database labels reconcile. {audit['holdout_artist_overlap_with_train']} holdout tracks share an artist with training; this is a within-listener, new-track evaluation, not an unseen-artist test.",
        '', 'Original saved timestamps span the years shown below. Library membership is current while labels reflect exposure time; changes in membership and the review queue mean the eligible target population is narrower than the complete library.',
        '', '![Dataset audit](plots/dataset-audit.png)', '',
        'The label-sequence plot measures coverage and class balance during collection. Enrichment order, queue priority and user progression can confound audio availability with preferences. The export has accepted feature snapshots but not a complete provider-attempt/time history; it cannot identify a causal enrichment effect.',
        '', '## Reproducible comparisons', '',
        'Recipes were fixed before computing comparison outcomes. E1–E3 use C1 preprocessing/regularization; E4 uses 40 shallow boosted trees; E5 uses missing-aware, train-scaled neighbors with prior smoothing. C1 adds train-only, leave-one-track-out preference centroids. E0 predicts each training-fold class prior. No imported Like becomes an automatic Keep label.',
        '', f"Primary table: mean metric across identical stratified folds, repeated {report['original']['config']['repeats']} times within the training-assigned cohort. Each model sees the same evaluation tracks. Repeats are not independent observations. AP is non-interpolated average precision, reported as the PR summary. Ranking uses expected relevance for score ties. k is capped at fold size; ranking a small fold is not a whole-library utility estimate.",
        '', benchmark_table(report['original']['protocols']['train_repeated_stratified_cv']), '',
        '![Benchmark comparison](plots/benchmark-comparison.png)', '',
        '95% intervals resample unique tracks with shared multiplicities across repeats and models. They condition on fitted folds and do not refit the model or correct selection bias, artist dependence or overlapping training folds. They are descriptive uncertainty, not confirmatory significance tests. Complete intervals, valid-draw counts, per-fold metrics and fit-fallback counts are in results.json and benchmarks.csv.',
        '', '### Paired log-loss difference against E2', '', '| Model − E2 | Difference | Conditional 95% interval |', '|---|---:|---|']
    cv=report['original']['protocols']['train_repeated_stratified_cv']
    for name,r in cv.get('paired_log_loss_vs_E2',{}).items():
        lines.append(f"| {name} | {fmt(r['delta'])} | [{fmt(r['low'])}, {fmt(r['high'])}] |")
    if cv.get('models'):
        baseline=cv['models']['E2']['metrics'];full=cv['models']['C1']['metrics'];contrast=cv['paired_log_loss_vs_E2']['C1']
        lines += ['',f"The metadata/history control E2 has CV log loss {fmt(baseline['log_loss'])}; full C1 has {fmt(full['log_loss'])}. The paired C1−E2 difference is {fmt(contrast['delta'])} [{fmt(contrast['low'])}, {fmt(contrast['high'])}]. This is the direct evidence for retaining a simpler control in the next prospective test rather than assuming preference centroids help."]
    lines += ['', 'Negative differences favor the named model. These contrasts do not select a replacement production model.',
              '', '### Fixed existing monitoring holdout', '',benchmark_table(report['original']['protocols']['monitoring_holdout']),
              '', f"There are {c['holdout']['remove']} positive monitoring labels; low positive counts make ROC/AP unstable. The deployed service withholds public efficacy metrics below its minimum-count gate. Numeric values here are explicitly exploratory and do not relax that gate.",
              '', '## What the pinned C1 is learning', '']
    if diag.get('status')=='available_uncalibrated':
        t=diag['scores']['train_resubstitution']['metrics'];h=diag['scores']['monitoring_holdout']['metrics']
        lines += [f"Pinned C1 training resubstitution: AUC {fmt(t.get('roc_auc'))}, AP {fmt(t.get('average_precision'))}, log loss {fmt(t.get('log_loss'))}, Brier {fmt(t.get('brier'))}. Monitoring: AUC {fmt(h.get('roc_auc'))}, AP {fmt(h.get('average_precision'))}, log loss {fmt(h.get('log_loss'))}, Brier {fmt(h.get('brier'))}. Training fit is not held-out efficacy.",
            '',f"Unlabeled score versus saved age Spearman correlation: {fmt(diag['unlabeled_score_spearman']['saved_age_days'])}. Listening-feature observed counts: {json.dumps({k:cov['label_time']['feature_observed'][k] for k in ('recent_play_count','top_track_short','top_track_medium','top_track_long','top_artist')})}. Unobserved signals cannot establish learned listening affinity. The charts measure audio and similarity contributions to current library predictions. An individual coefficient or a sum across many audio columns is not a fair causal attribution or proof of improved prediction.",
            '', '![Feature contributions](plots/feature-contributions.png)', '', '![Pinned scores](plots/pinned-score-distributions.png)', '',
            f"The additive log-odds decomposition reconstructs pinned probabilities with maximum absolute error {diag['decomposition_max_probability_error']:.2g}. Predictive entropy expresses model ambiguity, not epistemic uncertainty. Probabilities are uncalibrated.",
            '', '### Largest monitoring errors (opaque row aliases)', '', '| Row | True label | P(Remove) | Log loss | Audio descriptors | Main log-odds terms |','|---|---:|---:|---:|---:|---|']
        for row in diag['errors'][:5]:
            terms=', '.join(f"{t['feature']} {t['contribution']:+.2f}" for t in row['largest_terms'])
            lines.append(f"| {row['row_alias']} | {row['label']} | {fmt(row['probability'])} | {fmt(row['log_loss'])} | {row['audio_descriptors_at_label']} | {terms} |")
        lines += ['', 'Mean absolute contribution summed by feature family on the current unlabeled library:',
                  '', '| Family | Log-odds contribution magnitude |', '|---|---:|']
        for name,value in diag['library_mean_abs_contributions_by_family'].items():
            lines.append(f'| {name} | {fmt(value)} |')
        lines += ['', 'These magnitudes describe this fitted ranking. Family sizes and correlated predictors prevent treating them as independent importance scores. The age-only baseline and the full-model age correlation answer different questions: age can be predictive even when the full ranking is not monotonic in age. Learned audio/similarity associations do not establish useful personalization without a held-out gain.']
        removed = next((w for w in diag['feature_weights'] if w['feature']=='removed_centroid_distance'),None)
        if removed and removed['enabled'] and removed['weight']>0:
            lines += ['', f"The removal-centroid distance coefficient is positive ({fmt(removed['weight'])}): holding other transformed inputs fixed, greater distance increases removal probability. This counterintuitive association merits a preregistered training-only comparison of no centroids versus cross-fitted centroid construction. Leave-one-out class centroids can induce label-dependent finite-sample shifts; the coefficient sign alone neither diagnoses that mechanism nor proves leakage. No replacement is selected from the already-inspected monitoring errors."]
    lines += ['', '## Audio ablation', '',
        'The retrospective derivative replaces only audio descriptors using the pinned accepted current audio vectors. It never refreshes saved age, metadata, listening windows or label splits. This tests current audio availability for already selected labels; it is not a prospective prediction at the original decision time. Original and derivative hashes and audio-source provenance are preserved.',
        '', 'Primary retrospective-audio CV table (identical folds and evaluation IDs):', '',benchmark_table(report['audio_augmented']['protocols']['train_repeated_stratified_cv']),
        '', 'Secondary diagnostics below score the same already-fitted folds on either all evaluation tracks or the fixed currently audio-covered subset. Values use per-track averaged OOF probabilities, so do not compare them directly to the fold-macro primary table.',
        '', '| Snapshot | Evaluation | Cohort | n | Remove | E2 loss | E3 loss | C1 loss |', '|---|---|---|---:|---:|---:|---:|---:|']
    for row in report['audio_comparison']:
        m=row['models'];lines.append(f"| {row['dataset']} | {row['protocol']} | {row['cohort']} | {m['E2']['n']} | {m['E2'].get('remove',0)} | {fmt(m['E2'].get('log_loss'))} | {fmt(m['E3'].get('log_loss'))} | {fmt(m['C1'].get('log_loss'))} |")
    lines += ['', 'Paired audio-refresh contrasts below compare each same model and evaluation fold before/after replacing audio. Negative means lower loss with retrospective audio; these intervals also condition on the fitted folds.',
              '', '| Evaluation | Model | Refreshed − original loss | Conditional 95% interval |', '|---|---|---:|---|']
    for protocol,models in report.get('paired_audio_refresh',{}).items():
        for name,r in models.items():
            lines.append(f"| {protocol} | {name} | {fmt(r['delta'])} | [{fmt(r['low'])}, {fmt(r['high'])}] |")
    lines += ['', 'Missingness indicators are masked in C1; however median substitution, descriptor support thresholds, and provider coverage can still interact with selection. Audio effects need a prospective frozen evaluation sample after more representative labeling. No feature conclusion is drawn by comparing distinct evaluation populations.',
              '', '## Calibration and learning curves', '', '![OOF reliability](plots/calibration-and-oof-scores.png)', '',
              'Reliability plots describe sparse bins; they do not justify fitting an isotonic or Platt calibrator. Train-only nested calibration can be considered after substantially more labels. Retain the prior baseline and evaluate log loss/Brier as well as ranking.',
              '', '![Learning curves](plots/learning-curves.png)', '',
              'The same first-repeat CV evaluation tracks stay unseen as each training prefix grows. A balanced seed is selected inside each training fold, then labels are added by time. This outcome-stratified seed is an oracle construction, not an attainable acquisition cost. This is retrospective sample-efficiency analysis, not a strictly chronological prospective test. E2 metadata/history and full C1 batch refit preprocessing at each prefix; SGD uses seed-only frozen preprocessing. Production C1 observe already rebuilds a batch model; SGD is an offline incremental candidate, not a production update path.',
              '', 'Incremental SGD and full SGD replay intentionally execute the same ordered one-pass updates, so predictions should match. Their comparison measures avoided update work; it does not prove better predictive adaptation. The independent E2 batch curve uses a different optimizer and preprocessing policy. Timing observations are noisy and do not constitute a performance benchmark.',
              '', 'Learning-curve metrics:', '', '| Training labels | Evaluation folds | E2 batch loss | C1 batch loss | SGD incremental loss | SGD replay loss |', '|---:|---:|---:|---:|---:|---:|']
    for r in report['original']['learning_curves']['summary']:
        lines.append(f"| {r['n_train']} | {r['evaluation_fold_count']} | "+' | '.join(fmt(r['models'].get(n,{}).get('metrics',{}).get('log_loss')) for n in ('E2_batch','C1_batch','SGD_incremental','SGD_replay'))+' |')
    if report['original']['learning_curves'].get('endpoint_contrasts'):
        lines += ['', 'Paired endpoint contrasts use the same evaluation tracks at the smallest and largest training prefix. Negative loss differences favor more labels; they do not prove monotonic improvement.',
                  '', '| Model | Labels first → last | Loss difference | Conditional 95% interval |', '|---|---|---:|---|']
        for name,r in report['original']['learning_curves']['endpoint_contrasts'].items():
            lines.append(f"| {name} | {r['first_n_train']} → {r['last_n_train']} | {fmt(r['delta'])} | [{fmt(r['low'])}, {fmt(r['high'])}] |")
    lines += ['', '## Recommendations and next evidence', '',
        '1. Keep production C1 unchanged until the fixed recipes receive new prospective evaluation. Favor the simplest supported model; no neural architecture or post-hoc calibrator is warranted by this cohort.',
        '2. Collect a new representative evaluation panel with permanent evaluation-only roles, hidden scores, frozen features/model, and a single prespecified analysis. Existing monitoring holdout must stay separate. Coordinate with the Batch2 owner; do not duplicate its live contracts or collection.',
        '3. Add representative random training labels alongside diverse and uncertain examples. Keep all historic roles through Undo and log candidate pools, seeds, source/model/data hashes, selection purpose and conditional draw probabilities. Adaptive labels never enter the sealed panel. The offline reference sampler implements these checks without changing live selection.',
        '4. Evaluate E2/E3/C1 on identical tracks after audio enrichment is frozen. Keep an explicit original-exposure benchmark. Record provider attempts and time/order in future exports to distinguish enrichment order from preference.',
        '5. Continue training-only CV and prospective learning curves. Track effective label count, minority-class count and coverage, not just total labels. Do not promote a result because its point estimate wins; require stable paired gains in probability loss and meaningful ranking utility on new data.',
        '6. C2 should remain gated. Calibration labels are preference observations, not causal policy rewards. First verify reservation/undo/attribution behavior, then log a controlled randomized behavior policy with exact action probabilities, candidate support and a prespecified utility. Offline IPS/SNIPS/DR estimates require overlap and effective-sample-size reporting; this deterministic feedback snapshot cannot supply those claims. See the source-only C2 proposal.',
        '', '## Reproduction and limitations', '',
        'The immutable output directory contains frozen inputs, original/derived feature vectors, folds, predictions, model/data/source hashes, locked dependencies, CSV metrics and figures. Run instructions are in services/ml/docs/research-execution.md. Synthetic fixtures test plumbing only; every result in this report comes from the verified private human-feedback snapshot.',
        '', 'A current effective-feedback snapshot cannot audit every past revision or prove the absence of historical training contamination. Source inspection and the pinned split ledger support current isolation; a complete event-log export would be needed for a full historical replay. Selection probabilities, user skips, evolving preferences and enrichment order limit inference. Artist-disjoint and temporal prospective evaluation remain future sensitivity checks.',
        '', 'Method references: [scikit-learn leakage guidance](https://scikit-learn.org/1.9/common_pitfalls.html), [cross-validation](https://scikit-learn.org/stable/modules/cross_validation.html), [doubly robust policy evaluation](https://arxiv.org/abs/1103.4601).']
    if not cv.get('models'):
        lines = [line for line in lines if line not in (
            '![Benchmark comparison](plots/benchmark-comparison.png)',
            '![OOF reliability](plots/calibration-and-oof-scores.png)')]
    if not report['original']['learning_curves']['summary']:
        lines = [line for line in lines if line != '![Learning curves](plots/learning-curves.png)']
        lines += ['', 'Learning curves unavailable: '+report['original']['learning_curves'].get('reason','insufficient eligible training folds')+'.']
    (output/'report.md').write_text('\n'.join(lines)+'\n')
    if diag.get('feature_weights'):
        with (output/'feature-weights.csv').open('w',newline='') as f:
            keys=['feature','family','weight','enabled','mean_abs_train_contribution','mean_abs_library_contribution']
            writer=csv.DictWriter(f,fieldnames=keys,extrasaction='ignore');writer.writeheader();writer.writerows(diag['feature_weights'])
    with (output/'benchmarks.csv').open('w',newline='') as f:
        writer=csv.writer(f);writer.writerow(['dataset','protocol','model','unique_tracks','metric','estimate','low95','high95','valid_draws'])
        for dataset in ('original','audio_augmented'):
            for protocol,p in report[dataset]['protocols'].items():
                for name,m in p.get('models',{}).items():
                    for key,value in m['metrics'].items():
                        ci=m['intervals'].get(key,{})
                        writer.writerow([dataset,protocol,name,p['unique_evaluation_tracks'],key,value,ci.get('low'),ci.get('high'),ci.get('valid_bootstrap_draws')])
