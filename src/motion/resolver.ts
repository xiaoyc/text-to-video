import type { AssetGrounding, DirectorShot, Placement, Point, ResolvedMotion } from '../domain/types.js'

const END_SCALE = {
  subtle: 1.12,
  medium: 1.25,
  strong: 1.4,
} as const

function placementPoint(placement: Placement | undefined, fallback: Point): Point {
  switch (placement) {
    case 'left-third': return { x: 0.33, y: 0.5 }
    case 'right-third': return { x: 0.67, y: 0.5 }
    case 'lower-third': return { x: 0.5, y: 0.66 }
    case 'upper-third': return { x: 0.5, y: 0.34 }
    case 'environmental': return fallback
    default: return { x: 0.5, y: 0.5 }
  }
}

function allGroundedSubjects(grounding: AssetGrounding) {
  return [grounding.primary, ...grounding.secondary]
}

export function resolveMotionFromGrounding(shot: DirectorShot, grounding: AssetGrounding): ResolvedMotion {
  const adjustments: string[] = []
  const warnings: string[] = []
  const grounded = allGroundedSubjects(grounding)
  const target = grounded.find(subject => subject.subjectId === shot.motion.targetSubjectId)
  const missingRequired = shot.subject.mustKeepVisible.filter(id => !grounded.some(subject => subject.subjectId === id && subject.detected))

  if (!target || !target.detected || target.confidence < 0.5) {
    return {
      shotId: shot.shotId,
      targetSubjectId: shot.motion.targetSubjectId,
      compatible: false,
      keyframes: [],
      adjustments,
      warnings: [`motion target ${shot.motion.targetSubjectId} is not reliably grounded`],
    }
  }

  if (missingRequired.length) {
    warnings.push(`must-keep-visible subjects are not grounded: ${missingRequired.join(', ')}`)
  }

  const recommended = grounding.safeCrop.recommendedFocusCenter
  const desiredScreenPlacement = placementPoint(shot.intent.preferredPlacement, recommended)
  const requestedScale = shot.motion.type === 'static' ? 1 : END_SCALE[shot.motion.intensity]
  const endScale = Math.max(1, Math.min(requestedScale, grounding.safeCrop.maxScale))

  if (endScale < requestedScale) {
    adjustments.push(`clamped scale from ${requestedScale.toFixed(2)} to ${endScale.toFixed(2)} for safe crop`)
  }

  if (shot.motion.type !== 'static' && endScale < 1.05) {
    warnings.push('asset does not provide enough safe crop room for the requested non-static move')
  }

  const startFocus = shot.motion.type === 'static'
    ? recommended
    : {
        x: Number(((0.5 + recommended.x) / 2).toFixed(4)),
        y: Number(((0.5 + recommended.y) / 2).toFixed(4)),
      }

  const finalFocus = {
    x: Number(recommended.x.toFixed(4)),
    y: Number(recommended.y.toFixed(4)),
  }

  if (Math.abs(desiredScreenPlacement.x - 0.5) > 0.001 || Math.abs(desiredScreenPlacement.y - 0.5) > 0.001) {
    adjustments.push(`preserve preferred on-screen placement ${shot.intent.preferredPlacement ?? 'center'} while tracking grounded subject`)
  }

  const compatible = missingRequired.length === 0 && (shot.motion.type === 'static' || endScale >= 1.05)
  const duration = shot.durationMs

  if (shot.motion.type === 'static') {
    return {
      shotId: shot.shotId,
      targetSubjectId: shot.motion.targetSubjectId,
      compatible,
      keyframes: [
        { atMs: 0, focus: finalFocus, scale: 1 },
        { atMs: duration, focus: finalFocus, scale: 1 },
      ],
      adjustments,
      warnings,
    }
  }

  const midScale = Number((1 + (endScale - 1) * 0.58).toFixed(4))
  return {
    shotId: shot.shotId,
    targetSubjectId: shot.motion.targetSubjectId,
    compatible,
    keyframes: [
      { atMs: 0, focus: startFocus, scale: 1 },
      { atMs: Math.round(duration * 0.62), focus: finalFocus, scale: midScale },
      { atMs: duration, focus: finalFocus, scale: Number(endScale.toFixed(4)) },
    ],
    adjustments,
    warnings,
  }
}
