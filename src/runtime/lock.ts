import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import type { DirectorPackage, GeneratedAsset, ResolvedMotion, VisionReviewResult } from '../domain/types.js'
import { readJson, writeJson } from './workspace.js'

export interface RunLock {
  version: 1
  createdAt: string
  directorHash: string
  assetsHash: string
  reviewsHash: string
  motionsHash: string
}

function stable(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(item => stable(item)).join(',') + ']'
  if (value && typeof value === 'object') {
    return '{' + Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => JSON.stringify(key) + ':' + stable(item))
      .join(',') + '}'
  }
  return JSON.stringify(value)
}

export function hashValue(value: unknown): string {
  return crypto.createHash('sha256').update(stable(value)).digest('hex')
}

export function createRunLock(runDir: string): RunLock {
  const director = readJson<DirectorPackage>(path.join(runDir, 'director.json'))
  const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
  const reviews = readJson<VisionReviewResult[]>(path.join(runDir, 'vision-reviews.json'))
  const motions = readJson<ResolvedMotion[]>(path.join(runDir, 'resolved-motions.json'))
  if (reviews.some(review => !review.accepted)) throw new Error('cannot lock: rejected visual assets remain')
  if (motions.some(motion => !motion.compatible)) throw new Error('cannot lock: incompatible grounded motion remains')
  for (const asset of assets) {
    if (!fs.existsSync(asset.imagePath)) throw new Error(`cannot lock: image missing ${asset.imagePath}`)
  }
  const lock: RunLock = {
    version: 1,
    createdAt: new Date().toISOString(),
    directorHash: hashValue(director),
    assetsHash: hashValue(assets),
    reviewsHash: hashValue(reviews),
    motionsHash: hashValue(motions),
  }
  writeJson(path.join(runDir, 'lock.json'), lock)
  return lock
}

export function verifyRunLock(runDir: string): RunLock {
  const lock = readJson<RunLock>(path.join(runDir, 'lock.json'))
  const director = readJson<DirectorPackage>(path.join(runDir, 'director.json'))
  const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
  const reviews = readJson<VisionReviewResult[]>(path.join(runDir, 'vision-reviews.json'))
  const motions = readJson<ResolvedMotion[]>(path.join(runDir, 'resolved-motions.json'))
  const mismatches: string[] = []
  if (lock.directorHash !== hashValue(director)) mismatches.push('director')
  if (lock.assetsHash !== hashValue(assets)) mismatches.push('assets')
  if (lock.reviewsHash !== hashValue(reviews)) mismatches.push('vision-reviews')
  if (lock.motionsHash !== hashValue(motions)) mismatches.push('resolved-motions')
  if (mismatches.length) throw new Error(`run lock invalidated by changes: ${mismatches.join(', ')}`)
  return lock
}
