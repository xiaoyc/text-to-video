# text-to-video

A clean narrative-to-video engine built around **single-pass AI directing** and **grounded camera motion**.

## Core pipeline

```text
Script
  -> Director LLM (normally 1 call)
  -> local validators
  -> optional unified repair (max 1 call)
  -> deterministic image-prompt compiler
  -> image generation/import
  -> one Vision pass: review + subject grounding
  -> grounded motion resolver
  -> interactive preview
  -> local shot/asset rerun
  -> lock
  -> real TTS + deterministic retime
  -> HyperFrames final render
```

The Director chooses creative intent. Exact camera execution is resolved only after the real image exists.

A shot such as “slow push-in toward the copper coins” therefore becomes:

```text
Director intent
  -> generated image
  -> Vision locates real coin bbox/center + safe crop
  -> motion resolver creates executable keyframes
  -> preview/render
```

## Architecture invariants

- Normal pre-edit: 1 text-model call.
- Blocking plan issues: at most 1 unified repair call.
- Every shot has one primary `ShotSubject`.
- Every non-static camera move names a declared target subject.
- Final image prompts are deterministic by default; there is no Prompt-Writer LLM.
- Vision review and grounding are one model call per image candidate.
- Renderer code executes the plan; it does not silently re-direct.
- A locked run cannot be mutated before final TTS/render.
- TTS retimes the locked plan; it does not regenerate shots.

See [AGENTS.md](AGENTS.md) and [the v0.1 architecture plan](docs/plans/2026-09-24-v0.1-single-pass-director-grounded-motion.md).

## Install

```bash
npm install
npm run check
```

## Dry-run precut

Generate a readable Director draft without generating images or calling Vision:

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --text-command "./my-text-provider" \
  --dry-run
```

This writes `precut-draft.md` / `precut-draft.json`, the validated Director plan, deterministic asset requests/prompts, `dry-run-state.json`, and `run-events.jsonl`. The draft describes intended shots, subjects, framing, motion, expected images, and narration text. It has not been checked against real images or Vision grounding.

### OpenAI quick image test

The native OpenAI text provider uses `gpt-6-luna` through `/v1/responses`. The image provider uses `gpt-image-2` through `/v1/images/generations`; for one prompt and one image, OpenAI recommends the Images API. Set a newly issued `OPENAI_API_KEY` in your local process environment using your normal secure method. Never put the key in the repository or command history:

```bash
npm run dev -- run \
  --script "articles/周迪夫妇-扬州城里最后三点微光-source.md" \
  --out data/zhou-di-test \
  --dry-run
npm run dev -- quick-test --run data/zhou-di-test --shots 3 --image-quality low
```

The first command makes or reuses the complete Director plan. `quick-test` then generates only the first three shots' image states, serially, and writes an image gallery at `data/zhou-di-test/quick-test/index.html`. Each invocation gets a separate iteration folder. To iterate on one shot without rerunning the Director, run:

```bash
npm run dev -- quick-test \
  --run data/zhou-di-test \
  --shot shot-001 \
  --image-quality low \
  --hint "主体更大，保留更多周围环境"
```

Each quick-test call deliberately generates fresh candidate images. These exploratory candidates are not accepted assets, do not enter `asset-cache.json`, and are not marked Vision-grounded. The regular full workflow still requires a Vision command or supplied review JSON before it can create an accepted preview. Use `--image-quality medium` or `high` only after the low-quality composition is working. JPEG is the default for faster iteration; use `--image-format png` for lossless output.

The native OpenAI image provider serializes generation calls. API RPM/RPD limits depend on the account's current usage tier; check the model's rate-limit page for the project being used. A shot can contain multiple fixed image states, so `--shots 3` may generate more than three images.

A later full run with the same script, style, aspect ratio, Director contract, and prompt compiler reuses that plan and continues at asset materialization. Image generation remains independently governed by `asset-cache.json`:

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --image-command "./my-image-provider" \
  --vision-command "./my-vision-provider"
```

Changing the script, style, aspect ratio, or plan contract invalidates the plan cache. Add `--force-director` to regenerate the plan even when its fingerprint matches. The generated-image-backed `precut-summary.md` remains separate from the pre-generation `precut-draft.md`.

### Director quality gates

The current Director keeps one creative planning call, but its contract now includes source-driven attention/hook intent, beat type, a small shot-template catalog, motion envelopes, timed visual events, and optional overlay text. Deterministic validation rejects plans before image generation when the estimated timeline has gaps/overlaps, narrative beats have no shot coverage, a shot exceeds its meaningful visual-idle budget, or the single repair pass silently drops unaffected shots/beats.

`precut-draft.md` surfaces the chosen template, motion envelope, visual events, extra text, and the longest meaningful visual-idle interval for every shot. Decorative particles or tiny continuous camera motion do not count as new information.

This is intentionally a migration of directing knowledge from `video-factory`, not a migration of its multi-planner/reviewer orchestration.

## Interactive workflow

### 1. Plan, generate/import assets, ground, preview

With command providers:

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --text-command "./my-text-provider" \
  --image-command "./my-image-provider" \
  --vision-command "./my-vision-provider"
```

Or use an already-authored Director JSON and manually generated images:

```bash
npm run dev -- run \
  --script article.md \
  --out data/my-run \
  --director-json director.json \
  --images-dir generated-images \
  --vision-json vision-reviews.json
```

The run writes:

```text
director.json
director-findings.json
asset-requests.json
prompts/*.md
asset-cache.json
asset-state.json
precut-summary.md
precut-summary.json
run-events.jsonl
assets.json
vision-reviews.json
resolved-motions.json
preview/index.html
metrics.json
```

When the run started from a reusable dry-run plan, `dry-run-state.json` and `precut-draft.md` / `precut-draft.json` are retained alongside the actual-state `precut-summary.md` / `precut-summary.json`.

### 2. Reuse accepted images; regenerate only what is needed

A normal `run` against the same output directory reuses accepted generated images when the exact asset request (prompt, negative prompt, subject/visibility contract and slot identity) is unchanged. The cache is written only after Vision review and grounded-motion validation succeed, so rejected candidates never become reusable by accident.

Regenerate one prompt/image only:

```bash
npm run dev -- rerun-asset \
  --run data/my-run \
  --asset asset-0001 \
  --image-command "./my-image-provider" \
  --vision-command "./my-vision-provider" \
  --hint "主体太小，重新生成并保持铜钱占据主要视觉注意力"
```

A successful asset rerun replaces that asset in `assets.json`, refreshes its Vision grounding, recomputes grounded motion, rewrites `preview-plan.json` / preview, and updates `asset-cache.json`. The next normal workflow run therefore uses the replacement image rather than the older cached candidate.

Regenerate every asset in one shot:

```bash
npm run dev -- rerun-shot \
  --run data/my-run \
  --shot shot-001 \
  --image-command "./my-image-provider" \
  --vision-command "./my-vision-provider"
```

Explicit reruns generate into an isolated candidate directory first. If Vision review or grounded motion fails, the currently active workflow and cache remain unchanged.

The workflow also keeps a human-readable precut view in `precut-summary.md` plus a structured `precut-summary.json`. Each shot summarizes narration purpose, visual subject, actual grounded motion, displayed assets/render mode, subtitle text, asset version/cache/Vision state, and warnings. These files refresh automatically after `run`, `rerun-asset`, `rerun-shot`, and final TTS retiming.

You can rebuild them without rerunning models or images:

```bash
npm run dev -- precut-summary --run data/my-run
```

### 3. Lock the approved creative plan

```bash
npm run dev -- lock --run data/my-run
```

The lock fingerprints Director/assets/Vision/motion. Later mutation fails closed.

### 4. Generate real TTS and retime

```bash
npm run dev -- tts \
  --run data/my-run \
  --tts-command "./my-tts-provider" \
  --concurrency 3
```

This writes a retimed Director copy and retimed grounded motions while keeping the original locked Director unchanged.

### 5. Final render

```bash
npm run dev -- render \
  --run data/my-run \
  --quality high
```

The renderer uses `hyperframes@0.8.57` through `npx`. It consumes the resolved motion plan; it does not invent camera decisions.

## Command-provider protocol

Providers receive exactly one JSON object on stdin and return exactly one JSON object on stdout.

Text provider request:

```json
{
  "kind": "text",
  "responseFormat": "json",
  "system": "...",
  "prompt": "..."
}
```

It returns a complete `DirectorPackage`.

Image provider request includes `request`, `outputDir`, `attempt`, and `retryHints`, and returns:

```json
{ "imagePath": "/absolute/path/image.png", "provider": "my-provider" }
```

Vision provider returns both acceptance and grounding in the same response:

```json
{
  "accepted": true,
  "score": 90,
  "reasons": [],
  "retryHints": [],
  "grounding": {
    "assetId": "asset-0001",
    "shotId": "shot-001",
    "primary": {
      "subjectId": "copper-coins",
      "detected": true,
      "bbox": { "x": 0.19, "y": 0.56, "width": 0.18, "height": 0.15 },
      "center": { "x": 0.28, "y": 0.635 },
      "confidence": 0.94
    },
    "secondary": [],
    "safeCrop": {
      "maxScale": 1.55,
      "recommendedFocusCenter": { "x": 0.28, "y": 0.635 }
    }
  }
}
```

All Vision coordinates are normalized to `0..1`.

## Golden tests

The repository includes a six-shot Zhou Di / Yangzhou gate fixture covering:

- object focus and grounded push-in;
- relationship composition;
- handoff asset states;
- refocus;
- delayed reveal;
- landmark / 2.5D intent;
- full run + lock + TTS retime.

Run:

```bash
npm run check
```
