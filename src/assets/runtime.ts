import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, GeneratedAsset } from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import { mapLimit } from '../runtime/concurrency.js'
import { findCachedAsset } from './cache.js'

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
  cacheFile?: string
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

  const cached = new Map<string, GeneratedAsset>()
  if (input.cacheFile) {
    for (const request of input.requests) {
      const hit = findCachedAsset(input.cacheFile, request)
      if (hit) cached.set(request.assetId, hit)
    }
  }

  const missing = input.requests.filter(request => !cached.has(request.assetId))
  if (!input.provider && missing.length) {
    throw new Error(`image provider or --images-dir is required; cache misses: ${missing.map(item => item.assetId).join(', ')}`)
  }

  return mapLimit(input.requests, input.concurrency ?? 4, request => {
    const hit = cached.get(request.assetId)
    if (hit) return Promise.resolve(hit)
    return generateOneAsset({ request, outputDir: input.outputDir, provider: input.provider! })
  })
}
