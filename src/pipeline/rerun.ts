import path from 'node:path'
import type {
  AssetRequest,
  DirectorPackage,
  GeneratedAsset,
  VisionReviewResult,
} from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import type { VisionProvider } from '../vision/provider.js'
import { generateOneAsset } from '../assets/runtime.js'
import { reviewAndGroundAll, resolveAllMotions } from '../vision/runtime.js'
import { buildPreviewProject } from '../preview/project.js'
import { writePreview } from '../preview/html.js'
import { readJson, writeJson } from '../runtime/workspace.js'

export async function rerunShot(input: {
  runDir: string
  shotId: string
  imageProvider: ImageProvider
  visionProvider: VisionProvider
}): Promise<string> {
  const pkg = readJson<DirectorPackage>(path.join(input.runDir, 'director.json'))
  const requests = readJson<AssetRequest[]>(path.join(input.runDir, 'asset-requests.json'))
  const assets = readJson<GeneratedAsset[]>(path.join(input.runDir, 'assets.json'))
  const reviews = readJson<VisionReviewResult[]>(path.join(input.runDir, 'vision-reviews.json'))
  const shot = pkg.shots.find(item => item.shotId === input.shotId)
  if (!shot) throw new Error(`unknown shot ${input.shotId}`)
  const targetRequests = requests.filter(request => request.shotId === input.shotId)
  if (!targetRequests.length) throw new Error(`no asset requests for ${input.shotId}`)

  const regenerated: GeneratedAsset[] = []
  for (const request of targetRequests) {
    regenerated.push(await generateOneAsset({
      request,
      outputDir: path.join(input.runDir, 'assets'),
      provider: input.imageProvider,
      attempt: 1,
      retryHints: ['Local shot rerun requested; preserve the locked shot subject and framing intent.'],
    }))
  }

  const otherAssets = assets.filter(asset => asset.shotId !== input.shotId)
  const nextAssets = [...otherAssets, ...regenerated]
  const shotReviews = await reviewAndGroundAll({
    pkg,
    requests: targetRequests,
    assets: regenerated,
    provider: input.visionProvider,
  })
  if (shotReviews.some(review => !review.accepted)) throw new Error(`rerun ${input.shotId} still failed Vision Review`)
  const nextReviews = [...reviews.filter(review => review.grounding.shotId !== input.shotId), ...shotReviews]
  const motions = resolveAllMotions(pkg, nextReviews)
  const targetMotion = motions.find(motion => motion.shotId === input.shotId)
  if (!targetMotion?.compatible) throw new Error(`rerun ${input.shotId} still cannot resolve grounded motion`)

  writeJson(path.join(input.runDir, 'assets.json'), nextAssets)
  writeJson(path.join(input.runDir, 'vision-reviews.json'), nextReviews)
  writeJson(path.join(input.runDir, 'resolved-motions.json'), motions)
  const plan = buildPreviewProject({ pkg, assets: nextAssets, motions })
  return writePreview(plan, path.join(input.runDir, 'preview'), true)
}
