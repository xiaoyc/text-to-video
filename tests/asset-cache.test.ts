import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  AssetRequest,
  DirectorPackage,
  GeneratedAsset,
  GroundedSubject,
  VisionReviewResult,
} from '../src/domain/types.js'
import type { ImageProvider } from '../src/providers/image.js'
import type { VisionProvider } from '../src/vision/provider.js'
import { materializeAssets } from '../src/assets/runtime.js'
import { persistAssetsToCache, readAssetCache } from '../src/assets/cache.js'
import { compileAssetRequests } from '../src/assets/prompt-compiler.js'
import { rerunAsset } from '../src/pipeline/rerun.js'
import { resolveAllMotions } from '../src/vision/runtime.js'
import { readJson, writeJson } from '../src/runtime/workspace.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

function simpleRequest(prompt = 'first prompt'): AssetRequest {
  return {
    assetId: 'asset-0001',
    shotId: 'shot-001',
    role: 'primary',
    primarySubjectId: 'subject-1',
    prompt,
    negativePrompt: 'watermark',
    visibleSubjectIds: ['subject-1'],
    hiddenSubjectIds: [],
  }
}

function grounded(subjectId: string): GroundedSubject {
  return {
    subjectId,
    detected: true,
    bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
    center: { x: 0.35, y: 0.35 },
    confidence: 0.95,
  }
}

function acceptedReview(pkg: DirectorPackage, request: AssetRequest): VisionReviewResult {
  const shot = pkg.shots.find(item => item.shotId === request.shotId)
  if (!shot) throw new Error('missing shot')
  return {
    accepted: true,
    score: 94,
    reasons: [],
    retryHints: [],
    grounding: {
      assetId: request.assetId,
      shotId: request.shotId,
      primary: grounded(shot.motion.targetSubjectId),
      secondary: [],
      safeCrop: {
        maxScale: 1.5,
        recommendedFocusCenter: { x: 0.35, y: 0.35 },
      },
    },
  }
}

describe('asset generation cache', () => {
  it('reuses an accepted image for the exact same asset request and regenerates when the prompt changes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-cache-'))
    const outputDir = path.join(root, 'assets')
    const cacheFile = path.join(root, 'asset-cache.json')
    let calls = 0
    const provider: ImageProvider = {
      async generate({ request, outputDir: dir }) {
        calls += 1
        fs.mkdirSync(dir, { recursive: true })
        const imagePath = path.join(dir, `${request.assetId}-generation-${calls}.png`)
        fs.writeFileSync(imagePath, `image-${calls}`)
        return { imagePath, provider: 'fake' }
      },
    }

    const first = simpleRequest()
    const generated = await materializeAssets({
      requests: [first],
      outputDir,
      provider,
      cacheFile,
    })
    expect(calls).toBe(1)

    // A candidate is not reusable until the surrounding pipeline has accepted it.
    expect(fs.existsSync(cacheFile)).toBe(false)
    persistAssetsToCache(cacheFile, [first], generated)

    const reused = await materializeAssets({
      requests: [first],
      outputDir,
      cacheFile,
    })
    expect(calls).toBe(1)
    expect(reused[0]?.imagePath).toBe(generated[0]?.imagePath)

    const changed = simpleRequest('changed prompt')
    await materializeAssets({
      requests: [changed],
      outputDir,
      provider,
      cacheFile,
    })
    expect(calls).toBe(2)
  })

  it('reruns one asset, updates downstream state and makes the replacement the future cache hit', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-rerun-asset-'))
    const runDir = path.join(root, 'run')
    fs.mkdirSync(path.join(runDir, 'assets'), { recursive: true })

    const pkg = structuredClone(zhouDiGoldenPackage)
    pkg.shots = [pkg.shots[0]!]
    const requests = compileAssetRequests(pkg)
    const assets: GeneratedAsset[] = requests.map(request => {
      const imagePath = path.join(runDir, 'assets', request.assetId + '-old.png')
      fs.writeFileSync(imagePath, 'old-' + request.assetId)
      return {
        assetId: request.assetId,
        shotId: request.shotId,
        role: request.role,
        imagePath,
        provider: 'old',
      }
    })
    const reviews = requests.map(request => acceptedReview(pkg, request))

    writeJson(path.join(runDir, 'director.json'), pkg)
    writeJson(path.join(runDir, 'asset-requests.json'), requests)
    writeJson(path.join(runDir, 'assets.json'), assets)
    writeJson(path.join(runDir, 'vision-reviews.json'), reviews)
    writeJson(path.join(runDir, 'resolved-motions.json'), resolveAllMotions(pkg, reviews))

    let imageCalls = 0
    const imageProvider: ImageProvider = {
      async generate({ request, outputDir }) {
        imageCalls += 1
        fs.mkdirSync(outputDir, { recursive: true })
        const imagePath = path.join(outputDir, request.assetId + '-replacement.png')
        fs.writeFileSync(imagePath, 'replacement')
        return { imagePath, provider: 'replacement-provider' }
      },
    }
    const visionProvider: VisionProvider = {
      async reviewAndGround({ request }) {
        return acceptedReview(pkg, request)
      },
    }

    const target = requests[0]!
    const oldPath = assets.find(asset => asset.assetId === target.assetId)!.imagePath
    const previewPath = await rerunAsset({
      runDir,
      assetId: target.assetId,
      imageProvider,
      visionProvider,
      retryHint: 'regenerate this one',
    })

    expect(imageCalls).toBe(1)
    expect(fs.existsSync(previewPath)).toBe(true)
    const nextAssets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const replacement = nextAssets.find(asset => asset.assetId === target.assetId)!
    expect(replacement.imagePath).not.toBe(oldPath)
    expect(fs.readFileSync(oldPath, 'utf8')).toBe('old-' + target.assetId)
    expect(fs.readFileSync(replacement.imagePath, 'utf8')).toBe('replacement')

    const cache = readAssetCache(path.join(runDir, 'asset-cache.json'))
    expect(cache.entries[target.assetId]?.imagePath).toBe(replacement.imagePath)

    const cached = await materializeAssets({
      requests: [target],
      outputDir: path.join(runDir, 'assets'),
      cacheFile: path.join(runDir, 'asset-cache.json'),
    })
    expect(cached[0]?.imagePath).toBe(replacement.imagePath)

    const plan = readJson<{ assets: GeneratedAsset[] }>(path.join(runDir, 'preview-plan.json'))
    expect(plan.assets.find(asset => asset.assetId === target.assetId)?.imagePath).toBe(replacement.imagePath)
  })
})
