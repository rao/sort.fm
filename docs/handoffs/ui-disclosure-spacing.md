# Disclosure motion and workspace spacing

Presentation-only follow-up to ec1bb2e. Apply after the previous UI interaction polish; no additional demo dependency is needed.

- Restore a 16px navigation-to-panel gap for Sort completion/empty states and Library Overview/Sync after removal of the old strip.
- Remove the Model guide summary's spare minimum height while collapsed.
- Apply shared native disclosure size/fade transitions in both app entries. Open and close animate; keyboard behavior and initial open state remain native. Floating player options fade/slide without clipping. Reduced motion disables these transitions; older browsers retain functional native controls.
- Repeat the displayed constellation's actual source inside the expanded modal, with an accessible description. Synthetic and live source labels have separate regression cases.

Validation: 1,187 root tests pass, 253 skip, zero fail (7,471 assertions); typecheck, web lint, production/API build, draft build, diff check and foundation HTTP smoke pass. Existing dependency annotation and bundle-size warnings remain. Independent review found no actionable regressions.

Browser checks: actual demo Library Overview and Sync gaps measure 16px; collapsed Model guide has balanced 13px insets and no spare summary minimum height. Native open and close were observed at intermediate heights, including keyboard activation. Floating player popup remains unclipped and closes with Space. Isolated, visibly labeled local fixtures exercise real App completion with one demo song and BrowserPlaybackView without API/SDK calls. Completion spacing and Library spacing also checked in a 390px iframe with no horizontal overflow. Temporary fixtures were removed after verification.

Proof images in /Users/ramin/.codex/visualizations/2026/11/08/01a1b8f3-6a81-78a0-b68a-7bac6647d14c/: library-spacing.png (normal demo) and completion-spacing.png (labeled one-song UI fixture).

No App/store/model/API changes, retraining, account writes, publication or deployment. Integration owner handles deployment.
