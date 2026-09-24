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
import type { TtsProvider } from '../src/providers/tts.js'
import { compileAssetRequests } from '../src/assets/prompt-compiler.js'
import { runPipeline } from '../src/pipeline/run.js'
import { createRunLock, verifyRunLock } from '../src/runtime/lock.js'
import { finalizeLockedRun } from '../src/pipeline/finalize.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

function grounded(subjectId: string, detected = true): GroundedSubject {
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
    if (!shot) throw new Error('missing shot')
    const all = [shot.subject.primary, ...shot.subject.secondary]
    const hidden = new Set(request.hiddenSubjectIds)
    const primary = grounded(shot.subject.primary.id, !hidden.has(shot.subject.primary.id))
    const secondary = all
      .filter(subject => subject.id !== shot.subject.primary.id)
      .map(subject => grounded(subject.id, !hidden.has(subject.id)))
    const grounding: AssetGrounding = {
      assetId: request.assetId,
      shotId: request.shotId,
      primary,
      secondary,
      safeCrop: {
        maxScale: 1.6,
        recommendedFocusCenter: primary.detected ? primary.center : { x: 0.5, y: 0.5 },
      },
    }
    return {
      accepted: true,
      score: 92,
      reasons: [],
      retryHints: [],
      grounding,
    }
  })
}

describe('end-to-end golden workflow', () => {
  it('runs script -> assets -> grounding -> motion -> preview, then locks and retimes without re-directing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-'))
    const images = path.join(root, 'images')
    const runDir = path.join(root, 'run')
    fs.mkdirSync(images, { recursive: true })

    const requests = compileAssetRequests(zhouDiGoldenPackage)
    for (const request of requests) {
      fs.writeFileSync(path.join(images, request.assetId + '.png'), 'fake-image-' + request.assetId)
    }
    const reviews = reviewsFor(zhouDiGoldenPackage, requests)

    let textCalls = 0
    const model: TextModel = {
      async completeJson<T>() {
        textCalls += 1
        return structuredClone(zhouDiGoldenPackage) as T
      },
    }

    const result = await runPipeline({
      script: zhouDiGoldenPackage.script,
      style: zhouDiGoldenPackage.style,
      aspectRatio: zhouDiGoldenPackage.aspectRatio,
      outputDir: runDir,
      textModel: model,
      imagesDir: images,
      suppliedReviews: reviews,
    })

    expect(textCalls).toBe(1)
    expect(result.metrics.director.llmCalls).toBe(1)
    expect(result.metrics.vision.calls).toBe(0)
    expect(result.assets).toHaveLength(requests.length)
    expect(fs.existsSync(result.previewPath)).toBe(true)
    expect(result.previewPath).toContain('preview')

    const lock = createRunLock(runDir)
    expect(lock.version).toBe(1)
    expect(verifyRunLock(runDir).directorHash).toBe(lock.directorHash)

    let ttsCalls = 0
    const tts: TtsProvider = {
      async synthesize({ beat, outputDir }) {
        ttsCalls += 1
        const audioPath = path.join(outputDir, beat.beatId + '.mp3')
        fs.writeFileSync(audioPath, 'fake-audio')
        return { audioPath, durationMs: 1500 + ttsCalls * 120 }
      },
    }

    const finalized = await finalizeLockedRun({ runDir, ttsProvider: tts, concurrency: 3 })
    expect(ttsCalls).toBe(zhouDiGoldenPackage.narrative.beats.length)
    expect(finalized.pkg.shots[0]?.startMs).toBe(0)
    expect(finalized.pkg.shots.at(-1)?.endMs).toBe(finalized.tts.at(-1)?.endMs)
    expect(fs.existsSync(finalized.previewPath)).toBe(true)

    const original = JSON.parse(fs.readFileSync(path.join(runDir, 'director.json'), 'utf8')) as DirectorPackage
    expect(original).toEqual(zhouDiGoldenPackage)
    expect(textCalls).toBe(1)
  })

  it('detects creative or asset mutation after lock', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-lock-'))
    const images = path.join(root, 'images')
    const runDir = path.join(root, 'run')
    fs.mkdirSync(images, { recursive: true })
    const requests = compileAssetRequests(zhouDiGoldenPackage)
    for (const request of requests) fs.writeFileSync(path.join(images, request.assetId + '.png'), request.assetId)

    const model: TextModel = {
      async completeJson<T>() {
        return structuredClone(zhouDiGoldenPackage) as T
      },
    }
    await runPipeline({
      script: zhouDiGoldenPackage.script,
      style: zhouDiGoldenPackage.style,
      aspectRatio: zhouDiGoldenPackage.aspectRatio,
      outputDir: runDir,
      textModel: model,
      imagesDir: images,
      suppliedReviews: reviewsFor(zhouDiGoldenPackage, requests),
    })
    createRunLock(runDir)

    const pkg = JSON.parse(fs.readFileSync(path.join(runDir, 'director.json'), 'utf8')) as DirectorPackage
    pkg.shots[0]!.intent.cameraTask = 'mutated after lock'
    fs.writeFileSync(path.join(runDir, 'director.json'), JSON.stringify(pkg, null, 2))
    expect(() => verifyRunLock(runDir)).toThrow(/director/)
  })
})
