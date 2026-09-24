import type {
  AssetRequest,
  DirectorPackage,
  GeneratedAsset,
  ResolvedMotion,
  VisionReviewResult,
} from '../domain/types.js'
import type { VisionProvider } from './provider.js'
import { resolveMotionFromGrounding } from '../motion/resolver.js'
import { mapLimit } from '../runtime/concurrency.js'

export async function reviewAndGroundAll(input: {
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  provider: VisionProvider
  concurrency?: number
}): Promise<VisionReviewResult[]> {
  const requestById = new Map(input.requests.map(request => [request.assetId, request]))
  const shotById = new Map(input.pkg.shots.map(shot => [shot.shotId, shot]))

  return mapLimit(input.assets, input.concurrency ?? 4, async asset => {
    const request = requestById.get(asset.assetId)
    const shot = shotById.get(asset.shotId)
    if (!request || !shot) throw new Error(`orphan asset ${asset.assetId}`)
    const result = await input.provider.reviewAndGround({
      imagePath: asset.imagePath,
      request,
      shot,
      bible: input.pkg.bible,
    })
    if (result.grounding.assetId !== asset.assetId || result.grounding.shotId !== asset.shotId) {
      throw new Error(`vision grounding identity mismatch for ${asset.assetId}`)
    }
    return result
  })
}

export function resolveAllMotions(pkg: DirectorPackage, reviews: VisionReviewResult[]): ResolvedMotion[] {
  return pkg.shots.map(shot => {
    const candidates = reviews
      .filter(review => review.accepted && review.grounding.shotId === shot.shotId)
      .filter(review => {
        const all = [review.grounding.primary, ...review.grounding.secondary]
        return all.some(subject => subject.subjectId === shot.motion.targetSubjectId && subject.detected)
      })
      .map(review => {
        const resolved = resolveMotionFromGrounding(shot, review.grounding)
        const all = [review.grounding.primary, ...review.grounding.secondary]
        const confidence = all.find(subject => subject.subjectId === shot.motion.targetSubjectId)?.confidence ?? 0
        return { review, resolved, confidence }
      })
      .sort((a, b) => {
        if (a.resolved.compatible !== b.resolved.compatible) return a.resolved.compatible ? -1 : 1
        return b.confidence - a.confidence
      })

    const chosen = candidates[0]
    if (!chosen) {
      return {
        shotId: shot.shotId,
        targetSubjectId: shot.motion.targetSubjectId,
        compatible: false,
        keyframes: [],
        adjustments: [],
        warnings: ['no accepted asset grounds the motion target'],
      }
    }
    return chosen.resolved
  })
}
