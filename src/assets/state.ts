import fs from 'node:fs'
import crypto from 'node:crypto'
import type { AssetRequest, GeneratedAsset, ResolvedMotion, VisionReviewResult } from '../domain/types.js'
import { assetRequestHash } from './cache.js'
import { readJson, writeJson } from '../runtime/workspace.js'

export interface ActiveAssetState {
  assetId: string
  shotId: string
  requestHash: string
  activeImagePath: string
  contentHash: string
  provider: string
  version: number
  lastChangedAt: string
  lastChangeReason: string
  lastObservedAt: string
  lastObservedReason: string
  review: { accepted: boolean; score: number; reasons: string[]; retryHints: string[] }
  motion: { targetSubjectId: string; compatible: boolean; warnings: string[]; adjustments: string[] } | null
}

export interface AssetStateManifest {
  version: 1
  entries: Record<string, ActiveAssetState>
}

function empty(): AssetStateManifest {
  return { version: 1, entries: {} }
}

function imageContentHash(imagePath: string): string {
  return `sha256:${crypto.createHash('sha256').update(fs.readFileSync(imagePath)).digest('hex')}`
}

export function readAssetState(file: string): AssetStateManifest {
  if (!fs.existsSync(file)) return empty()
  const value = readJson<AssetStateManifest>(file)
  if (value.version !== 1 || !value.entries || typeof value.entries !== 'object') {
    throw new Error(`unsupported or invalid asset state manifest: ${file}`)
  }
  return value
}

export function updateAssetStates(input: {
  file: string
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
  motions: ResolvedMotion[]
  reasonByAsset?: ReadonlyMap<string, string>
}): AssetStateManifest {
  const previous = readAssetState(input.file)
  const requestById = new Map(input.requests.map(request => [request.assetId, request]))
  const reviewById = new Map(input.reviews.map(review => [review.grounding.assetId, review]))
  const motionByShot = new Map(input.motions.map(motion => [motion.shotId, motion]))
  const now = new Date().toISOString()
  const entries: Record<string, ActiveAssetState> = {}

  for (const asset of input.assets) {
    const request = requestById.get(asset.assetId)
    const review = reviewById.get(asset.assetId)
    if (!request || !review) continue
    const requestHash = assetRequestHash(request)
    const contentHash = imageContentHash(asset.imagePath)
    const old = previous.entries[asset.assetId]
    const changed = !old
      || old.requestHash !== requestHash
      || old.activeImagePath !== asset.imagePath
      || old.contentHash !== contentHash
    const observedReason = input.reasonByAsset?.get(asset.assetId) ?? (changed ? 'pipeline-approved' : 'pipeline-reuse')
    const motion = motionByShot.get(asset.shotId)

    entries[asset.assetId] = {
      assetId: asset.assetId,
      shotId: asset.shotId,
      requestHash,
      activeImagePath: asset.imagePath,
      contentHash,
      provider: asset.provider,
      version: old ? old.version + (changed ? 1 : 0) : 1,
      lastChangedAt: changed ? now : old.lastChangedAt,
      lastChangeReason: changed ? observedReason : old.lastChangeReason,
      lastObservedAt: now,
      lastObservedReason: observedReason,
      review: { accepted: review.accepted, score: review.score, reasons: [...review.reasons], retryHints: [...review.retryHints] },
      motion: motion ? {
        targetSubjectId: motion.targetSubjectId,
        compatible: motion.compatible,
        warnings: [...motion.warnings],
        adjustments: [...motion.adjustments],
      } : null,
    }
  }

  const manifest: AssetStateManifest = { version: 1, entries }
  writeJson(input.file, manifest)
  return manifest
}
