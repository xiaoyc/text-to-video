import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, GeneratedAsset } from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

function findManualImage(imagesDir: string, assetId: string): string | undefined {
  for (const extension of IMAGE_EXTENSIONS) {
    const exact = path.join(imagesDir, assetId + extension)
    if (fs.existsSync(exact)) return exact
  }
  const files = fs.readdirSync(imagesDir)
  return files
    .filter(name => name.startsWith(assetId + '.') || name.startsWith(assetId + '-'))
    .map(name => path.join(imagesDir, name))
    .find(file => fs.statSync(file).isFile())
}

export async function materializeAssets(input: {
  requests: AssetRequest[]
  outputDir: string
  imagesDir?: string
  provider?: ImageProvider
}): Promise<GeneratedAsset[]> {
  fs.mkdirSync(input.outputDir, { recursive: true })
  const assets: GeneratedAsset[] = []

  for (const request of input.requests) {
    if (input.imagesDir) {
      const imagePath = findManualImage(input.imagesDir, request.assetId)
      if (!imagePath) throw new Error(`manual image missing for ${request.assetId} under ${input.imagesDir}`)
      assets.push({
        assetId: request.assetId,
        shotId: request.shotId,
        role: request.role,
        imagePath: path.resolve(imagePath),
        provider: 'manual',
      })
      continue
    }
    if (!input.provider) throw new Error('image provider or --images-dir is required')
    const generated = await input.provider.generate({ request, outputDir: input.outputDir })
    if (!fs.existsSync(generated.imagePath)) throw new Error(`generated image missing: ${generated.imagePath}`)
    assets.push({
      assetId: request.assetId,
      shotId: request.shotId,
      role: request.role,
      imagePath: path.resolve(generated.imagePath),
      provider: generated.provider,
    })
  }

  return assets
}
