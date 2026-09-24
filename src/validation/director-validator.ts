import type { DirectorFinding, DirectorPackage, DirectorShot } from '../domain/types.js'
import { assessVisualRhythm } from './visual-rhythm.js'

function finding(
  severity: DirectorFinding['severity'],
  category: DirectorFinding['category'],
  issue: string,
  shotId?: string,
  suggestedDirection?: string,
): DirectorFinding {
  return {
    severity,
    category,
    issue,
    ...(shotId ? { shotId } : {}),
    ...(suggestedDirection ? { suggestedDirection } : {}),
  }
}

function validateShot(shot: DirectorShot, beatIds: Set<string>): DirectorFinding[] {
  const findings: DirectorFinding[] = []
  const refs = [shot.subject.primary, ...shot.subject.secondary]
  const subjectIds = new Set(refs.map(subject => subject.id))

  if (!shot.shotId.trim()) findings.push(finding('blocking', 'schema', 'shotId is required'))
  if (!beatIds.has(shot.beatId)) findings.push(finding('blocking', 'schema', `unknown beatId ${shot.beatId}`, shot.shotId))
  if (shot.durationMs <= 0 || shot.endMs <= shot.startMs || shot.durationMs !== shot.endMs - shot.startMs) {
    findings.push(finding('blocking', 'schema', 'shot timing is inconsistent', shot.shotId))
  }
  if (!shot.subject.primary.id.trim()) findings.push(finding('blocking', 'schema', 'primary shot subject is required', shot.shotId))

  if (!subjectIds.has(shot.motion.targetSubjectId)) {
    findings.push(finding(
      'blocking',
      'camera',
      `motion target ${shot.motion.targetSubjectId} is not declared in shot subjects`,
      shot.shotId,
      'Point the creative motion at the primary or a declared secondary subject.',
    ))
  }

  for (const required of shot.subject.mustKeepVisible) {
    if (!subjectIds.has(required)) {
      findings.push(finding('blocking', 'schema', `mustKeepVisible references undeclared subject ${required}`, shot.shotId))
    }
  }

  for (const atMs of shot.internalBeatsMs) {
    if (atMs <= 0 || atMs >= shot.durationMs) {
      findings.push(finding('blocking', 'visual-rhythm', `internal beat ${atMs}ms must be inside the shot`, shot.shotId))
    }
  }

  for (const event of shot.visualEvents ?? []) {
    if (event.atMs < 0 || event.atMs > shot.durationMs) {
      findings.push(finding('blocking', 'visual-rhythm', `visual event ${event.type} at ${event.atMs}ms is outside the shot`, shot.shotId))
    }
    if (!event.purpose.trim()) {
      findings.push(finding('warning', 'visual-rhythm', `visual event ${event.type} has no purpose`, shot.shotId))
    }
  }

  for (const overlay of shot.overlays ?? []) {
    if (overlay.atMs < 0 || overlay.atMs >= shot.durationMs) {
      findings.push(finding('blocking', 'visual-rhythm', `overlay ${overlay.type} starts outside the shot`, shot.shotId))
    }
    if (overlay.endMs !== undefined && (overlay.endMs <= overlay.atMs || overlay.endMs > shot.durationMs)) {
      findings.push(finding('blocking', 'visual-rhythm', `overlay ${overlay.type} has invalid endMs`, shot.shotId))
    }
    if (!overlay.text.trim()) findings.push(finding('blocking', 'schema', `overlay ${overlay.type} text is empty`, shot.shotId))
  }

  for (const state of shot.assetStates) {
    const visible = new Set(state.visibleSubjectIds)
    for (const hidden of state.hiddenSubjectIds) {
      if (visible.has(hidden)) {
        findings.push(finding(
          'blocking',
          'asset-state',
          `asset state ${state.role} marks ${hidden} as both visible and hidden`,
          shot.shotId,
        ))
      }
    }
  }

  if (shot.reveal) {
    if (shot.reveal.atMs < 0 || shot.reveal.atMs >= shot.durationMs) {
      findings.push(finding('blocking', 'schema', 'reveal time must be inside the shot', shot.shotId))
    }
    if (!subjectIds.has(shot.reveal.subjectId)) {
      findings.push(finding('blocking', 'schema', `reveal subject ${shot.reveal.subjectId} is undeclared`, shot.shotId))
    }
    const before = shot.assetStates.find(state => state.role === 'before')
    if (before?.visibleSubjectIds.includes(shot.reveal.subjectId)) {
      findings.push(finding(
        'blocking',
        'hook',
        `reveal subject ${shot.reveal.subjectId} is already visible in the before state`,
        shot.shotId,
      ))
    }
  }

  const rhythm = assessVisualRhythm(shot)
  if (!rhythm.passed) {
    findings.push(finding(
      'blocking',
      'visual-rhythm',
      `shot longest meaningful visual idle is ${rhythm.longestIdleMs}ms (budget ${rhythm.maxIdleMs}ms)`,
      shot.shotId,
      'Split the visual idea or add source-driven structural/informational visual events, overlays, or reveals. Decorative motion alone does not count.',
    ))
  } else if (shot.durationMs > 8000 && rhythm.events.length <= 2) {
    findings.push(finding('warning', 'visual-rhythm', 'long shot has no explicit internal informational event', shot.shotId))
  }

  return findings
}

export function validateDirectorPackage(pkg: DirectorPackage): DirectorFinding[] {
  const findings: DirectorFinding[] = []
  if (pkg.version !== 1) findings.push(finding('blocking', 'schema', 'unsupported DirectorPackage version'))
  if (!pkg.script.trim()) findings.push(finding('blocking', 'schema', 'script is required'))
  if (!pkg.narrative.beats.length) findings.push(finding('blocking', 'schema', 'at least one narrative beat is required'))
  if (!pkg.shots.length) findings.push(finding('blocking', 'schema', 'at least one shot is required'))

  const beatIds = new Set<string>()
  for (const beat of pkg.narrative.beats) {
    if (beatIds.has(beat.beatId)) findings.push(finding('blocking', 'schema', `duplicate beatId ${beat.beatId}`))
    beatIds.add(beat.beatId)
  }

  if (pkg.attention.hookWindowMs < 5000 || pkg.attention.hookWindowMs > 12000) {
    findings.push(finding('warning', 'hook', `hookWindowMs ${pkg.attention.hookWindowMs}ms is outside the recommended 5-12s range`))
  }
  if (pkg.attention.payoff && !beatIds.has(pkg.attention.payoff.targetBeatId)) {
    findings.push(finding('blocking', 'hook', `attention payoff references unknown beat ${pkg.attention.payoff.targetBeatId}`))
  }
  for (const point of pkg.attention.curve ?? []) {
    if (!beatIds.has(point.beatId)) findings.push(finding('blocking', 'hook', `attention curve references unknown beat ${point.beatId}`))
    if (!Number.isFinite(point.energy) || point.energy < 0 || point.energy > 1) {
      findings.push(finding('blocking', 'hook', `attention energy for ${point.beatId} must be within 0..1`))
    }
  }

  const shotIds = new Set<string>()
  for (const shot of pkg.shots) {
    if (shotIds.has(shot.shotId)) findings.push(finding('blocking', 'schema', `duplicate shotId ${shot.shotId}`, shot.shotId))
    shotIds.add(shot.shotId)
    findings.push(...validateShot(shot, beatIds))
  }

  const coveredBeatIds = new Set(pkg.shots.map(shot => shot.beatId))
  for (const beat of pkg.narrative.beats) {
    if (!coveredBeatIds.has(beat.beatId)) {
      findings.push(finding(
        'blocking',
        'visual-rhythm',
        `narrative beat ${beat.beatId} has no shot coverage`,
        undefined,
        'Every narrative beat must be represented by at least one shot; do not repair by dropping unrelated beats.',
      ))
    }
  }

  if (pkg.shots.length) {
    const first = pkg.shots[0]!
    if (first.startMs !== 0) {
      findings.push(finding('blocking', 'schema', `timeline must start at 0ms, but first shot starts at ${first.startMs}ms`, first.shotId))
    }
    for (let index = 1; index < pkg.shots.length; index += 1) {
      const previous = pkg.shots[index - 1]!
      const current = pkg.shots[index]!
      if (current.startMs !== previous.endMs) {
        const relation = current.startMs > previous.endMs ? 'gap' : 'overlap'
        findings.push(finding(
          'blocking',
          'schema',
          `timeline ${relation}: ${previous.shotId} ends at ${previous.endMs}ms but ${current.shotId} starts at ${current.startMs}ms`,
          current.shotId,
          'Keep the estimated shot timeline contiguous. Timing can be retimed later by TTS, but planning must not omit spans.',
        ))
      }
    }
  }

  for (let index = 2; index < pkg.shots.length; index += 1) {
    const a = pkg.shots[index - 2]
    const b = pkg.shots[index - 1]
    const c = pkg.shots[index]
    if (!a || !b || !c) continue
    if (a.motion.type === b.motion.type && b.motion.type === c.motion.type && c.motion.type !== 'static') {
      findings.push(finding(
        'warning',
        'camera',
        `three consecutive shots repeat ${c.motion.type}`,
        c.shotId,
        'Vary the motion only if the narrative motivation differs.',
      ))
    }
  }

  return findings
}

export function blockingFindings(findings: DirectorFinding[]): DirectorFinding[] {
  return findings.filter(finding => finding.severity === 'blocking')
}
