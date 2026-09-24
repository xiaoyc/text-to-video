# AGENTS.md

## Project direction

This repository is intentionally a clean rewrite. Do **not** copy the old `video-factory` orchestration into this project.

The primary architecture is:

```text
DIRECT -> VALIDATE -> ASSET -> GROUND -> RESOLVE -> RENDER
```

## Hard invariants

1. Normal pre-edit uses one Director text-model call.
2. A repair, when needed, is unified and bounded to one extra call.
3. Every shot has one primary `ShotSubject`.
4. Every motion names a declared target subject.
5. The Director never authors exact generated-image pixel coordinates.
6. Final image prompts are compiled deterministically by default.
7. One Vision pass per image candidate should both review and ground it.
8. Motion is resolved from the actual grounded image.
9. Local validators may reject but must not silently rewrite creative decisions.
10. Renderer code must not become a hidden director.
11. Changing motion code must not require rerunning the Director.
12. Changing prompt compilation must not require rerunning the Director.
13. Local shot/asset preview and reruns are first-class.
14. Legacy retrieval / TV library / WeMM features may only return later through explicit provider interfaces.
15. Accepted generated images are cached by exact asset request; a normal workflow rerun must reuse them instead of spending another image-generation call.
16. A user-requested or quality-triggered single-asset regeneration must replace only that asset, then refresh Vision grounding, motion, preview state, and the cache entry used by future reruns.
17. Every run/rerun must leave structured observability in `run-events.jsonl`; important cache, generation, Vision, motion and preview decisions must also be visible in the console.
18. `asset-state.json` is the active asset/version ledger. Local fixes must record why the active image changed instead of silently replacing it.
19. Debugging should identify the earliest plausible source layer (Director, prompt compiler, image candidate, Vision, motion, cache/workflow) before applying a downstream patch.
20. Every successful run/rerun must refresh `precut-summary.md` and `precut-summary.json` from actual workflow state; summaries are deterministic observability, not another LLM planning pass.
21. Dry run must stop after Director validation and deterministic prompt compilation; it must not materialize images, run Vision/grounding/motion, build preview, synthesize TTS, or render.
22. Plan cache and image cache are separate. Full runs may reuse a fingerprint-matched dry-run plan, but must continue to validate/reuse images through the image cache; `--force-director` bypasses the plan cache.
23. Bump the Director contract or asset prompt compiler version in `src/runtime/input-fingerprint.ts` whenever its respective behavior changes, so old plans cannot be reused across incompatible code.
24. The Director owns source-driven attention/hook, beat type, shot template, visual events, overlays and motion envelope in its single planning pass; do not re-introduce separate creative planner calls for these concerns.
25. Validation must fail closed on timeline gaps/overlaps, uncovered narrative beats, excessive meaningful visual idle windows, and repair passes that silently delete unaffected shots/beats.
26. Decorative motion/effects do not satisfy visual-rhythm coverage. A long image-first shot needs structural/informational progression or must be split for narrative reasons.

## Current milestone

Work toward the v0.1 golden path described in:

`docs/plans/2026-09-24-v0.1-single-pass-director-grounded-motion.md`

Before adding a new planner/reviewer/model call, first prove why the existing Director + deterministic validation cannot own that responsibility.

## Validation

Run:

```bash
npm run check
```

Keep the Zhou Di golden fixture passing when changing domain contracts, prompt compilation, grounding, or motion resolution.
