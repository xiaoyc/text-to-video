import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { compileAssetRequests } from '../src/assets/prompt-compiler.js'
import { updateAssetStates } from '../src/assets/state.js'
import { writePrecutSummary } from '../src/pipeline/precut-summary.js'
import type { GeneratedAsset, VisionReviewResult } from '../src/domain/types.js'
import { resolveAllMotions } from '../src/vision/runtime.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

describe('precut summary', () => {
  it('writes human-readable md and structured json from the actual workflow state', () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'text-to-video-precut-'))
    const pkg = structuredClone(zhouDiGoldenPackage)
    pkg.shots = [pkg.shots[0]!]
    pkg.narrative.beats = [pkg.narrative.beats[0]!]
    const requests = compileAssetRequests(pkg)
    const assets: GeneratedAsset[] = requests.map(request => {
      const imagePath = path.join(runDir, request.assetId + '.png')
      fs.writeFileSync(imagePath, 'image')
      return { assetId: request.assetId, shotId: request.shotId, role: request.role, imagePath, provider: 'fake' }
    })
    const reviews: VisionReviewResult[] = requests.map(request => ({
      accepted: true,
      score: 92,
      reasons: [],
      retryHints: [],
      grounding: {
        assetId: request.assetId,
        shotId: request.shotId,
        primary: {
          subjectId: pkg.shots[0]!.motion.targetSubjectId,
          detected: true,
          bbox: { x: 0.2, y: 0.2, width: 0.3, height: 0.3 },
          center: { x: 0.35, y: 0.35 },
          confidence: 0.95,
        },
        secondary: [],
        safeCrop: { maxScale: 1.5, recommendedFocusCenter: { x: 0.35, y: 0.35 } },
      },
    }))
    const motions = resolveAllMotions(pkg, reviews)
    updateAssetStates({
      file: path.join(runDir, 'asset-state.json'),
      requests,
      assets,
      reviews,
      motions,
      reasonByAsset: new Map(requests.map(request => [request.assetId, 'initial-generation'])),
    })

    const summary = writePrecutSummary({ runDir, pkg, requests, assets, reviews, motions })
    expect(summary.overview.shotCount).toBe(1)
    expect(summary.shots[0]?.motionSummary).toContain('缓慢推近')
    expect(summary.shots[0]?.visualSummary).toContain('周迪手中的铜钱')

    const markdown = fs.readFileSync(path.join(runDir, 'precut-summary.md'), 'utf8')
    expect(markdown).toContain('# Precut Summary')
    expect(markdown).toContain('运镜：')
    expect(markdown).toContain('显示：')
    expect(markdown).toContain('文字：')
    expect(fs.existsSync(path.join(runDir, 'precut-summary.json'))).toBe(true)
  })
})
