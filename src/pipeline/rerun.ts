import fs from 'node:fs'
import path from 'node:path'
import type {
  AssetRequest,
  DirectorPackage,
  GeneratedAsset,
  TtsCue,
  VisionReviewResult,
} from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import type { VisionProvider } from '../vision/provider.js'
import { generateOneAsset } from '../assets/runtime.js'
import { persistAssetsToCache } from '../assets/cache.js'
import { reviewAndGroundAll, resolveAllMotions } from '../vision/runtime.js'
import { buildPreviewProject } from '../preview/project.js'
import { writePreview } from '../preview/html.js'
import { readJson, writeJson } from '../runtime/workspace.js'

interface RunState {
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
}

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

function commitDerivedState(input: {
  runDir: string
  pkg: DirectorPackage
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
}): string {
  const motions = resolveAllMotions(input.pkg, input.reviews)
  const incompatible = motions.filter(motion => !motion.compatible)
  if (incompatible.length) {
    throw new Error(`regenerated assets leave incompatible grounded motion for shots: ${incompatible.map(item => item.shotId).join(', ')}`)
  }

  writeJson(path.join(input.runDir, 'assets.json'), input.assets)
  writeJson(path.join(input.runDir, 'vision-reviews.json'), input.reviews)
  writeJson(path.join(input.runDir, 'resolved-motions.json'), motions)

  const tts = fs.existsSync(path.join(input.runDir, 'tts.json'))
    ? readJson<TtsCue[]>(path.join(input.runDir, 'tts.json'))
    : []
  const plan = buildPreviewProject({ pkg: input.pkg, assets: input.assets, motions, tts })
  writeJson(path.join(input.runDir, 'preview-plan.json'), plan)
  return writePreview(plan, path.join(input.runDir, 'preview'), true)
}

export async function rerunAsset(input: {
  runDir: string
  assetId: string
  imageProvider: ImageProvider
  visionProvider: VisionProvider
  retryHint?: string
}): Promise<string> {
  const state = readRunState(input.runDir)
  const request = state.requests.find(item => item.assetId === input.assetId)
  if (!request) throw new Error(`unknown asset ${input.assetId}`)
  if (!state.assets.some(asset => asset.assetId === input.assetId)) {
    throw new Error(`asset ${input.assetId} is not part of the active workflow`)
  }

  // Generate into an isolated candidate directory so a failed explicit rerun cannot overwrite
  // the currently approved image before Vision review accepts the replacement.
  const regenerated = await generateOneAsset({
    request,
    outputDir: regenerationDir(input.runDir, input.assetId),
    provider: input.imageProvider,
    attempt: 2,
    retryHints: [
      input.retryHint?.trim() || 'User explicitly requested a new image candidate for this asset; preserve the declared shot subject and framing intent.',
    ],
  })

  const replacementReviews = await reviewAndGroundAll({
    pkg: state.pkg,
    requests: [request],
    assets: [regenerated],
    provider: input.visionProvider,
  })
  if (replacementReviews.some(review => !review.accepted)) {
    throw new Error(`rerun ${input.assetId} failed Vision Review; active workflow remains unchanged`)
  }

  const nextAssets = state.assets.map(asset => asset.assetId === input.assetId ? regenerated : asset)
  const nextReviews = [
    ...state.reviews.filter(review => review.grounding.assetId !== input.assetId),
    ...replacementReviews,
  ]
  const previewPath = commitDerivedState({
    runDir: input.runDir,
    pkg: state.pkg,
    assets: nextAssets,
    reviews: nextReviews,
  })

  // The explicit replacement becomes the cached candidate for this exact prompt only after the
  // downstream grounding/motion contract succeeds.
  persistAssetsToCache(
    path.join(input.runDir, 'asset-cache.json'),
    [request],
    [regenerated],
  )
  return previewPath
}

export async function rerunShot(input: {
  runDir: string
  shotId: string
  imageProvider: ImageProvider
  visionProvider: VisionProvider
}): Promise<string> {
  const state = readRunState(input.runDir)
  const shot = state.pkg.shots.find(item => item.shotId === input.shotId)
  if (!shot) throw new Error(`unknown shot ${input.shotId}`)
  const targetRequests = state.requests.filter(request => request.shotId === input.shotId)
  if (!targetRequests.length) throw new Error(`no asset requests for ${input.shotId}`)
  const activeIds = new Set(state.assets.map(asset => asset.assetId))
  const missing = targetRequests.filter(request => !activeIds.has(request.assetId))
  if (missing.length) throw new Error(`shot ${input.shotId} has inactive assets: ${missing.map(item => item.assetId).join(', ')}`)

  const candidateDir = regenerationDir(input.runDir, input.shotId)
  const regenerated: GeneratedAsset[] = []
  for (const request of targetRequests) {
    regenerated.push(await generateOneAsset({
      request,
      outputDir: candidateDir,
      provider: input.imageProvider,
      attempt: 2,
      retryHints: ['Local shot rerun requested; preserve the declared shot subject and framing intent.'],
    }))
  }

  const shotReviews = await reviewAndGroundAll({
    pkg: state.pkg,
    requests: targetRequests,
    assets: regenerated,
    provider: input.visionProvider,
  })
  if (shotReviews.some(review => !review.accepted)) {
    throw new Error(`rerun ${input.shotId} failed Vision Review; active workflow remains unchanged`)
  }

  const replacementById = new Map(regenerated.map(asset => [asset.assetId, asset]))
  const targetIds = new Set(targetRequests.map(request => request.assetId))
  const nextAssets = state.assets.map(asset => replacementById.get(asset.assetId) ?? asset)
  const nextReviews = [
    ...state.reviews.filter(review => !targetIds.has(review.grounding.assetId)),
    ...shotReviews,
  ]
  const previewPath = commitDerivedState({
    runDir: input.runDir,
    pkg: state.pkg,
    assets: nextAssets,
    reviews: nextReviews,
  })

  persistAssetsToCache(
    path.join(input.runDir, 'asset-cache.json'),
    targetRequests,
    regenerated,
  )
  return previewPath
}
