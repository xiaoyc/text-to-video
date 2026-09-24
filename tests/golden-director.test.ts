import { describe, expect, it } from 'vitest'
import { compileAssetRequests } from '../src/assets/prompt-compiler.js'
import { runSinglePassDirector, type TextModel } from '../src/director/single-pass.js'
import { resolveMotionFromGrounding } from '../src/motion/resolver.js'
import { blockingFindings, validateDirectorPackage } from '../src/validation/director-validator.js'
import type { AssetGrounding, DirectorPackage } from '../src/domain/types.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

describe('golden director contract', () => {
  it('accepts the six-shot Zhou Di golden package without blocking findings', () => {
    const findings = validateDirectorPackage(zhouDiGoldenPackage)
    expect(blockingFindings(findings)).toEqual([])
  })

  it('compiles image prompts deterministically without a prompt-writer LLM', () => {
    const requests = compileAssetRequests(zhouDiGoldenPackage)
    expect(requests).toHaveLength(8)
    expect(requests[0]?.prompt).toContain('周迪手中的铜钱')
    const revealBefore = requests.find(request => request.shotId === 'shot-005' && request.role === 'before')
    expect(revealBefore?.negativePrompt).toContain('周迪妻子的命运揭示')
  })

  it('resolves the copper-coin camera from real image grounding', () => {
    const shot = zhouDiGoldenPackage.shots[0]
    expect(shot).toBeDefined()
    const grounding: AssetGrounding = {
      assetId: 'asset-0001',
      shotId: 'shot-001',
      primary: {
        subjectId: 'copper-coins',
        detected: true,
        bbox: { x: 0.19, y: 0.56, width: 0.18, height: 0.15 },
        center: { x: 0.28, y: 0.635 },
        confidence: 0.94,
      },
      secondary: [],
      safeCrop: {
        maxScale: 1.55,
        recommendedFocusCenter: { x: 0.28, y: 0.635 },
      },
    }

    const resolved = resolveMotionFromGrounding(shot!, grounding)
    expect(resolved.compatible).toBe(true)
    expect(resolved.keyframes.at(-1)?.focus).toEqual({ x: 0.28, y: 0.635 })
    expect(resolved.keyframes.at(-1)?.scale).toBe(1.12)
  })

  it('fails closed when the motion target is not grounded', () => {
    const shot = zhouDiGoldenPackage.shots[0]
    expect(shot).toBeDefined()
    const grounding: AssetGrounding = {
      assetId: 'asset-0001',
      shotId: 'shot-001',
      primary: {
        subjectId: 'wrong-subject',
        detected: true,
        bbox: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
        center: { x: 0.2, y: 0.2 },
        confidence: 0.9,
      },
      secondary: [],
      safeCrop: {
        maxScale: 1.5,
        recommendedFocusCenter: { x: 0.2, y: 0.2 },
      },
    }

    const resolved = resolveMotionFromGrounding(shot!, grounding)
    expect(resolved.compatible).toBe(false)
    expect(resolved.keyframes).toEqual([])
  })

  it('uses exactly one text-model call when the first package passes validation', async () => {
    let calls = 0
    const model: TextModel = {
      async completeJson<T>() {
        calls += 1
        return structuredClone(zhouDiGoldenPackage) as T
      },
    }

    const result = await runSinglePassDirector(model, {
      script: zhouDiGoldenPackage.script,
      style: zhouDiGoldenPackage.style,
      aspectRatio: zhouDiGoldenPackage.aspectRatio,
    })

    expect(calls).toBe(1)
    expect(result.metrics).toEqual({ llmCalls: 1, repairCalls: 0 })
  })

  it('allows at most one unified repair in the default path', async () => {
    let calls = 0
    const invalid = structuredClone(zhouDiGoldenPackage)
    invalid.shots[0]!.motion.targetSubjectId = 'not-declared'

    const model: TextModel = {
      async completeJson<T>() {
        calls += 1
        return structuredClone(calls === 1 ? invalid : zhouDiGoldenPackage) as T
      },
    }

    const result = await runSinglePassDirector(model, {
      script: zhouDiGoldenPackage.script,
      style: zhouDiGoldenPackage.style,
      aspectRatio: zhouDiGoldenPackage.aspectRatio,
    })

    expect(calls).toBe(2)
    expect(result.metrics).toEqual({ llmCalls: 2, repairCalls: 1 })
    expect(blockingFindings(result.findings)).toEqual([])
  })
})
