# text-to-video

A clean narrative-to-video engine focused on **single-pass AI directing** and **grounded camera motion**.

## Core pipeline

```text
Script
  -> Director LLM (normally 1 call)
  -> local validation
  -> optional unified repair (max 1 call)
  -> deterministic image prompt compiler
  -> image generation/import
  -> Vision review + subject grounding
  -> motion resolution from the real image
  -> preview
  -> lock
  -> TTS / retime
  -> HyperFrames / Three.js render
```

The key rule is: **the Director chooses creative intent; executable camera coordinates are resolved only after a real image exists.**

For example, the Director may say "slow push-in toward the copper coins." The generated image is then grounded to locate the actual coins, and the motion resolver computes a safe focus/zoom path from that real geometry.

## Development

```bash
npm install
npm run check
```

The first golden fixture is a six-shot Zhou Di / Yangzhou gate sequence covering:

- object focus and push-in;
- relationship composition;
- handoff asset states;
- refocus;
- delayed reveal;
- landmark / 2.5D intent.

## Architecture plan

See [docs/plans/2026-09-24-v0.1-single-pass-director-grounded-motion.md](docs/plans/2026-09-24-v0.1-single-pass-director-grounded-motion.md).
