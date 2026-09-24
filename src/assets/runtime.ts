import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, GeneratedAsset } from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import type { RunLogger } from '../runtime/run-log.js'
import { mapLimit } from '../runtime/concurrency.js'
import { findCachedAsset } from './cache.js'

export interface AssetMaterializationEvent {
  type: 'manual-import' | 'cache-hit' | 'cache-miss' | 'generation-start' | 'generated' | 'generation-failed'
  assetId: string
  shotId: string
  imagePath?: string
  provider?: string
  error?: string
}

const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp']

function findManualImage(imagesDir: string, assetId: string): string | undefined {
  for (const extension of IMAGE_EXTENSIONS) {
    const exact = path.join(imagesDir, assetId + extension)
    if (fs.existsSync(exact)) return exact
  }
  const files = fs.readdirSync(imagesDir)
  return files.filter(name => name.startsWith(assetId + '.') || name.startsWith(assetId + '-'))
    .map(name => path.join(imagesDir, name)).find(file => fs.statSync(file).isFile())
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
  return { assetId: input.request.assetId, shotId: input.request.shotId, role: input.request.role, imagePath: path.resolve(generated.imagePath), provider: generated.provider }
}

export async function generateCandidateWithLogging(input: {
  request: AssetRequest
  outputDir: string
  provider: ImageProvider
  logger: RunLogger
  attempt?: number
  retryHints?: string[]
  successMessage?: string
}): Promise<GeneratedAsset> {
  const attempt = input.attempt ?? 1
  input.logger.emit({
    stage: 'asset', type: 'asset.generation-start', message: 'generating image candidate',
    assetId: input.request.assetId, shotId: input.request.shotId,
    data: { attempt, retryHints: input.retryHints ?? [] },
  })

  try {
    const asset = await generateOneAsset(input)
    input.logger.emit({
      stage: 'asset', type: 'asset.candidate-generated', message: input.successMessage ?? 'image candidate generated',
      assetId: input.request.assetId, shotId: input.request.shotId,
      data: { attempt, imagePath: asset.imagePath, provider: asset.provider },
    })
    return asset
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    input.logger.emit({
      stage: 'asset', type: 'asset.generation-failed', message: 'image candidate generation failed',
      assetId: input.request.assetId, shotId: input.request.shotId,
      data: { attempt, retryHints: input.retryHints ?? [], error: message },
    })
    throw error
  }
}

export async function materializeAssets(input: {
  requests: AssetRequest[]
  outputDir: string
  imagesDir?: string
  provider?: ImageProvider
  concurrency?: number
  cacheFile?: string
  onEvent?: (event: AssetMaterializationEvent) => void
}): Promise<GeneratedAsset[]> {
  fs.mkdirSync(input.outputDir, { recursive: true })

  if (input.imagesDir) {
    return input.requests.map(request => {
      const imagePath = findManualImage(input.imagesDir!, request.assetId)
      if (!imagePath) throw new Error(`manual image missing for ${request.assetId} under ${input.imagesDir}`)
      const asset = { assetId: request.assetId, shotId: request.shotId, role: request.role, imagePath: path.resolve(imagePath), provider: 'manual' }
      input.onEvent?.({ type: 'manual-import', assetId: request.assetId, shotId: request.shotId, imagePath: asset.imagePath, provider: asset.provider })
      return asset
    })
  }

  const cached = new Map<string, GeneratedAsset>()
  if (input.cacheFile) {
    for (const request of input.requests) {
      const hit = findCachedAsset(input.cacheFile, request)
      if (hit) {
        cached.set(request.assetId, hit)
        input.onEvent?.({ type: 'cache-hit', assetId: request.assetId, shotId: request.shotId, imagePath: hit.imagePath, provider: hit.provider })
      } else {
        input.onEvent?.({ type: 'cache-miss', assetId: request.assetId, shotId: request.shotId })
      }
    }
  }

  const missing = input.requests.filter(request => !cached.has(request.assetId))
  if (!input.provider && missing.length) {
    throw new Error(`image provider or --images-dir is required; cache misses: ${missing.map(item => item.assetId).join(', ')}`)
  }

  return mapLimit(input.requests, input.concurrency ?? input.provider?.maxConcurrency ?? 4, request => {
    const hit = cached.get(request.assetId)
    if (hit) return Promise.resolve(hit)
    input.onEvent?.({ type: 'generation-start', assetId: request.assetId, shotId: request.shotId })
    return generateOneAsset({ request, outputDir: input.outputDir, provider: input.provider! })
      .then(asset => {
        input.onEvent?.({ type: 'generated', assetId: request.assetId, shotId: request.shotId, imagePath: asset.imagePath, provider: asset.provider })
        return asset
      })
      .catch(error => {
        input.onEvent?.({ type: 'generation-failed', assetId: request.assetId, shotId: request.shotId, error: error instanceof Error ? error.message : String(error) })
        throw error
      })
  })
}
