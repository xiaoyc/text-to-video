import type { AssetRequest, AssetState, DirectorPackage, DirectorShot, SubjectRef } from '../domain/types.js'

const NEGATIVE_BASE = [
  'modern objects',
  'modern clothing',
  'watermark',
  'logo',
  'burned-in text',
  'extra fingers',
  'fused hands',
  'floating objects',
  'contradictory hand ownership',
].join(', ')

function subjectMap(shot: DirectorShot): Map<string, SubjectRef> {
  return new Map([shot.subject.primary, ...shot.subject.secondary].map(subject => [subject.id, subject]))
}

function effectiveStates(shot: DirectorShot): AssetState[] {
  if (shot.assetStates.length) return shot.assetStates
  return [{
    role: 'primary',
    state: shot.rawVisualDescription,
    composition: shot.intent.startFraming,
    visibleSubjectIds: [shot.subject.primary.id, ...shot.subject.secondary.map(subject => subject.id)],
    hiddenSubjectIds: [],
  }]
}

export function compileAssetRequests(pkg: DirectorPackage): AssetRequest[] {
  let assetIndex = 0
  return pkg.shots.flatMap(shot => {
    const subjects = subjectMap(shot)
    return effectiveStates(shot).map(state => {
      assetIndex += 1
      const visible = state.visibleSubjectIds.map(id => subjects.get(id)).filter((value): value is SubjectRef => Boolean(value))
      const hidden = state.hiddenSubjectIds.map(id => subjects.get(id)).filter((value): value is SubjectRef => Boolean(value))
      const primary = subjects.get(shot.subject.primary.id) ?? shot.subject.primary
      const placement = shot.intent.preferredPlacement ?? 'center'
      const prompt = [
        `Primary visual subject: ${primary.label} (${primary.type}).`,
        visible.length ? `Visible subjects: ${visible.map(item => item.label).join(', ')}.` : '',
        `Current fixed moment/state: ${state.state}.`,
        `Composition: ${state.composition}. Primary subject dominance: ${shot.intent.subjectDominance}; preferred placement: ${placement}.`,
        `Narrative goal: ${shot.intent.narrativeGoal}. Camera intent begins as "${shot.intent.startFraming}" and should preserve enough source image for "${shot.intent.endFraming}".`,
        `Historical context: ${pkg.bible.historicalContext}. Visual style: ${pkg.bible.visualStyle || pkg.style}.`,
        `Aspect ratio: ${pkg.aspectRatio}. Keep usable image area around all must-keep-visible subjects: ${shot.subject.mustKeepVisible.join(', ') || primary.label}.`,
      ].filter(Boolean).join(' ')

      const hiddenNegative = hidden.length ? `, must not show: ${hidden.map(item => item.label).join(', ')}` : ''

      return {
        assetId: `asset-${String(assetIndex).padStart(4, '0')}`,
        shotId: shot.shotId,
        role: state.role,
        primarySubjectId: primary.id,
        prompt,
        negativePrompt: `${NEGATIVE_BASE}${hiddenNegative}`,
        visibleSubjectIds: [...state.visibleSubjectIds],
        hiddenSubjectIds: [...state.hiddenSubjectIds],
      }
    })
  })
}
