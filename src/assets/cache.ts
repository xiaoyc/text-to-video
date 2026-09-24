import crypto from 'node:crypto'
import fs from 'node:fs'
import type { AssetRequest, GeneratedAsset } from '../domain/types.js'
import { readJson, writeJson } from '../runtime/workspace.js'

export interface AssetCacheEntry {
  requestHash: string
  imagePath: string
  provider: string
  updatedAt: string
}

export interface AssetCacheManifest {
  version: 1
  entries: Record<string, AssetCacheEntry>
}

function emptyManifest(): AssetCacheManifest {
  return { version: 1, entries: {} }
}

export function assetRequestHash(request: AssetRequest): string {
  const material = {
    assetId: request.assetId,
    shotId: request.shotId,
    role: request.role,
    primarySubjectId: request.primarySubjectId,
    prompt: request.prompt,
    negativePrompt: request.negativePrompt,
    visibleSubjectIds: request.visibleSubjectIds,
    hiddenSubjectIds: request.hiddenSubjectIds,
  }
  return crypto.createHash('sha256').update(JSON.stringify(material)).digest('hex')
}

export function readAssetCache(cacheFile: string): AssetCacheManifest {
  if (!fs.existsSync(cacheFile)) return emptyManifest()
  const parsed = readJson<AssetCacheManifest>(cacheFile)
  if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== 'object') {
    throw new Error(`unsupported or invalid asset cache manifest: ${cacheFile}`)
  }
  return parsed
}

export function findCachedAsset(cacheFile: string, request: AssetRequest): GeneratedAsset | undefined {
  const manifest = readAssetCache(cacheFile)
  const entry = manifest.entries[request.assetId]
  if (!entry) return undefined
  if (entry.requestHash !== assetRequestHash(request)) return undefined
  if (!entry.imagePath || !fs.existsSync(entry.imagePath)) return undefined
  return {
    assetId: request.assetId,
    shotId: request.shotId,
    role: request.role,
    imagePath: entry.imagePath,
    provider: entry.provider,
  }
}

export function persistAssetsToCache(
  cacheFile: string,
  requests: AssetRequest[],
  assets: GeneratedAsset[],
): void {
  const manifest = readAssetCache(cacheFile)
  const requestById = new Map(requests.map(request => [request.assetId, request]))
  for (const asset of assets) {
    const request = requestById.get(asset.assetId)
    if (!request) continue
    if (!fs.existsSync(asset.imagePath)) throw new Error(`cannot cache missing image: ${asset.imagePath}`)
    manifest.entries[asset.assetId] = {
      requestHash: assetRequestHash(request),
      imagePath: asset.imagePath,
      provider: asset.provider,
      updatedAt: new Date().toISOString(),
    }
  }
  writeJson(cacheFile, manifest)
}
