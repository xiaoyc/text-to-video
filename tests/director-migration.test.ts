import { describe, expect, it } from 'vitest'
import type { DirectorPackage } from '../src/domain/types.js'
import { runSinglePassDirector, type TextModel } from '../src/director/single-pass.js'
import { assessVisualRhythm } from '../src/validation/visual-rhythm.js'
import { blockingFindings, validateDirectorPackage } from '../src/validation/director-validator.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

describe('director migration quality gates', () => {
  it('blocks a timeline that starts late or contains a gap', () => {
    const pkg = structuredClone(zhouDiGoldenPackage)
    pkg.shots[0]!.startMs = 52000
    pkg.shots[0]!.endMs = 54800
    const findings = blockingFindings(validateDirectorPackage(pkg))
    expect(findings.some(item => item.issue.includes('timeline must start at 0ms'))).toBe(true)
    expect(findings.some(item => item.issue.includes('timeline gap') || item.issue.includes('timeline overlap'))).toBe(true)
  })

  it('blocks an uncovered narrative beat', () => {
    const pkg = structuredClone(zhouDiGoldenPackage)
    pkg.shots = pkg.shots.filter(shot => shot.beatId !== 'beat-002')
    // Keep remaining timing contiguous so the coverage finding is independently visible.
    let cursor = 0
    for (const shot of pkg.shots) {
      shot.startMs = cursor
      shot.endMs = cursor + shot.durationMs
      cursor = shot.endMs
    }
    const findings = blockingFindings(validateDirectorPackage(pkg))
    expect(findings.some(item => item.issue.includes('beat-002 has no shot coverage'))).toBe(true)
  })

  it('does not treat before/after asset states alone as enough coverage for a 50s shot', () => {
    const shot = structuredClone(zhouDiGoldenPackage.shots[4]!)
    shot.startMs = 0
    shot.durationMs = 50000
    shot.endMs = 50000
    shot.internalBeatsMs = []
    shot.reveal = undefined
    shot.visualEvents = []
    shot.overlays = []
    expect(shot.assetStates.length).toBeGreaterThan(1)
    const rhythm = assessVisualRhythm(shot)
    expect(rhythm.passed).toBe(false)
    expect(rhythm.longestIdleMs).toBe(50000)
  })

  it('allows a long visual idea when source-driven events keep meaningful idle within budget', () => {
    const shot = structuredClone(zhouDiGoldenPackage.shots[0]!)
    shot.startMs = 0
    shot.durationMs = 15000
    shot.endMs = 15000
    shot.internalBeatsMs = []
    shot.visualEvents = [
      { atMs: 5000, type: 'asset-state-change', impact: 'structural', purpose: 'change evidence image' },
      { atMs: 10000, type: 'overlay-enter', impact: 'informational', purpose: 'show source-supported explanation' },
    ]
    const rhythm = assessVisualRhythm(shot)
    expect(rhythm.passed).toBe(true)
    expect(rhythm.longestIdleMs).toBe(5000)
  })

  it('fails closed when repair drops an unaffected shot', async () => {
    const invalid = structuredClone(zhouDiGoldenPackage)
    invalid.shots[2]!.motion.targetSubjectId = 'not-declared'
    const destructiveRepair = structuredClone(zhouDiGoldenPackage)
    destructiveRepair.shots = destructiveRepair.shots.filter(shot => shot.shotId !== 'shot-001')

    let calls = 0
    const model: TextModel = {
      async completeJson<T>() {
        calls += 1
        return structuredClone(calls === 1 ? invalid : destructiveRepair) as T
      },
    }
    const result = await runSinglePassDirector(model, {
      script: zhouDiGoldenPackage.script,
      style: zhouDiGoldenPackage.style,
      aspectRatio: zhouDiGoldenPackage.aspectRatio,
    })
    expect(calls).toBe(2)
    expect(blockingFindings(result.findings).some(item => item.category === 'repair' && item.issue.includes('shot-001'))).toBe(true)
  })

  it('validates attention payoff references', () => {
    const pkg: DirectorPackage = structuredClone(zhouDiGoldenPackage)
    pkg.attention.payoff = { targetBeatId: 'beat-does-not-exist', description: 'invalid' }
    const findings = blockingFindings(validateDirectorPackage(pkg))
    expect(findings.some(item => item.category === 'hook')).toBe(true)
  })
})
