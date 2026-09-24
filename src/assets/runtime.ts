import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, GeneratedAsset } from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import { mapLimit } from '../runtime/concurrency.js'

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

export async function generateOneAsset(input: {
  request: AssetRequest
  outputDir: string
  provider: ImageProvider
  attempt?: number
  retryHints?: string[]
}): Promise<GeneratedAsset> {
  const generated = await input.provider.generate({
    request: input.request,
    outputDir: input.outputDir,
    ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
    ...(input.retryHints ? { retryHints: input.retryHints } : {}),
  })
  if (!fs.existsSync(generated.imagePath)) throw new Error(`generated image missing: ${generated.imagePath}`)
  return {
    assetId: input.request.assetId,
    shotId: input.request.shotId,
    role: input.request.role,
    imagePath: path.resolve(generated.imagePath),
    provider: generated.provider,
  }
}

export async function materializeAssets(input: {
  requests: AssetRequest[]
  outputDir: string
  imagesDir?: string
  provider?: ImageProvider
  concurrency?: number
}): Promise<GeneratedAsset[]> {
  fs.mkdirSync(input.outputDir, { recursive: true })

  if (input.imagesDir) {
    return input.requests.map(request => {
      const imagePath = findManualImage(input.imagesDir!, request.assetId)
      if (!imagePath) throw new Error(`manual image missing for ${request.assetId} under ${input.imagesDir}`)
      return {
        assetId: request.assetId,
        shotId: request.shotId,
        role: request.role,
        imagePath: path.resolve(imagePath),
        provider: 'manual',
      }
    })
  }

  if (!input.provider) throw new Error('image provider or --images-dir is required')
  return mapLimit(input.requests, input.concurrency ?? 4, request =>
    generateOneAsset({ request, outputDir: input.outputDir, provider: input.provider! }),
  )
}
