import type { AssetRequest, DirectorShot, ProjectBible, VisionReviewResult } from '../domain/types.js'

export interface VisionProvider {
  reviewAndGround(input: {
    imagePath: string
    request: AssetRequest
    shot: DirectorShot
    bible: ProjectBible
  }): Promise<VisionReviewResult>
}

export function visionReviewContract(): string {
  return [
    'Review the candidate image and ground the actual shot subject in the real image.',
    'Return one JSON result containing both acceptance review and grounding; do not require a second vision call.',
    'Coordinates must be normalized to 0..1 relative to the full image.',
    'Ground the declared primary subject and any mustKeepVisible subjects.',
    'Estimate safeCrop.maxScale conservatively so later camera motion does not crop the required subject.',
    'Do not claim pixel certainty when the subject is ambiguous; lower confidence or reject instead.',
  ].join('\n')
}
