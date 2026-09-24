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
