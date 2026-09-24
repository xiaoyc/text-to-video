import fs from 'node:fs'
import path from 'node:path'
import type {
  AssetRequest,
  DirectorPackage,
  GeneratedAsset,
  RunMetrics,
  TtsCue,
  VisionReviewResult,
} from '../domain/types.js'
import type { TextModel } from '../director/single-pass.js'
import type { ImageProvider } from '../providers/image.js'
import type { VisionProvider } from '../vision/provider.js'
import type { TtsProvider } from '../providers/tts.js'
import { runSinglePassDirector } from '../director/single-pass.js'
import { blockingFindings } from '../validation/director-validator.js'
import { compileAssetRequests } from '../assets/prompt-compiler.js'
import { generateOneAsset, materializeAssets } from '../assets/runtime.js'
import { reviewAndGroundAll, resolveAllMotions } from '../vision/runtime.js'
import { buildPreviewProject } from '../preview/project.js'
import { writePreview } from '../preview/html.js'
import { synthesizeTts } from '../providers/tts.js'
import { retimeDirectorPackage } from './retime.js'
import { ensureDir, writeAssetPromptFiles, writeJson } from '../runtime/workspace.js'

export interface PipelineRunOptions {
  script: string
  style: string
  aspectRatio: string
  outputDir: string
  textModel: TextModel
  imageProvider?: ImageProvider
  imagesDir?: string
  visionProvider?: VisionProvider
  suppliedReviews?: VisionReviewResult[]
  ttsProvider?: TtsProvider
  maxRepairs?: number
  maxImageRetries?: number
}

export interface PipelineRunResult {
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
  tts: TtsCue[]
  previewPath: string
  metrics: RunMetrics
}

async function reviewAll(
  pkg: DirectorPackage,
  requests: AssetRequest[],
  assets: GeneratedAsset[],
  provider: VisionProvider | undefined,
  suppliedReviews: VisionReviewResult[] | undefined,
): Promise<VisionReviewResult[]> {
  if (suppliedReviews) return suppliedReviews
  if (!provider) throw new Error('vision provider or supplied reviews are required')
  return reviewAndGroundAll({ pkg, requests, assets, provider })
}

function motionRetryAssetIds(
  pkg: DirectorPackage,
  requests: AssetRequest[],
  reviews: VisionReviewResult[],
): Array<{ assetId: string; hint: string }> {
  const motions = resolveAllMotions(pkg, reviews)
  const out: Array<{ assetId: string; hint: string }> = []
  for (const motion of motions) {
    if (motion.compatible) continue
    const shot = pkg.shots.find(item => item.shotId === motion.shotId)
    if (!shot) continue
    const candidates = requests.filter(request => request.shotId === shot.shotId)
    const preferred = candidates.find(request => request.visibleSubjectIds.includes(shot.motion.targetSubjectId)) ?? candidates[0]
    if (!preferred) continue
    out.push({
      assetId: preferred.assetId,
      hint: `The real image must clearly ground motion target "${shot.motion.targetSubjectId}", keep required subjects visible, and leave safe crop room for ${shot.motion.type}.`,
    })
  }
  return out
}

async function repairGeneratedAssets(input: {
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
  imageProvider?: ImageProvider
  visionProvider?: VisionProvider
  outputDir: string
  maxRetries: number
  suppliedReviews?: VisionReviewResult[]
}): Promise<{ assets: GeneratedAsset[]; reviews: VisionReviewResult[]; attempts: number }> {
  let assets = input.assets
  let reviews = input.reviews
  let attempts = 0

  if (input.suppliedReviews || !input.imageProvider || !input.visionProvider || input.maxRetries <= 0) {
    return { assets, reviews, attempts }
  }

  const requestById = new Map(input.requests.map(request => [request.assetId, request]))
  for (let attempt = 1; attempt <= input.maxRetries; attempt += 1) {
    const rejected = reviews.filter(review => !review.accepted)
    const retryMap = new Map<string, string[]>()
    for (const review of rejected) {
      retryMap.set(review.grounding.assetId, review.retryHints.length ? review.retryHints : review.reasons)
    }
    for (const item of motionRetryAssetIds(input.pkg, input.requests, reviews)) {
      const hints = retryMap.get(item.assetId) ?? []
      hints.push(item.hint)
      retryMap.set(item.assetId, hints)
    }
    if (!retryMap.size) break

    attempts += 1
    const replacements = new Map<string, GeneratedAsset>()
    for (const [assetId, retryHints] of retryMap) {
      const request = requestById.get(assetId)
      if (!request) continue
      const asset = await generateOneAsset({
        request,
        outputDir: input.outputDir,
        provider: input.imageProvider,
        attempt: attempt + 1,
        retryHints,
      })
      replacements.set(assetId, asset)
    }
    assets = assets.map(asset => replacements.get(asset.assetId) ?? asset)
    reviews = await reviewAndGroundAll({
      pkg: input.pkg,
      requests: input.requests,
      assets,
      provider: input.visionProvider,
    })
  }

  return { assets, reviews, attempts }
}

export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
  const started = Date.now()
  ensureDir(options.outputDir)

  const director = await runSinglePassDirector(options.textModel, {
    script: options.script,
    style: options.style,
    aspectRatio: options.aspectRatio,
  }, { maxRepairs: options.maxRepairs ?? 1 })
  const blocking = blockingFindings(director.findings)
  writeJson(path.join(options.outputDir, 'director.json'), director.package)
  writeJson(path.join(options.outputDir, 'director-findings.json'), director.findings)
  if (blocking.length) throw new Error(`Director validation failed after bounded repair: ${blocking.map(item => item.issue).join('; ')}`)

  const requests = compileAssetRequests(director.package)
  writeJson(path.join(options.outputDir, 'asset-requests.json'), requests)
  writeAssetPromptFiles(options.outputDir, requests)

  let assets = await materializeAssets({
    requests,
    outputDir: path.join(options.outputDir, 'assets'),
    ...(options.imagesDir ? { imagesDir: options.imagesDir } : {}),
    ...(options.imageProvider ? { provider: options.imageProvider } : {}),
  })
  let reviews = await reviewAll(director.package, requests, assets, options.visionProvider, options.suppliedReviews)

  const repaired = await repairGeneratedAssets({
    pkg: director.package,
    requests,
    assets,
    reviews,
    ...(options.imageProvider ? { imageProvider: options.imageProvider } : {}),
    ...(options.visionProvider ? { visionProvider: options.visionProvider } : {}),
    outputDir: path.join(options.outputDir, 'assets'),
    maxRetries: options.maxImageRetries ?? 2,
    ...(options.suppliedReviews ? { suppliedReviews: options.suppliedReviews } : {}),
  })
  assets = repaired.assets
  reviews = repaired.reviews
  writeJson(path.join(options.outputDir, 'assets.json'), assets)
  writeJson(path.join(options.outputDir, 'vision-reviews.json'), reviews)

  const rejected = reviews.filter(review => !review.accepted)
  if (rejected.length) throw new Error(`${rejected.length} image assets failed Vision Review after bounded retries`)

  let pkg = director.package
  let tts: TtsCue[] = []
  if (options.ttsProvider) {
    const ttsDir = path.join(options.outputDir, 'tts')
    fs.mkdirSync(ttsDir, { recursive: true })
    tts = await synthesizeTts(pkg.narrative.beats, options.ttsProvider, ttsDir)
    pkg = retimeDirectorPackage(pkg, tts)
    writeJson(path.join(options.outputDir, 'director-retimed.json'), pkg)
    writeJson(path.join(options.outputDir, 'tts.json'), tts)
  }

  const motions = resolveAllMotions(pkg, reviews)
  writeJson(path.join(options.outputDir, 'resolved-motions.json'), motions)
  const incompatible = motions.filter(motion => !motion.compatible)
  if (incompatible.length) throw new Error(`grounded motion incompatible for shots: ${incompatible.map(item => item.shotId).join(', ')}`)

  const previewPlan = buildPreviewProject({ pkg, assets, motions, tts })
  writeJson(path.join(options.outputDir, 'preview-plan.json'), previewPlan)
  const previewPath = writePreview(previewPlan, path.join(options.outputDir, 'preview'), true)

  const metrics: RunMetrics = {
    director: { ...director.metrics, durationMs: Date.now() - started },
    validation: {
      blockingFindings: blocking.length,
      warningFindings: director.findings.filter(item => item.severity === 'warning').length,
    },
    assets: { count: assets.length },
    vision: {
      calls: options.suppliedReviews ? 0 : assets.length * (1 + repaired.attempts),
      accepted: reviews.filter(item => item.accepted).length,
    },
    preview: { rebuiltShots: pkg.shots.map(shot => shot.shotId) },
  }
  writeJson(path.join(options.outputDir, 'metrics.json'), metrics)
  return { pkg, requests, assets, reviews, tts, previewPath, metrics }
}
