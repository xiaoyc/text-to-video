import type { AssetRequest } from '../domain/types.js'
import { runJsonCommand } from './command.js'

export interface ImageProvider {
  generate(input: {
    request: AssetRequest
    outputDir: string
  }): Promise<{ imagePath: string; provider: string }>
}

export class CommandImageProvider implements ImageProvider {
  constructor(private readonly command: string) {}

  async generate(input: { request: AssetRequest; outputDir: string }): Promise<{ imagePath: string; provider: string }> {
    const result = runJsonCommand<{ imagePath: string; provider?: string }>(this.command, {
      kind: 'image',
      request: input.request,
      outputDir: input.outputDir,
    })
    if (!result.imagePath) throw new Error(`image command returned no imagePath for ${input.request.assetId}`)
    return { imagePath: result.imagePath, provider: result.provider ?? 'command' }
  }
}
