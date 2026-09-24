import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssetRequest, DirectorPackage, GeneratedAsset, ResolvedMotion, VisionReviewResult } from '../src/domain/types.js'
import { updateAssetStates, readAssetState } from '../src/assets/state.js'
import { persistAssetsToCache } from '../src/assets/cache.js'
import { analyzeAssetDebug } from '../src/pipeline/debug.js'
import { createRunLogger } from '../src/runtime/run-log.js'
import { writeJson } from '../src/runtime/workspace.js'
import { compileAssetRequests } from '../src/assets/prompt-compiler.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

function fixture(): { pkg: DirectorPackage; request: AssetRequest; asset: GeneratedAsset; review: VisionReviewResult; motion: ResolvedMotion; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-debug-'))
  const pkg = structuredClone(zhouDiGoldenPackage)
  pkg.shots = [pkg.shots[0]!]
  const request = compileAssetRequests(pkg)[0]!
  const imagePath = path.join(root, 'asset-0001.png')
  fs.writeFileSync(imagePath, 'image')
  const asset: GeneratedAsset = { assetId: request.assetId, shotId: request.shotId, role: request.role, imagePath, provider: 'fake' }
  const review: VisionReviewResult = {
    accepted: true, score: 93, reasons: [], retryHints: [],
    grounding: {
      assetId: request.assetId, shotId: request.shotId,
      primary: {
        subjectId: pkg.shots[0]!.motion.targetSubjectId, detected: true,
        bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 }, center: { x: 0.35, y: 0.35 }, confidence: 0.94,
      },
      secondary: [],
      safeCrop: { maxScale: 1.5, recommendedFocusCenter: { x: 0.35, y: 0.35 } },
    },
  }
  const motion: ResolvedMotion = {
    shotId: request.shotId, targetSubjectId: pkg.shots[0]!.motion.targetSubjectId, compatible: true,
    keyframes: [
      { atMs: 0, focus: { x: 0.4, y: 0.4 }, scale: 1 },
      { atMs: pkg.shots[0]!.durationMs, focus: { x: 0.35, y: 0.35 }, scale: 1.12 },
    ],
    adjustments: [], warnings: [],
  }
  return { pkg, request, asset, review, motion, root }
}

describe('iteration observability', () => {
  it('appends structured run events with one session id', () => {
    const { root } = fixture()
    const logger = createRunLogger(root, false)
    logger.emit({ stage: 'asset', type: 'asset.cache-hit', message: 'cache hit', assetId: 'asset-0001' })
    logger.emit({ stage: 'vision', type: 'vision.accepted', message: 'accepted', assetId: 'asset-0001' })
    const lines = fs.readFileSync(path.join(root, 'run-events.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(lines).toHaveLength(2)
    expect(lines[0].sessionId).toBe(lines[1].sessionId)
    expect(lines[0].type).toBe('asset.cache-hit')
  })

  it('tracks active asset versions only when image/request changes', () => {
    const { root, request, asset, review, motion } = fixture()
    const file = path.join(root, 'asset-state.json')
    updateAssetStates({ file, requests: [request], assets: [asset], reviews: [review], motions: [motion], reasonByAsset: new Map([[request.assetId, 'initial-generation']]) })
    updateAssetStates({ file, requests: [request], assets: [asset], reviews: [review], motions: [motion], reasonByAsset: new Map([[request.assetId, 'cache-reuse']]) })
    expect(readAssetState(file).entries[request.assetId]?.version).toBe(1)
    expect(readAssetState(file).entries[request.assetId]?.lastObservedReason).toBe('cache-reuse')

    const replacementPath = path.join(root, 'asset-0001-v2.png')
    fs.writeFileSync(replacementPath, 'replacement')
    updateAssetStates({
      file, requests: [request], assets: [{ ...asset, imagePath: replacementPath }], reviews: [review], motions: [motion],
      reasonByAsset: new Map([[request.assetId, 'user-rerun: subject too small']]),
    })
    const state = readAssetState(file).entries[request.assetId]!
    expect(state.version).toBe(2)
    expect(state.lastChangeReason).toContain('subject too small')
  })

  it('diagnoses a healthy asset from correlated source evidence', () => {
    const { root, pkg, request, asset, review, motion } = fixture()
    writeJson(path.join(root, 'director.json'), pkg)
    writeJson(path.join(root, 'director-findings.json'), [])
    writeJson(path.join(root, 'asset-requests.json'), [request])
    writeJson(path.join(root, 'assets.json'), [asset])
    writeJson(path.join(root, 'vision-reviews.json'), [review])
    writeJson(path.join(root, 'resolved-motions.json'), [motion])
    persistAssetsToCache(path.join(root, 'asset-cache.json'), [request], [asset])
    updateAssetStates({
      file: path.join(root, 'asset-state.json'), requests: [request], assets: [asset], reviews: [review], motions: [motion],
      reasonByAsset: new Map([[request.assetId, 'initial-generation']]),
    })
    const report = analyzeAssetDebug(root, request.assetId)
    expect(report.suspectedLayer).toBe('healthy')
    expect(report.cache.hashMatches).toBe(true)
    expect(report.evidence.join(' ')).toContain('Vision accepted')
    expect(fs.existsSync(path.join(root, 'debug', request.assetId + '.json'))).toBe(true)
  })
})
