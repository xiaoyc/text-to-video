import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorPackage, GeneratedAsset, ResolvedMotion, TtsCue, VisionReviewResult } from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import type { VisionProvider } from '../vision/provider.js'
import { generateOneAsset } from '../assets/runtime.js'
import { persistAssetsToCache } from '../assets/cache.js'
import { updateAssetStates } from '../assets/state.js'
import { reviewAndGroundAll, resolveAllMotions } from '../vision/runtime.js'
import { buildPreviewProject } from '../preview/project.js'
import { writePreview } from '../preview/html.js'
import { createRunLogger, type RunLogger } from '../runtime/run-log.js'
import { writePrecutSummary } from './precut-summary.js'
import { readJson, writeJson } from '../runtime/workspace.js'

interface RunState { pkg: DirectorPackage; requests: AssetRequest[]; assets: GeneratedAsset[]; reviews: VisionReviewResult[] }

function readRunState(runDir: string): RunState {
  return {
    pkg: readJson<DirectorPackage>(path.join(runDir, 'director.json')),
    requests: readJson<AssetRequest[]>(path.join(runDir, 'asset-requests.json')),
    assets: readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json')),
    reviews: readJson<VisionReviewResult[]>(path.join(runDir, 'vision-reviews.json')),
  }
}

function regenerationDir(runDir: string, scope: string): string {
  const dir = path.join(runDir, 'assets', '.regenerated', `${scope}-${Date.now()}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

function commitDerivedState(input: { runDir: string; pkg: DirectorPackage; assets: GeneratedAsset[]; reviews: VisionReviewResult[]; logger: RunLogger }): { previewPath: string; motions: ResolvedMotion[] } {
  const motions = resolveAllMotions(input.pkg, input.reviews)
  const incompatible = motions.filter(motion => !motion.compatible)
  for (const motion of motions) {
    input.logger.emit({
      stage: 'motion', type: motion.compatible ? 'motion.compatible' : 'motion.incompatible',
      message: `${motion.compatible ? 'compatible' : 'incompatible'} target=${motion.targetSubjectId}`,
      shotId: motion.shotId, data: { warnings: motion.warnings, adjustments: motion.adjustments },
    })
  }
  if (incompatible.length) throw new Error(`regenerated assets leave incompatible grounded motion for shots: ${incompatible.map(item => item.shotId).join(', ')}`)

  writeJson(path.join(input.runDir, 'assets.json'), input.assets)
  writeJson(path.join(input.runDir, 'vision-reviews.json'), input.reviews)
  writeJson(path.join(input.runDir, 'resolved-motions.json'), motions)
  const tts = fs.existsSync(path.join(input.runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(input.runDir, 'tts.json')) : []
  const plan = buildPreviewProject({ pkg: input.pkg, assets: input.assets, motions, tts })
  writeJson(path.join(input.runDir, 'preview-plan.json'), plan)
  const previewPath = writePreview(plan, path.join(input.runDir, 'preview'), true)
  input.logger.emit({ stage: 'preview', type: 'preview.complete', message: 'preview rebuilt after local regeneration', data: { previewPath } })
  return { previewPath, motions }
}

export async function rerunAsset(input: { runDir: string; assetId: string; imageProvider: ImageProvider; visionProvider: VisionProvider; retryHint?: string }): Promise<string> {
  const logger = createRunLogger(input.runDir)
  const state = readRunState(input.runDir)
  const request = state.requests.find(item => item.assetId === input.assetId)
  if (!request) throw new Error(`unknown asset ${input.assetId}`)
  if (!state.assets.some(asset => asset.assetId === input.assetId)) throw new Error(`asset ${input.assetId} is not part of the active workflow`)
  const reason = input.retryHint?.trim() ? `user-rerun: ${input.retryHint.trim()}` : 'user-rerun: explicit single-asset regeneration'
  logger.emit({ stage: 'asset', type: 'asset.user-rerun', message: reason, assetId: input.assetId, shotId: request.shotId })

  const regenerated = await generateOneAsset({
    request, outputDir: regenerationDir(input.runDir, input.assetId), provider: input.imageProvider, attempt: 2,
    retryHints: [input.retryHint?.trim() || 'User explicitly requested a new image candidate for this asset; preserve the declared shot subject and framing intent.'],
  })
  logger.emit({
    stage: 'asset', type: 'asset.candidate-generated', message: 'isolated replacement candidate generated',
    assetId: input.assetId, shotId: request.shotId, data: { imagePath: regenerated.imagePath, provider: regenerated.provider },
  })

  const replacementReviews = await reviewAndGroundAll({ pkg: state.pkg, requests: [request], assets: [regenerated], provider: input.visionProvider })
  const replacementReview = replacementReviews[0]
  if (replacementReview) logger.emit({
    stage: 'vision', type: replacementReview.accepted ? 'vision.accepted' : 'vision.rejected',
    message: `${replacementReview.accepted ? 'accepted' : 'rejected'} replacement score=${replacementReview.score}`,
    assetId: input.assetId, shotId: request.shotId,
    data: { reasons: replacementReview.reasons, retryHints: replacementReview.retryHints, safeCropMaxScale: replacementReview.grounding.safeCrop.maxScale },
  })
  if (replacementReviews.some(review => !review.accepted)) {
    logger.emit({ stage: 'asset', type: 'asset.rerun-rejected', message: 'replacement rejected; active workflow remains unchanged', assetId: input.assetId, shotId: request.shotId })
    throw new Error(`rerun ${input.assetId} failed Vision Review; active workflow remains unchanged`)
  }

  const nextAssets = state.assets.map(asset => asset.assetId === input.assetId ? regenerated : asset)
  const nextReviews = [...state.reviews.filter(review => review.grounding.assetId !== input.assetId), ...replacementReviews]
  const committed = commitDerivedState({ runDir: input.runDir, pkg: state.pkg, assets: nextAssets, reviews: nextReviews, logger })
  persistAssetsToCache(path.join(input.runDir, 'asset-cache.json'), [request], [regenerated])
  updateAssetStates({
    file: path.join(input.runDir, 'asset-state.json'), requests: state.requests, assets: nextAssets, reviews: nextReviews,
    motions: committed.motions, reasonByAsset: new Map([[input.assetId, reason]]),
  })
  writePrecutSummary({ runDir: input.runDir, pkg: state.pkg, requests: state.requests, assets: nextAssets, reviews: nextReviews, motions: committed.motions })
  logger.emit({ stage: 'precut', type: 'precut.summary-updated', message: 'precut summary refreshed after asset rerun', assetId: input.assetId, shotId: request.shotId })
  logger.emit({
    stage: 'asset', type: 'asset.rerun-committed', message: 'replacement became the active image and cache entry',
    assetId: input.assetId, shotId: request.shotId, data: { imagePath: regenerated.imagePath },
  })
  return committed.previewPath
}

export async function rerunShot(input: { runDir: string; shotId: string; imageProvider: ImageProvider; visionProvider: VisionProvider }): Promise<string> {
  const logger = createRunLogger(input.runDir)
  const state = readRunState(input.runDir)
  const shot = state.pkg.shots.find(item => item.shotId === input.shotId)
  if (!shot) throw new Error(`unknown shot ${input.shotId}`)
  const targetRequests = state.requests.filter(request => request.shotId === input.shotId)
  if (!targetRequests.length) throw new Error(`no asset requests for ${input.shotId}`)
  const activeIds = new Set(state.assets.map(asset => asset.assetId))
  const missing = targetRequests.filter(request => !activeIds.has(request.assetId))
  if (missing.length) throw new Error(`shot ${input.shotId} has inactive assets: ${missing.map(item => item.assetId).join(', ')}`)
  logger.emit({ stage: 'asset', type: 'shot.user-rerun', message: `regenerating ${targetRequests.length} assets for shot`, shotId: input.shotId })

  const candidateDir = regenerationDir(input.runDir, input.shotId)
  const regenerated: GeneratedAsset[] = []
  for (const request of targetRequests) {
    const asset = await generateOneAsset({
      request, outputDir: candidateDir, provider: input.imageProvider, attempt: 2,
      retryHints: ['Local shot rerun requested; preserve the declared shot subject and framing intent.'],
    })
    regenerated.push(asset)
    logger.emit({
      stage: 'asset', type: 'asset.candidate-generated', message: 'shot replacement candidate generated',
      assetId: request.assetId, shotId: request.shotId, data: { imagePath: asset.imagePath, provider: asset.provider },
    })
  }

  const shotReviews = await reviewAndGroundAll({ pkg: state.pkg, requests: targetRequests, assets: regenerated, provider: input.visionProvider })
  for (const review of shotReviews) logger.emit({
    stage: 'vision', type: review.accepted ? 'vision.accepted' : 'vision.rejected',
    message: `${review.accepted ? 'accepted' : 'rejected'} replacement score=${review.score}`,
    assetId: review.grounding.assetId, shotId: review.grounding.shotId, data: { reasons: review.reasons, retryHints: review.retryHints },
  })
  if (shotReviews.some(review => !review.accepted)) {
    logger.emit({ stage: 'asset', type: 'shot.rerun-rejected', message: 'shot replacement rejected; active workflow remains unchanged', shotId: input.shotId })
    throw new Error(`rerun ${input.shotId} failed Vision Review; active workflow remains unchanged`)
  }

  const replacementById = new Map(regenerated.map(asset => [asset.assetId, asset]))
  const targetIds = new Set(targetRequests.map(request => request.assetId))
  const nextAssets = state.assets.map(asset => replacementById.get(asset.assetId) ?? asset)
  const nextReviews = [...state.reviews.filter(review => !targetIds.has(review.grounding.assetId)), ...shotReviews]
  const committed = commitDerivedState({ runDir: input.runDir, pkg: state.pkg, assets: nextAssets, reviews: nextReviews, logger })
  persistAssetsToCache(path.join(input.runDir, 'asset-cache.json'), targetRequests, regenerated)
  updateAssetStates({
    file: path.join(input.runDir, 'asset-state.json'), requests: state.requests, assets: nextAssets, reviews: nextReviews,
    motions: committed.motions, reasonByAsset: new Map(targetRequests.map(request => [request.assetId, 'user-shot-rerun'])),
  })
  writePrecutSummary({ runDir: input.runDir, pkg: state.pkg, requests: state.requests, assets: nextAssets, reviews: nextReviews, motions: committed.motions })
  logger.emit({ stage: 'precut', type: 'precut.summary-updated', message: 'precut summary refreshed after shot rerun', shotId: input.shotId })
  logger.emit({ stage: 'asset', type: 'shot.rerun-committed', message: 'shot replacements became active and cache entries were refreshed', shotId: input.shotId })
  return committed.previewPath
}
