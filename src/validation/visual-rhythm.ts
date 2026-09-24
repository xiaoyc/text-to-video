import type { DirectorShot, VisualEvent } from '../domain/types.js'
import { READABLE_SHOT_TEMPLATES } from '../director/playbook.js'

export interface VisualRhythmAssessment {
  maxIdleMs: number
  longestIdleMs: number
  passed: boolean
  events: Array<VisualEvent & { source: string }>
  coverageReason: string
}

function budgetFor(shot: DirectorShot): number {
  if (shot.shotTemplateId && READABLE_SHOT_TEMPLATES.has(shot.shotTemplateId)) return 7000
  if (shot.overlays?.some(item => item.type === 'citation' || item.type === 'explanation')) return 7000
  return 5000
}

export function assessVisualRhythm(shot: DirectorShot): VisualRhythmAssessment {
  const events: Array<VisualEvent & { source: string }> = [
    { atMs: 0, type: 'internal-beat', impact: 'structural', purpose: 'shot start', source: 'shot-start' },
    { atMs: shot.durationMs, type: 'internal-beat', impact: 'structural', purpose: 'shot end', source: 'shot-end' },
  ]

  for (const atMs of shot.internalBeatsMs) {
    events.push({ atMs, type: 'internal-beat', impact: 'informational', purpose: 'Director internal beat', source: 'internalBeatsMs' })
  }
  if (shot.reveal) {
    events.push({ atMs: shot.reveal.atMs, type: 'reveal', impact: 'structural', purpose: `reveal ${shot.reveal.subjectId}`, source: 'reveal' })
  }
  for (const event of shot.visualEvents ?? []) {
    events.push({ ...event, source: 'visualEvents' })
  }
  for (const overlay of shot.overlays ?? []) {
    events.push({
      atMs: overlay.atMs,
      type: 'overlay-enter',
      impact: 'informational',
      purpose: overlay.purpose ?? `${overlay.type}: ${overlay.text}`,
      source: 'overlays',
    })
    if (overlay.endMs !== undefined) {
      events.push({
        atMs: overlay.endMs,
        type: 'overlay-update',
        impact: 'informational',
        purpose: `${overlay.type} ends`,
        source: 'overlays',
      })
    }
  }

  const meaningful = events
    .filter(event => event.impact !== 'decorative')
    .filter(event => Number.isFinite(event.atMs) && event.atMs >= 0 && event.atMs <= shot.durationMs)
    .sort((a, b) => a.atMs - b.atMs)
    .filter((event, index, all) => index === 0 || event.atMs !== all[index - 1]?.atMs)

  let longestIdleMs = 0
  for (let index = 1; index < meaningful.length; index += 1) {
    longestIdleMs = Math.max(longestIdleMs, meaningful[index]!.atMs - meaningful[index - 1]!.atMs)
  }
  const maxIdleMs = budgetFor(shot)
  return {
    maxIdleMs,
    longestIdleMs,
    passed: longestIdleMs <= maxIdleMs,
    events: meaningful,
    coverageReason: longestIdleMs <= maxIdleMs
      ? `longest meaningful visual idle ${longestIdleMs}ms <= budget ${maxIdleMs}ms`
      : `longest meaningful visual idle ${longestIdleMs}ms exceeds budget ${maxIdleMs}ms`,
  }
}
