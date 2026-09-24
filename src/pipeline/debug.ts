import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorFinding, DirectorPackage, GeneratedAsset, ResolvedMotion, VisionReviewResult } from '../domain/types.js'
import { assetRequestHash, readAssetCache } from '../assets/cache.js'
import { readAssetState } from '../assets/state.js'
import { readJson, writeJson } from '../runtime/workspace.js'

export type DebugLayer = 'director' | 'prompt' | 'image' | 'vision' | 'motion' | 'cache' | 'workflow' | 'healthy'

export interface AssetDebugReport {
  assetId: string
  shotId?: string
  suspectedLayer: DebugLayer
  evidence: string[]
  recommendedSourceFix: string
  request?: AssetRequest
  asset?: GeneratedAsset
  review?: VisionReviewResult
  motion?: ResolvedMotion
  state?: ReturnType<typeof readAssetState>['entries'][string]
  cache: { present: boolean; hashMatches: boolean; imageExists: boolean; imagePath?: string }
}

function readIfExists<T>(file: string): T | undefined {
  return fs.existsSync(file) ? readJson<T>(file) : undefined
}

export function analyzeAssetDebug(runDir: string, assetId: string): AssetDebugReport {
  const requests = readIfExists<AssetRequest[]>(path.join(runDir, 'asset-requests.json')) ?? []
  const assets = readIfExists<GeneratedAsset[]>(path.join(runDir, 'assets.json')) ?? []
  const reviews = readIfExists<VisionReviewResult[]>(path.join(runDir, 'vision-reviews.json')) ?? []
  const motions = readIfExists<ResolvedMotion[]>(path.join(runDir, 'resolved-motions.json')) ?? []
  const pkg = readIfExists<DirectorPackage>(path.join(runDir, 'director.json'))
  const findings = readIfExists<DirectorFinding[]>(path.join(runDir, 'director-findings.json')) ?? []
  const stateManifest = readAssetState(path.join(runDir, 'asset-state.json'))
  const cacheManifest = readAssetCache(path.join(runDir, 'asset-cache.json'))

  const request = requests.find(item => item.assetId === assetId)
  const asset = assets.find(item => item.assetId === assetId)
  const review = reviews.find(item => item.grounding.assetId === assetId)
  const shot = pkg?.shots.find(item => item.shotId === request?.shotId)
  const motion = motions.find(item => item.shotId === request?.shotId)
  const state = stateManifest.entries[assetId]
  const cacheEntry = cacheManifest.entries[assetId]
  const cacheHashMatches = Boolean(request && cacheEntry && cacheEntry.requestHash === assetRequestHash(request))
  const cacheImageExists = Boolean(cacheEntry?.imagePath && fs.existsSync(cacheEntry.imagePath))
  const evidence: string[] = []
  let suspectedLayer: DebugLayer = 'healthy'
  let recommendedSourceFix = 'No source-level change is indicated; keep the current accepted asset.'
  const shotFindings = request ? findings.filter(item => !item.shotId || item.shotId === request.shotId) : []
  const blockingDirectorFinding = shotFindings.find(item => item.severity === 'blocking')

  if (!request) {
    suspectedLayer = 'workflow'; evidence.push('asset request is missing from asset-requests.json')
    recommendedSourceFix = 'Fix asset compilation/workflow identity before regenerating an image.'
  } else if (!shot || !pkg) {
    suspectedLayer = 'director'; evidence.push('asset request points to a shot that is absent from director.json')
    recommendedSourceFix = 'Fix the Director package/shot identity, then recompile prompts.'
  } else if (blockingDirectorFinding) {
    suspectedLayer = 'director'; evidence.push(`blocking Director finding: ${blockingDirectorFinding.issue}`)
    recommendedSourceFix = 'Fix Director intent/schema at the source instead of regenerating downstream assets.'
  } else if (request.primarySubjectId !== shot.subject.primary.id) {
    suspectedLayer = 'prompt'; evidence.push(`compiled primary subject ${request.primarySubjectId} does not match shot primary subject ${shot.subject.primary.id}`)
    recommendedSourceFix = 'Fix prompt compilation or the shot subject contract, then regenerate this asset.'
  } else if (!asset) {
    suspectedLayer = 'workflow'; evidence.push('asset is not present in assets.json')
    recommendedSourceFix = 'Materialize this asset; do not change Director intent unless the request itself is wrong.'
  } else if (!fs.existsSync(asset.imagePath)) {
    suspectedLayer = 'workflow'; evidence.push(`active image file is missing: ${asset.imagePath}`)
    recommendedSourceFix = 'Repair asset storage/path state or regenerate the missing asset.'
  } else if (!review) {
    suspectedLayer = 'vision'; evidence.push('active image has no Vision review/grounding result')
    recommendedSourceFix = 'Run Vision review/grounding for the current image before changing creative intent.'
  } else if (!review.accepted) {
    suspectedLayer = 'image'
    evidence.push(...(review.reasons.length ? review.reasons : ['Vision rejected the generated candidate']))
    if (review.retryHints.length) evidence.push(...review.retryHints.map(item => `retry hint: ${item}`))
    recommendedSourceFix = 'Regenerate only this asset using the Vision evidence; keep Director intent unless the prompt is demonstrably wrong.'
  } else {
    const grounded = [review.grounding.primary, ...review.grounding.secondary]
    const target = grounded.find(item => item.subjectId === shot.motion.targetSubjectId)
    if (!target?.detected || target.confidence < 0.5) {
      suspectedLayer = 'vision'; evidence.push(`Vision accepted the image but motion target ${shot.motion.targetSubjectId} is not reliably grounded`)
      recommendedSourceFix = 'Tighten Vision acceptance/grounding contract; an accepted image must reliably ground the declared motion target.'
    } else if (!motion) {
      suspectedLayer = 'motion'; evidence.push('Vision grounding exists but resolved motion is missing')
      recommendedSourceFix = 'Re-run the deterministic motion resolver; image regeneration is not yet justified.'
    } else if (!motion.compatible) {
      evidence.push(...motion.warnings)
      const imageConstraint = motion.warnings.some(item => /safe crop|must-keep-visible|not grounded|does not provide enough/i.test(item))
      suspectedLayer = imageConstraint ? 'image' : 'motion'
      recommendedSourceFix = imageConstraint
        ? 'Regenerate this image with more safe crop room / required subjects visible.'
        : 'Fix the motion resolver or shot motion intent before regenerating the image.'
    } else if (cacheEntry && (!cacheHashMatches || !cacheImageExists)) {
      suspectedLayer = 'cache'
      if (!cacheHashMatches) evidence.push('cache entry belongs to a different asset-request hash')
      if (!cacheImageExists) evidence.push('cache entry points to a missing image')
      recommendedSourceFix = 'Repair/refresh the cache entry; do not regenerate unless the active image is also invalid.'
    } else {
      evidence.push(`Vision accepted score=${review.score}`)
      evidence.push(`motion compatible for target ${motion.targetSubjectId}`)
      if (state) evidence.push(`active asset version=${state.version}, last change=${state.lastChangeReason}`)
      if (cacheEntry && cacheHashMatches && cacheImageExists) evidence.push('cache is valid for the exact current request')
    }
  }

  const report: AssetDebugReport = {
    assetId,
    ...(request?.shotId ? { shotId: request.shotId } : {}),
    suspectedLayer,
    evidence,
    recommendedSourceFix,
    ...(request ? { request } : {}),
    ...(asset ? { asset } : {}),
    ...(review ? { review } : {}),
    ...(motion ? { motion } : {}),
    ...(state ? { state } : {}),
    cache: {
      present: Boolean(cacheEntry),
      hashMatches: cacheHashMatches,
      imageExists: cacheImageExists,
      ...(cacheEntry?.imagePath ? { imagePath: cacheEntry.imagePath } : {}),
    },
  }
  fs.mkdirSync(path.join(runDir, 'debug'), { recursive: true })
  writeJson(path.join(runDir, 'debug', `${assetId}.json`), report)
  return report
}
