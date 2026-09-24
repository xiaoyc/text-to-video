import type { DirectorPackage, DirectorShot, TtsCue } from '../domain/types.js'

export function retimeDirectorPackage(pkg: DirectorPackage, cues: TtsCue[]): DirectorPackage {
  const cueByBeat = new Map(cues.map(cue => [cue.beatId, cue]))
  const shotsByBeat = new Map<string, DirectorShot[]>()
  for (const shot of pkg.shots) {
    const list = shotsByBeat.get(shot.beatId) ?? []
    list.push(shot)
    shotsByBeat.set(shot.beatId, list)
  }

  const retimed: DirectorShot[] = []
  for (const beat of pkg.narrative.beats) {
    const cue = cueByBeat.get(beat.beatId)
    const shots = shotsByBeat.get(beat.beatId) ?? []
    if (!shots.length) continue
    if (!cue) {
      retimed.push(...shots)
      continue
    }
    const originalTotal = shots.reduce((sum, shot) => sum + shot.durationMs, 0)
    let cursor = cue.startMs
    shots.forEach((shot, index) => {
      const isLast = index === shots.length - 1
      const ratio = originalTotal > 0 ? shot.durationMs / originalTotal : 1 / shots.length
      const durationMs = isLast ? cue.endMs - cursor : Math.max(1, Math.round(cue.durationMs * ratio))
      const scale = durationMs / Math.max(1, shot.durationMs)
      const endMs = cursor + durationMs
      retimed.push({
        ...shot,
        startMs: cursor,
        endMs,
        durationMs,
        internalBeatsMs: shot.internalBeatsMs.map(ms => Math.max(0, Math.min(durationMs - 1, Math.round(ms * scale)))),
        ...(shot.reveal ? { reveal: { ...shot.reveal, atMs: Math.max(0, Math.min(durationMs - 1, Math.round(shot.reveal.atMs * scale))) } } : {}),
      })
      cursor = endMs
    })
  }

  return { ...pkg, shots: retimed }
}
