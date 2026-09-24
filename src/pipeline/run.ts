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
import { materializeAssets } from '../assets/runtime.js'
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

  const assets = await materializeAssets({
    requests,
    outputDir: path.join(options.outputDir, 'assets'),
    ...(options.imagesDir ? { imagesDir: options.imagesDir } : {}),
    ...(options.imageProvider ? { provider: options.imageProvider } : {}),
  })
  writeJson(path.join(options.outputDir, 'assets.json'), assets)

  let reviews: VisionReviewResult[]
  if (options.suppliedReviews) {
    reviews = options.suppliedReviews
  } else {
    if (!options.visionProvider) throw new Error('vision provider or supplied reviews are required')
    reviews = await reviewAndGroundAll({
      pkg: director.package,
      requests,
      assets,
      provider: options.visionProvider,
    })
  }
  writeJson(path.join(options.outputDir, 'vision-reviews.json'), reviews)
  const rejected = reviews.filter(review => !review.accepted)
  if (rejected.length) throw new Error(`${rejected.length} image assets failed Vision Review`)

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
    vision: { calls: options.suppliedReviews ? 0 : assets.length, accepted: reviews.filter(item => item.accepted).length },
    preview: { rebuiltShots: pkg.shots.map(shot => shot.shotId) },
  }
  writeJson(path.join(options.outputDir, 'metrics.json'), metrics)
  return { pkg, requests, assets, reviews, tts, previewPath, metrics }
}
