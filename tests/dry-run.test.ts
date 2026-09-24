import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AssetGrounding,
  AssetRequest,
  DirectorPackage,
  GroundedSubject,
  VisionReviewResult,
} from '../src/domain/types.js'
import type { TextModel } from '../src/director/single-pass.js'
import type { ImageProvider } from '../src/providers/image.js'
import type { VisionProvider } from '../src/vision/provider.js'
import { runDryRunPipeline, runPipeline } from '../src/pipeline/run.js'
import { readJson } from '../src/runtime/workspace.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

const defaultInput = {
  script: zhouDiGoldenPackage.script,
  style: zhouDiGoldenPackage.style,
  aspectRatio: zhouDiGoldenPackage.aspectRatio,
}

function directorModel(counter: { calls: number }): TextModel {
  return {
    async completeJson<T>() {
      counter.calls += 1
      return structuredClone(zhouDiGoldenPackage) as T
    },
  }
}

function grounded(subjectId: string, detected: boolean): GroundedSubject {
  return {
    subjectId,
    detected,
    bbox: { x: 0.2, y: 0.25, width: 0.3, height: 0.3 },
    center: { x: 0.35, y: 0.4 },
    confidence: detected ? 0.95 : 0.1,
  }
}

function reviewsFor(pkg: DirectorPackage, requests: AssetRequest[]): VisionReviewResult[] {
  const shotById = new Map(pkg.shots.map(shot => [shot.shotId, shot]))
  return requests.map(request => {
    const shot = shotById.get(request.shotId)
    if (!shot) throw new Error(`missing shot ${request.shotId}`)
    const subjects = [shot.subject.primary, ...shot.subject.secondary]
    const hidden = new Set(request.hiddenSubjectIds)
    const primary = grounded(shot.subject.primary.id, !hidden.has(shot.subject.primary.id))
    const grounding: AssetGrounding = {
      assetId: request.assetId,
      shotId: request.shotId,
      primary,
      secondary: subjects
        .filter(subject => subject.id !== shot.subject.primary.id)
        .map(subject => grounded(subject.id, !hidden.has(subject.id))),
      safeCrop: {
        maxScale: 1.6,
        recommendedFocusCenter: primary.detected ? primary.center : { x: 0.5, y: 0.5 },
      },
    }
    return { accepted: true, score: 92, reasons: [], retryHints: [], grounding }
  })
}

describe('dry-run planning and plan cache', () => {
  it('writes a readable draft and stops before image, vision, motion, and preview stages', async () => {
    const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-dry-run-')), 'run')
    const counter = { calls: 0 }
    const result = await runDryRunPipeline({
      ...defaultInput,
      outputDir: runDir,
      textModel: directorModel(counter),
    })

    expect(counter.calls).toBe(1)
    expect(result.directorCalls).toBe(1)
    expect(result.source).toBe('director')
    expect(fs.existsSync(path.join(runDir, 'dry-run-state.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'precut-draft.md'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'precut-draft.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'director.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'asset-requests.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'assets.json'))).toBe(false)
    expect(fs.existsSync(path.join(runDir, 'preview-plan.json'))).toBe(false)

    const draft = readJson<{
      overview: { shotCount: number; totalDurationMs: number; assetRequestCount: number }
      shots: Array<{ primarySubject: { label: string }; compositionSummary: string; motionIntentSummary: string; displaySummary: string; expectedAssets: unknown[]; textSummary: string; status: string }>
    }>(path.join(runDir, 'precut-draft.json'))
    expect(draft.overview.shotCount).toBe(zhouDiGoldenPackage.shots.length)
    expect(draft.overview.totalDurationMs).toBeGreaterThan(0)
    expect(draft.overview.assetRequestCount).toBe(result.requests.length)
    expect(draft.shots[0]?.primarySubject.label).toContain('铜钱')
    expect(draft.shots[0]?.compositionSummary).toContain('→')
    expect(draft.shots[0]?.motionIntentSummary).toContain('推近')
    expect(draft.shots[0]?.displaySummary).toContain('画面')
    expect(draft.shots[0]?.expectedAssets.length).toBeGreaterThan(0)
    expect(draft.shots[0]?.textSummary).toContain('字幕')
    expect(draft.shots.every(shot => shot.status === 'draft')).toBe(true)

    const markdown = fs.readFileSync(result.draftPath, 'utf8')
    expect(markdown).toContain('尚未生成真实图片')
    expect(markdown).toContain('运镜意图：')
    expect(markdown).toContain('生图 Prompt：')
    const eventTypes = fs.readFileSync(path.join(runDir, 'run-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => (JSON.parse(line) as { type: string }).type)
    expect(eventTypes).toContain('dry-run.complete')
    expect(eventTypes.some(type => /^(asset|vision|motion|preview)\./.test(type))).toBe(false)
  })

  it('reuses a matching dry-run plan and then reuses the existing image cache', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-plan-reuse-'))
    const runDir = path.join(root, 'run')
    const counter = { calls: 0 }
    await runDryRunPipeline({ ...defaultInput, outputDir: runDir, textModel: directorModel(counter) })

    let imageCalls = 0
    const imageProvider: ImageProvider = {
      async generate({ request, outputDir }) {
        imageCalls += 1
        fs.mkdirSync(outputDir, { recursive: true })
        const imagePath = path.join(outputDir, `${request.assetId}-${imageCalls}.png`)
        fs.writeFileSync(imagePath, `image-${imageCalls}`)
        return { imagePath, provider: 'dry-run-test-image' }
      },
    }
    const visionProvider: VisionProvider = {
      async reviewAndGround({ request, shot }) {
        const reviews = reviewsFor(zhouDiGoldenPackage, [request])
        return reviews[0]!
      },
    }

    const firstFullRun = await runPipeline({
      ...defaultInput,
      outputDir: runDir,
      imageProvider,
      visionProvider,
    })
    expect(counter.calls).toBe(1)
    expect(firstFullRun.metrics.director.llmCalls).toBe(0)
    expect(imageCalls).toBe(firstFullRun.requests.length)
    expect(fs.existsSync(path.join(runDir, 'precut-summary.md'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'precut-draft.md'))).toBe(true)

    const cachedReviews = reviewsFor(zhouDiGoldenPackage, firstFullRun.requests)
    const secondFullRun = await runPipeline({
      ...defaultInput,
      outputDir: runDir,
      suppliedReviews: cachedReviews,
    })
    expect(secondFullRun.metrics.director.llmCalls).toBe(0)
    expect(imageCalls).toBe(firstFullRun.requests.length)
    expect(counter.calls).toBe(1)

    const eventTypes = fs.readFileSync(path.join(runDir, 'run-events.jsonl'), 'utf8')
      .trim().split('\n').map(line => (JSON.parse(line) as { type: string }).type)
    expect(eventTypes.filter(type => type === 'plan.cache-hit')).toHaveLength(2)
    expect(eventTypes.some(type => type === 'asset.cache-hit')).toBe(true)
  })

  it('invalidates the plan cache when script, style, or aspect ratio changes', async () => {
    const variations = [
      { name: 'script', patch: { script: `${defaultInput.script}\n追加一句。` } },
      { name: 'style', patch: { style: 'watercolor historical illustration' } },
      { name: 'aspect ratio', patch: { aspectRatio: '9:16' } },
    ]
    for (const variation of variations) {
      const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-plan-invalid-')), variation.name.replaceAll(' ', '-'))
      const counter = { calls: 0 }
      const model: TextModel = {
        async completeJson<T>() {
          counter.calls += 1
          const pkg = structuredClone(zhouDiGoldenPackage)
          if (counter.calls > 1) Object.assign(pkg, variation.patch)
          return pkg as T
        },
      }
      const initial = await runDryRunPipeline({ ...defaultInput, outputDir: runDir, textModel: model })
      const oldFingerprint = readJson<{ inputFingerprint: string }>(path.join(runDir, 'dry-run-state.json')).inputFingerprint
      const updatedInput = { ...defaultInput, ...variation.patch }
      const updated = await runDryRunPipeline({ ...updatedInput, outputDir: runDir, textModel: model })
      const newFingerprint = readJson<{ inputFingerprint: string }>(path.join(runDir, 'dry-run-state.json')).inputFingerprint

      expect(counter.calls, variation.name).toBe(2)
      expect(initial.source).toBe('director')
      expect(updated.source).toBe('director')
      expect(newFingerprint).not.toBe(oldFingerprint)
    }
  })

  it('supports --force-director behavior when the fingerprint still matches', async () => {
    const runDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-force-director-')), 'run')
    const counter = { calls: 0 }
    await runDryRunPipeline({ ...defaultInput, outputDir: runDir, textModel: directorModel(counter) })

    const result = await runDryRunPipeline({
      ...defaultInput,
      outputDir: runDir,
      textModel: directorModel(counter),
      forceDirector: true,
    })
    expect(counter.calls).toBe(2)
    expect(result.source).toBe('director')
    expect(result.directorCalls).toBe(1)
  })
})
