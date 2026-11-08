# C2 evaluation proposal

Status: proposed research protocol. C2 stays disabled in production. The next
deliverable is an isolated shadow and reservation simulation with a validated
logging schema. Prospective randomized collection comes only after the integration
and measurement gates below pass. This proposal contains no listener data and
does not change production ranking, reward semantics, or shared contracts.

Batch2 collection is owned by the separate cross-stack A25/B25/C20 effort. This
proposal neither changes its assignment nor creates another labeling batch.

## Two questions with separate evidence

**C1 supervised usefulness:** given a fixed predecision feature snapshot, does a
model predict an independently collected Keep/Remove judgment better than the
predeclared baseline? Use a sealed supervised panel whose labels, features, and
membership do not enter fitting, model selection, feature support, centroids, or
C2 rewards. Report proper scoring losses and ranking quality with actual sample
and class counts. A change in these metrics is evidence about prediction.

**C2 policy utility:** does choosing a different next review improve useful
completed reviews after accounting for time, burden, errors, and Undo? This needs
prospective randomized selection and outcomes attributable to those assignments.
Keep/Remove alone is a preference label, not utility. Calibration labels must
never become C2 rewards or receive fabricated policy associations.

Keep the sealed panel outside the policy candidate pool and C2 context fitting.
Freeze panel access rules and open it at the predeclared endpoint. If results
inform subsequent changes, retire it to monitoring and collect a new prospective
panel. Do not compare policies by repeatedly tuning against panel loss.

## Why current records are insufficient for policy claims

`apps/api/src/calibration/selection.ts` performs deterministic metadata-diverse
selection; `apps/api/src/reviews/queue.ts` uses deterministic C1 ordering when
available. Their null propensities are appropriate. Historical labels cannot be
replayed as if an arbitrary alternative policy selected them.

Off-policy evaluation needs the relationship between the behavior policy's
action probabilities and the target policy. Doubly robust estimation combines a
reward prediction with an importance-weighted residual; its robustness depends on
the specified statistical conditions and does not create support for actions
never taken. [Dudík, Langford, and Li, 2011](https://arxiv.org/abs/1103.4601).

Adaptive targets need a history-aware evaluation method. Dudík and colleagues
combine nonstationary policy evaluation, importance weighting, and doubly robust
estimation; their approach is not permission to shuffle a changing learner's
logged interactions into independent rows.
[Dudík, Erhan, Langford, and Li, 2012](https://proceedings.mlr.press/r10/dudik12a.html).

For this application, choosing a track can change library membership, later
eligible sets, fatigue, and model state. Therefore ordinary one-step IPS/DR on
logged histories estimates only a specified immediate-action value under that
logged state distribution. It does not identify the full trajectory value of
deploying a different learner. This is a limitation of the proposed application,
not a claim that the cited papers establish a guarantee for this product.

## Stage 1 isolated shadow and reservation simulation

Build a private local runner around the pure selector in
`src/sortfm_ml/bandit.py`. Use synthetic environments and frozen snapshots in a
separate directory. Do not call the live `/policy/select`: it creates a durable
reservation even when its selected item is never displayed. A pure shadow output
is a hypothetical selection, not a live exposure or observed counterfactual
reward.

Exercise the existing service-local reservation code only in an isolated store
with an injected clock. The acceptance scenarios are:

1. Exact replay after restart, request retries, and candidate input reordering;
   duplicate requests never consume another random draw or make another lease.
2. Eligibility from owned current membership, pending cleanup and Undo exclusions,
   live leases, completed reviews, session skips, and unavailable tracks. Preserve
   each filter's actual selection-time result, including relaxation reasons.
3. Expiry/release, lost release, delayed settlement, and Undo before/after expiry.
   Old closures and stale Undo cannot cancel a newer exposure or newer feedback.
4. Feedback arriving out of order, duplicated, or after a newer fit. Use one
   authoritative transport and revision ledger; do not send independent `fit`
   and `observe` writes for the same revision.
5. C1 refits change context coordinates: pin the representation within an
   evaluation block or rebuild policy sufficient statistics from immutable raw
   contexts. Never combine vectors transformed by different fitted pipelines.
6. Enumerate probabilities on small candidate sets and compare with empirical
   repeated fresh draws. Verify normalization, ties, singleton sets, constraint
   relaxation, cold start, and budget exhaustion without assigning fake
   propensities to deterministic fallbacks.

Outputs are state-machine failures, replay checks, selection distributions,
latency, and explicitly synthetic utility. Shadow agreement with a baseline,
uncertainty, surprise, or simulated rewards is not a human-policy benefit metric.

## Stage 2 prospective randomized logging design

Start with **one ready-to-display selection per opportunity**, after the user
enters review and the server finishes eligibility checks. Keep reservation,
served, viewed, playback, decision, settlement, and rating events distinct.
Prefetches are not extra randomized review opportunities. If selection fails after
assignment, retain the assignment and failure outcome rather than silently
redrawing until a preferred result appears.

For the first pilot, freeze the C1 representation and two target selectors within
each session block: the current baseline and one candidate C2 policy. Use the same
eligible set and safety constraints for both if the objective is to isolate the
selection method. If constraints differ, define the comparison as the entire
policy package and restrict each target to its logged supported actions.

A concrete candidate behavior policy is the following mixture on the final
eligible set `A_t`, conditional on predecision history `H_t`:

```text
q_t(a | H_t, A_t) = 0.45 π_baseline(a | H_t, A_t)
                 + 0.45 π_candidate(a | H_t, A_t)
                 + 0.10 / |A_t|
```

The weights are proposed design parameters, not a current implementation or a
validated optimum. Freeze them before collection. Both targets remain evaluable
with bounded importance weights: their ratio to this mixture is at most `1/0.45`.
That guarantee applies to these two supported targets on the same logged state,
not arbitrary later policies. Uniform exploration alone over a large library
does not guarantee useful effective sample size.

Record the **marginal probability of the selected track**, summing contributions
from every mixture branch that can select it. The sampled branch's probability
is insufficient when branches select the same track. For a truly randomized tie,
include the tie distribution. Any quota or constraint applied after a draw must
be included in the actual resulting probability, or avoid such post-draw changes.

Use fresh randomization for each new opportunity, durably recorded with a replay
token and RNG/version evidence. A fixed global hash of track IDs is not a
substitute for a prospectively randomized behavior policy. An idempotent retry
must reuse its original result and propensity. If selection-time eligibility
changes before display, log cancellation and a distinct later opportunity; never
rewrite the old eligible set or propensity.

For slates, log every conditional probability after earlier selected items and
constraints. The joint slate probability is the product of those conditionals.
Item-level estimators cannot be substituted for a slate-level utility estimator
without additional assumptions. The one-item pilot avoids this ambiguity.

## Minimum private event schema

Use an append-only research ledger separate from the unchanged public contracts.
An integration-owned adapter must expose sufficient authoritative events before
live use; a model-fit snapshot alone cannot establish a C2 reward.

| Record | Required information |
|---|---|
| Opportunity | Private owner/session/block/sequence IDs; server time; predecision history digest; randomized assignment identity; experiment/config versions; eligibility query revision; intended outcome horizon. |
| Eligible set | Full reconstructable candidate membership and immutable feature references; owned-library revision; exclusion IDs/reasons; lease and pending-work state; final constraints and relaxations. A digest alone cannot reconstruct an action set. |
| Selection | Selected track and exposure; complete behavior-mixture configuration; selected track's exact conditional propensity; target-policy probabilities; tie handling; model/policy/context versions and checksums; randomization and idempotency evidence. |
| Delivery | Reservation/expiry/release, response returned, rendered/viewed confirmation when measurable, playback request/result, cancellation/failure, and timestamps. Never infer viewed from served. |
| Outcome | Cleanup command/decision and original exposure reference; authoritative settlement/revision; explicit usefulness response and response time; active-time measurement; error/recovery; label source/purpose. |
| Correction | Undo/supersession target, new revision and timestamp, reason if explicitly supplied, outcome projection version. Keep the original assignment, propensity, and predecision prediction immutable. |
| Evaluation | Frozen target-policy and reward definitions, observation cutoff, mature/pending/censored counts, dataset digest, support diagnostics, nuisance-model folds, and all planned analyses. |

Calibration-source events are rejected by the reward adapter. Cleanup feedback
earns at most one observation for its authoritative decision/exposure. A new
review after a confirmed Undo is a new opportunity, not a second reward for the
original exposure. Keep historical audit records when rebuilding current learner
state after revocation.

## Delayed outcomes and costs

Preregister an outcome horizon measured from assignment, for example 24 hours,
and a later fixed data cutoff that allows every included opportunity to mature.
Pending outcomes remain pending until their horizon; do not convert late feedback
to failure merely because the report ran early. Report event delay distributions,
unsettled workflows, rating nonresponse, and delivery loss separately.

A proposed primary operational endpoint is **confirmed useful completion within
the horizon**: a settled review, an explicit positive usefulness rating, and no
confirmed Undo by that horizon. Absence of confirmation is zero for this narrowly
defined endpoint after maturity, not a claim that the listener found it useless.
Also report completion and rating-response rates, plus sensitivity bounds for
unobserved latent usefulness. A completion proxy must never be presented as an
explicit satisfaction rating.

Evaluate a preregistered cost-adjusted score alongside the uncombined components:

```text
R_t = confirmed_useful_completion_t
    - λ_time * min(active_seconds_t / time_cap, 1)
    - λ_undo * confirmed_undo_within_horizon_t
```

The cost coefficients, time cap, positive-rating threshold, time-measurement
rules, and horizon must be chosen before launch. Report results over a small
prespecified sensitivity grid; do not select whichever costs favor C2 afterward.
Keep raw seconds, useful completions, Undo counts, failed workflows, and fatigue
responses visible because a composite can hide harm. No deletion bonus is used.

The existing `review-utility-v1` combines a completion/usefulness term with frozen
prediction error (`policy_service.py:43-55`). Its surprise component is not
realized information gain and can reward a bad classifier. Preserve it as an
explicit historical diagnostic; do not silently substitute it for this pilot's
confirmed-utility endpoint. Any future learning reward requires its own reviewed
version and integration adapter.

Record delayed Undo against the **original** randomized exposure even after its
lease closes. Correct the evaluation's horizon-specific outcome projection while
retaining the original event. Undo after the horizon is a separately reported
longer-term outcome, not a retrospective rewrite of the preregistered primary
endpoint. Neither SKIP nor lease expiry creates a Keep/Remove training label or
a C2 training reward. Their mature opportunity outcomes still enter the declared
intention-to-treat evaluation denominator.

## Off-policy evaluation safeguards

For a frozen target `π`, let `w_t = π(a_t | H_t,A_t) / q_t(a_t | H_t,A_t)` and let
`m_t(a)` be an out-of-block reward prediction. On the declared mature opportunity
population, compute:

```text
IPS  = mean(w_t * R_t)
SNIPS = sum(w_t * R_t) / sum(w_t)
DR   = mean(sum_a π(a | H_t,A_t) * m_t(a)
            + w_t * (R_t - m_t(a_t)))
ESS  = sum(w_t)^2 / sum(w_t^2)
```

The DR construction follows the direct-prediction plus weighted-residual approach
of [Dudík, Langford, and Li](https://arxiv.org/abs/1103.4601). These equations do
not, by themselves, supply valid uncertainty for a dependent single-user stream.
SNIPS has finite-sample bias; it is a stability comparison, not an automatic
replacement for IPS. ESS is a weight-concentration diagnostic, not a count of
independent sessions or listeners.

Before displaying policy-value estimates:

- Check positivity for every action to which the target assigns mass on each
  logged set. Report unsupported target mass and contexts. If support fails,
  restrict the estimand explicitly or mark that target non-identifiable.
- Verify finite probabilities in `(0,1]`, exact replay, and sum-to-one behavior
  distributions. Report minimum propensity, maximum weight, weight quantiles,
  top-weight share, ESS, mature opportunities, distinct tracks, and session blocks.
- Fit reward models using earlier blocks, then evaluate on the next held-out
  block; include an initial burn-in period. Every nuisance transform is fitted
  inside that training partition. No final-panel or evaluation-block rewards
  train that block's reward model. Cross-fitting must respect time and adaptation;
  random row folds are insufficient for the proposed prospective claim.
- Use exact logged behavior probabilities rather than learning a replacement
  propensity model. Missing or unverifiable probabilities block IPS/DR for that
  record; disclose resulting exclusions and do not claim the original full
  population remains identified.
- Report unclipped estimates as primary when support permits. If clipping or
  trimming is prespecified, show the removed mass and threshold sensitivity and
  label its changed bias/estimand. Do not search thresholds for a favorable result.
- Compare policies on the same mature logged opportunities. Outcome availability
  that depends on assignment is itself an outcome/selection problem; silently
  dropping nonresponders does not solve it.

Freeze the two target policies for the first evaluation block. If future work
evaluates a learner updating within the trajectory, preserve its chronological
reward availability and use a separately reviewed history-aware method; the
nonstationary paper is a starting point for that design, not a blanket guarantee.
[Dudík et al., 2012](https://proceedings.mlr.press/r10/dudik12a.html).

## One listener and dependent sessions

Define sessions and time blocks before examining outcomes. Report block-level
contrasts, chronological trajectories, and paired policy estimates. Repeated
tracks, related artists, shared model fits, and a single listener are not
independent replications. Do not turn hundreds of decisions or bootstrap draws
into hundreds of users.

For the one-step mixture pilot, uncertainty must retain session/time-block
dependence and adaptive history. Use design-aware randomization inference where
its sharp-null assumptions fit, or a preregistered block-based analysis with
explicit dependence assumptions. A block bootstrap is only an approximation and
needs enough informative blocks; with too few blocks, report descriptive effects
and no persuasive confidence claim. Use simulation to plan precision under
plausible autocorrelation before setting the collection budget.

A later end-to-end policy comparison needs separately randomized policy blocks
and a plan for carryover. Library depletion and accumulated learning generally
cannot be washed out by taking a short break. Preserve baseline state, account for
period/history, and qualify the estimand accordingly; simple crossover averages
do not establish a stationary long-run improvement.

## Preregistration and launch gates

The integration lead owns a signed experiment manifest before prospective
collection. It must fix target policies, mixture weights, supported population,
reward horizon and costs, primary estimand, nuisance-model recipe, blocking and
uncertainty method, minimum acceptable overlap/ESS/block counts, maximum listener
time and exposure budget, error/Undo/fatigue limits, planned analysis dates, and
the minimum practically useful improvement. Thresholds are design choices to be
justified with pilot simulation, not statistical guarantees inferred from C1's
label-count gates.

| Gate | Required result before proceeding |
|---|---|
| Shadow correctness | Deterministic replay, probability checks, eligibility/reservation transitions, delayed feedback/Undo tests, and finite bounded estimator fixtures pass in isolated storage. |
| Cross-stack transport | One authoritative feedback adapter; calibration/review purpose isolation; pending-mutation eligibility fences; no duplicate reward; successful response-loss/retry recovery. Existing snapshot-fit delivery is not sufficient alone. |
| Measurement readiness | Actual viewed/served distinction; explicit usefulness and time fields; mature outcome projection; complete probability and candidate-set logs; private storage/export checks. |
| Statistical readiness | Target support demonstrated, precision/burden simulation completed, thresholds and costs frozen, sealed C1 panel separate, and review plan recorded. |
| Prospective authorization | The concrete live experiment and its user-facing behavior are reviewed and authorized separately. This document authorizes no production activation. |

Stop collection immediately for ownership/purpose violations, an unexpected
destructive action, duplicate mutation/reward, unverifiable propensity, lost
eligibility evidence, broken Undo, or exceeded user time/burden limits. Preserve
the event log and report the failure; do not patch the analysis to hide it.

At prespecified review points, stop for the preregistered error/Undo/fatigue
boundaries or infeasible support. Stop with an **inconclusive** result when the
maximum budget is reached without the required precision or effective support.
Do not stop early for apparent benefit using ordinary fixed-horizon intervals;
any benefit-monitoring rule needs a separately specified sequential design.
Suspension or restart creates a recorded protocol revision and cannot turn an
inspected test panel into fresh evidence.

## Immediate deliverables

1. A source-only research event schema and synthetic fixtures for the mixture,
   candidate eligibility, mature rewards, and stale/late Undo attribution.
2. An isolated shadow runner that produces exact selection probabilities and
   reconstructable eligibility histories without changing live reservations.
3. A synthetic estimator check suite with known one-step values, deliberate
   support failure, weight concentration, delayed outcomes, and dependent blocks.
4. A concrete preregistration draft and integration handoff after those checks.
   Production C2 remains gated until all launch requirements are met.
