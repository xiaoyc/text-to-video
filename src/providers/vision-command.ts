import type { VisionProvider } from '../vision/provider.js'
import type { AssetRequest, DirectorShot, ProjectBible, VisionReviewResult } from '../domain/types.js'
import { runJsonCommand } from './command.js'

export class CommandVisionProvider implements VisionProvider {
  constructor(private readonly command: string) {}

  async reviewAndGround(input: {
    imagePath: string
    request: AssetRequest
    shot: DirectorShot
    bible: ProjectBible
  }): Promise<VisionReviewResult> {
    return runJsonCommand<VisionReviewResult>(this.command, {
      kind: 'vision-review-ground',
      ...input,
    })
  }
}
