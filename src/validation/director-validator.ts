import type { DirectorFinding, DirectorPackage, DirectorShot } from '../domain/types.js'

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

  const hasMeaningfulChange = shot.assetStates.length > 1 || shot.internalBeatsMs.length > 0 || Boolean(shot.reveal)
  if (shot.durationMs > 6500 && !hasMeaningfulChange) {
    findings.push(finding(
      'blocking',
      'visual-rhythm',
      `shot lasts ${shot.durationMs}ms without an internal beat, reveal, or asset-state change`,
      shot.shotId,
      'Add meaningful visual progression or split the shot for narrative reasons.',
    ))
  } else if (shot.durationMs > 5000 && !hasMeaningfulChange) {
    findings.push(finding('warning', 'visual-rhythm', 'long shot has no meaningful internal visual change', shot.shotId))
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

  const shotIds = new Set<string>()
  for (const shot of pkg.shots) {
    if (shotIds.has(shot.shotId)) findings.push(finding('blocking', 'schema', `duplicate shotId ${shot.shotId}`, shot.shotId))
    shotIds.add(shot.shotId)
    findings.push(...validateShot(shot, beatIds))
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
