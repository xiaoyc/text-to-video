import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorPackage, GeneratedAsset, RunMetrics, TtsCue, VisionReviewResult } from '../domain/types.js'
import type { TextModel } from '../director/single-pass.js'
import type { ImageProvider } from '../providers/image.js'
import type { VisionProvider } from '../vision/provider.js'
import type { TtsProvider } from '../providers/tts.js'
import { runSinglePassDirector } from '../director/single-pass.js'
import { blockingFindings } from '../validation/director-validator.js'
import { compileAssetRequests } from '../assets/prompt-compiler.js'
import { persistAssetsToCache } from '../assets/cache.js'
import { updateAssetStates } from '../assets/state.js'
import { generateOneAsset, materializeAssets } from '../assets/runtime.js'
import { reviewAndGroundAll, resolveAllMotions } from '../vision/runtime.js'
import { buildPreviewProject } from '../preview/project.js'
import { writePreview } from '../preview/html.js'
import { synthesizeTts } from '../providers/tts.js'
import { retimeDirectorPackage } from './retime.js'
import { writePrecutSummary } from './precut-summary.js'
import { createRunLogger, type RunLogger } from '../runtime/run-log.js'
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

function logReviews(logger: RunLogger, reviews: VisionReviewResult[], only?: ReadonlySet<string>): void {
  for (const review of reviews) {
    if (only && !only.has(review.grounding.assetId)) continue
    logger.emit({
      stage: 'vision',
      type: review.accepted ? 'vision.accepted' : 'vision.rejected',
      message: `${review.accepted ? 'accepted' : 'rejected'} score=${review.score}`,
      assetId: review.grounding.assetId,
      shotId: review.grounding.shotId,
      data: {
        score: review.score,
        reasons: review.reasons,
        retryHints: review.retryHints,
        primaryConfidence: review.grounding.primary.confidence,
        safeCropMaxScale: review.grounding.safeCrop.maxScale,
      },
    })
  }
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
  logger: RunLogger
  reasonByAsset: Map<string, string>
}): Promise<{ assets: GeneratedAsset[]; reviews: VisionReviewResult[]; attempts: number }> {
  let assets = input.assets
  let reviews = input.reviews
  let attempts = 0
  if (input.suppliedReviews || !input.imageProvider || !input.visionProvider || input.maxRetries <= 0) return { assets, reviews, attempts }

  const requestById = new Map(input.requests.map(request => [request.assetId, request]))
  for (let attempt = 1; attempt <= input.maxRetries; attempt += 1) {
    const rejected = reviews.filter(review => !review.accepted)
    const retryMap = new Map<string, string[]>()
    for (const review of rejected) retryMap.set(review.grounding.assetId, review.retryHints.length ? review.retryHints : review.reasons)
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
      input.logger.emit({
        stage: 'asset', type: 'asset.auto-retry', message: `automatic regeneration attempt ${attempt + 1}`,
        assetId, shotId: request.shotId, data: { retryHints },
      })
      input.reasonByAsset.set(assetId, `auto-retry: ${retryHints.join('; ')}`)
      const asset = await generateOneAsset({
        request, outputDir: input.outputDir, provider: input.imageProvider, attempt: attempt + 1, retryHints,
      })
      input.logger.emit({
        stage: 'asset', type: 'asset.regenerated', message: 'generated replacement candidate',
        assetId, shotId: request.shotId, data: { imagePath: asset.imagePath, provider: asset.provider },
      })
      replacements.set(assetId, asset)
    }
    assets = assets.map(asset => replacements.get(asset.assetId) ?? asset)
    reviews = await reviewAndGroundAll({ pkg: input.pkg, requests: input.requests, assets, provider: input.visionProvider })
    logReviews(input.logger, reviews, new Set(retryMap.keys()))
  }
  return { assets, reviews, attempts }
}

export async function runPipeline(options: PipelineRunOptions): Promise<PipelineRunResult> {
  const started = Date.now()
  ensureDir(options.outputDir)
  const logger = createRunLogger(options.outputDir)
  const reasonByAsset = new Map<string, string>()
  logger.emit({
    stage: 'pipeline', type: 'pipeline.start', message: 'workflow started',
    data: { style: options.style, aspectRatio: options.aspectRatio, scriptLength: options.script.length },
  })

  const director = await runSinglePassDirector(options.textModel, {
    script: options.script, style: options.style, aspectRatio: options.aspectRatio,
  }, { maxRepairs: options.maxRepairs ?? 1 })
  const blocking = blockingFindings(director.findings)
  writeJson(path.join(options.outputDir, 'director.json'), director.package)
  writeJson(path.join(options.outputDir, 'director-findings.json'), director.findings)
  logger.emit({
    stage: 'director', type: 'director.complete', message: `director produced ${director.package.shots.length} shots`,
    data: {
      llmCalls: director.metrics.llmCalls, repairCalls: director.metrics.repairCalls,
      blockingFindings: blocking.length,
      warningFindings: director.findings.filter(item => item.severity === 'warning').length,
    },
  })
  if (blocking.length) {
    logger.emit({ stage: 'director', type: 'director.blocked', message: 'blocking validation findings remain', data: { issues: blocking.map(item => item.issue) } })
    throw new Error(`Director validation failed after bounded repair: ${blocking.map(item => item.issue).join('; ')}`)
  }

  const requests = compileAssetRequests(director.package)
  writeJson(path.join(options.outputDir, 'asset-requests.json'), requests)
  writeAssetPromptFiles(options.outputDir, requests)
  logger.emit({ stage: 'prompt', type: 'prompt.compiled', message: `compiled ${requests.length} deterministic image prompts` })

  let assets = await materializeAssets({
    requests,
    outputDir: path.join(options.outputDir, 'assets'),
    ...(options.imagesDir ? { imagesDir: options.imagesDir } : {}),
    ...(options.imageProvider ? { provider: options.imageProvider } : {}),
    cacheFile: path.join(options.outputDir, 'asset-cache.json'),
    onEvent: event => {
      const reason = event.type === 'cache-hit' ? 'cache-reuse'
        : event.type === 'manual-import' ? 'manual-import'
          : event.type === 'generated' ? 'initial-generation' : undefined
      if (reason) reasonByAsset.set(event.assetId, reason)
      logger.emit({
        stage: 'asset', type: `asset.${event.type}`, message: event.type.replace(/-/g, ' '),
        assetId: event.assetId, shotId: event.shotId,
        data: {
          ...(event.imagePath ? { imagePath: event.imagePath } : {}),
          ...(event.provider ? { provider: event.provider } : {}),
          ...(event.error ? { error: event.error } : {}),
        },
      })
    },
  })

  let reviews = await reviewAll(director.package, requests, assets, options.visionProvider, options.suppliedReviews)
  logReviews(logger, reviews)

  const repaired = await repairGeneratedAssets({
    pkg: director.package, requests, assets, reviews,
    ...(options.imageProvider ? { imageProvider: options.imageProvider } : {}),
    ...(options.visionProvider ? { visionProvider: options.visionProvider } : {}),
    outputDir: path.join(options.outputDir, 'assets'),
    maxRetries: options.maxImageRetries ?? 2,
    ...(options.suppliedReviews ? { suppliedReviews: options.suppliedReviews } : {}),
    logger, reasonByAsset,
  })
  assets = repaired.assets
  reviews = repaired.reviews
  writeJson(path.join(options.outputDir, 'assets.json'), assets)
  writeJson(path.join(options.outputDir, 'vision-reviews.json'), reviews)

  const rejected = reviews.filter(review => !review.accepted)
  if (rejected.length) {
    logger.emit({ stage: 'vision', type: 'vision.blocked', message: `${rejected.length} assets remain rejected after bounded retries`, data: { assetIds: rejected.map(item => item.grounding.assetId) } })
    throw new Error(`${rejected.length} image assets failed Vision Review after bounded retries`)
  }

  let pkg = director.package
  let tts: TtsCue[] = []
  if (options.ttsProvider) {
    const ttsDir = path.join(options.outputDir, 'tts')
    fs.mkdirSync(ttsDir, { recursive: true })
    tts = await synthesizeTts(pkg.narrative.beats, options.ttsProvider, ttsDir)
    pkg = retimeDirectorPackage(pkg, tts)
    writeJson(path.join(options.outputDir, 'director-retimed.json'), pkg)
    writeJson(path.join(options.outputDir, 'tts.json'), tts)
    logger.emit({ stage: 'tts', type: 'tts.complete', message: `generated ${tts.length} TTS cues and retimed Director package` })
  }

  const motions = resolveAllMotions(pkg, reviews)
  writeJson(path.join(options.outputDir, 'resolved-motions.json'), motions)
  for (const motion of motions) {
    logger.emit({
      stage: 'motion', type: motion.compatible ? 'motion.compatible' : 'motion.incompatible',
      message: `${motion.compatible ? 'compatible' : 'incompatible'} target=${motion.targetSubjectId}`,
      shotId: motion.shotId, data: { warnings: motion.warnings, adjustments: motion.adjustments },
    })
  }
  const incompatible = motions.filter(motion => !motion.compatible)
  if (incompatible.length) throw new Error(`grounded motion incompatible for shots: ${incompatible.map(item => item.shotId).join(', ')}`)

  if (!options.imagesDir) {
    persistAssetsToCache(path.join(options.outputDir, 'asset-cache.json'), requests, assets)
    logger.emit({ stage: 'cache', type: 'cache.updated', message: `cached ${assets.length} accepted assets` })
  }

  updateAssetStates({
    file: path.join(options.outputDir, 'asset-state.json'), requests, assets, reviews, motions, reasonByAsset,
  })
  logger.emit({ stage: 'asset', type: 'asset.state-updated', message: 'updated active asset versions and review/motion metadata' })

  const previewPlan = buildPreviewProject({ pkg, assets, motions, tts })
  writeJson(path.join(options.outputDir, 'preview-plan.json'), previewPlan)
  const previewPath = writePreview(previewPlan, path.join(options.outputDir, 'preview'), true)
  logger.emit({ stage: 'preview', type: 'preview.complete', message: 'preview rebuilt', data: { previewPath } })

  const precut = writePrecutSummary({ runDir: options.outputDir, pkg, requests, assets, reviews, motions })
  logger.emit({
    stage: 'precut', type: 'precut.summary-updated', message: `precut summary updated for ${precut.overview.shotCount} shots`,
    data: { markdownPath: path.join(options.outputDir, 'precut-summary.md'), jsonPath: path.join(options.outputDir, 'precut-summary.json') },
  })

  const metrics: RunMetrics = {
    director: { ...director.metrics, durationMs: Date.now() - started },
    validation: {
      blockingFindings: blocking.length,
      warningFindings: director.findings.filter(item => item.severity === 'warning').length,
    },
    assets: { count: assets.length },
    vision: { calls: options.suppliedReviews ? 0 : assets.length * (1 + repaired.attempts), accepted: reviews.filter(item => item.accepted).length },
    preview: { rebuiltShots: pkg.shots.map(shot => shot.shotId) },
  }
  writeJson(path.join(options.outputDir, 'metrics.json'), metrics)
  logger.emit({ stage: 'pipeline', type: 'pipeline.complete', message: `workflow completed in ${Date.now() - started}ms`, data: { previewPath } })
  return { pkg, requests, assets, reviews, tts, previewPath, metrics }
}
