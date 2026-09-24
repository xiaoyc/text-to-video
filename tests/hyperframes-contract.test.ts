import { describe, expect, it } from 'vitest'
import type { PreviewProject } from '../src/domain/types.js'
import { buildHyperFramesComposition } from '../src/render/hyperframes-html.js'

describe('HyperFrames composition contract', () => {
  it('builds seek-safe timed clips and a registered paused timeline', () => {
    const plan: PreviewProject = {
      compositionId: 'golden',
      width: 1920,
      height: 1080,
      fps: 30,
      durationMs: 3000,
      scenes: [{
        shotId: 'shot-001',
        startMs: 0,
        durationMs: 3000,
        renderMode: '2d',
        narrationText: '铜钱。',
        assetIds: ['asset-0001'],
        switchAtMs: [],
        motion: {
          shotId: 'shot-001',
          targetSubjectId: 'copper-coins',
          compatible: true,
          keyframes: [
            { atMs: 0, focus: { x: 0.28, y: 0.64 }, scale: 1 },
            { atMs: 3000, focus: { x: 0.28, y: 0.64 }, scale: 1.12 },
          ],
          adjustments: [],
          warnings: [],
        },
      }],
      assets: [{
        assetId: 'asset-0001',
        shotId: 'shot-001',
        role: 'primary',
        imagePath: 'assets/asset-0001.png',
        provider: 'test',
      }],
      audio: [{
        beatId: 'beat-001',
        text: '铜钱。',
        audioPath: 'audio/beat-001.mp3',
        startMs: 0,
        endMs: 3000,
        durationMs: 3000,
      }],
    }

    const html = buildHyperFramesComposition(plan)

    expect(html).toContain('data-composition-id="golden"')
    expect(html).toContain('class="clip scene"')
    expect(html).toContain('data-start="0.000"')
    expect(html).toContain('data-duration="3.000"')
    expect(html).toContain('gsap.timeline({ paused: true })')
    expect(html).toContain('window.__timelines["golden"] = tl')
    expect(html).toContain('transformOrigin: "28.000% 64.000%"')
    expect(html).toContain('id="audio-0-beat-001"')
    expect(html).not.toContain('hf-seek')
    expect(html).not.toContain('data-no-timeline')
  })
})
