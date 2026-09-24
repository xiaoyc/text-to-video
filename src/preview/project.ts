import type {
  DirectorPackage,
  GeneratedAsset,
  PreviewProject,
  ResolvedMotion,
  TtsCue,
} from '../domain/types.js'

export function buildPreviewProject(input: {
  pkg: DirectorPackage
  assets: GeneratedAsset[]
  motions: ResolvedMotion[]
  width?: number
  height?: number
  fps?: number
  tts?: TtsCue[]
}): PreviewProject {
  const motionByShot = new Map(input.motions.map(motion => [motion.shotId, motion]))
  const assetsByShot = new Map<string, GeneratedAsset[]>()
  for (const asset of input.assets) {
    const list = assetsByShot.get(asset.shotId) ?? []
    list.push(asset)
    assetsByShot.set(asset.shotId, list)
  }

  const scenes = input.pkg.shots.map(shot => {
    const motion = motionByShot.get(shot.shotId)
    if (!motion) throw new Error(`missing resolved motion for ${shot.shotId}`)
    const assets = assetsByShot.get(shot.shotId) ?? []
    if (!assets.length) throw new Error(`missing image assets for ${shot.shotId}`)
    const switchAtMs = assets.slice(1).map((_, index) => {
      if (index === 0 && shot.reveal) return shot.reveal.atMs
      const position = (index + 1) / assets.length
      return Math.round(shot.durationMs * position)
    })
    return {
      shotId: shot.shotId,
      startMs: shot.startMs,
      durationMs: shot.durationMs,
      renderMode: shot.renderMode,
      narrationText: shot.narrationText,
      assetIds: assets.map(asset => asset.assetId),
      switchAtMs,
      motion,
    }
  })

  return {
    compositionId: 'text-to-video',
    width: input.width ?? 1920,
    height: input.height ?? 1080,
    fps: input.fps ?? 30,
    durationMs: Math.max(0, ...input.pkg.shots.map(shot => shot.endMs), ...(input.tts ?? []).map(cue => cue.endMs)),
    scenes,
    assets: input.assets,
    audio: input.tts ?? [],
  }
}
