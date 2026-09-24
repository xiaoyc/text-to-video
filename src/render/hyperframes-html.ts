import type { PreviewProject } from '../domain/types.js'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function seconds(ms: number): string {
  return (ms / 1000).toFixed(3)
}

function normalizedPath(value: string): string {
  return value.replace(/\\/g, '/')
}

export function buildHyperFramesComposition(plan: PreviewProject): string {
  const assetById = new Map(plan.assets.map(asset => [asset.assetId, asset]))
  const scenes = plan.scenes.map((scene, sceneIndex) => {
    const images = scene.assetIds.map((assetId, assetIndex) => {
      const asset = assetById.get(assetId)
      if (!asset) throw new Error(`missing asset ${assetId} for ${scene.shotId}`)
      return `<img id="asset-${sceneIndex}-${assetIndex}" class="asset-layer" src="${escapeHtml(normalizedPath(asset.imagePath))}" alt="" style="opacity:${assetIndex === 0 ? 1 : 0}">`
    }).join('\n')
    return `<section id="scene-${sceneIndex}" class="clip scene" data-start="${seconds(scene.startMs)}" data-duration="${seconds(scene.durationMs)}" data-track-index="${sceneIndex}">
  <div class="visual-stack">${images}</div>
  <div class="narration">${escapeHtml(scene.narrationText)}</div>
</section>`
  }).join('\n')

  const audio = plan.audio.map((cue, index) =>
    `<audio id="audio-${index}-${escapeHtml(cue.beatId)}" src="${escapeHtml(normalizedPath(cue.audioPath))}" data-start="${seconds(cue.startMs)}" data-duration="${seconds(cue.durationMs)}"></audio>`
  ).join('\n')

  const timelineStatements: string[] = []
  for (let sceneIndex = 0; sceneIndex < plan.scenes.length; sceneIndex += 1) {
    const scene = plan.scenes[sceneIndex]!
    const frames = scene.motion.keyframes
    if (!frames.length) continue

    for (let assetIndex = 0; assetIndex < scene.assetIds.length; assetIndex += 1) {
      const selector = `#asset-${sceneIndex}-${assetIndex}`
      const first = frames[0]!
      timelineStatements.push(
        `tl.set("${selector}", { transformOrigin: "${(first.focus.x * 100).toFixed(3)}% ${(first.focus.y * 100).toFixed(3)}%", scale: ${first.scale.toFixed(5)} }, ${seconds(scene.startMs)});`
      )
      for (let frameIndex = 1; frameIndex < frames.length; frameIndex += 1) {
        const prev = frames[frameIndex - 1]!
        const frame = frames[frameIndex]!
        const duration = Math.max(1, frame.atMs - prev.atMs)
        const globalStart = scene.startMs + prev.atMs
        timelineStatements.push(
          `tl.to("${selector}", { transformOrigin: "${(frame.focus.x * 100).toFixed(3)}% ${(frame.focus.y * 100).toFixed(3)}%", scale: ${frame.scale.toFixed(5)}, duration: ${seconds(duration)}, ease: "power2.inOut" }, ${seconds(globalStart)});`
        )
      }
    }

    for (let switchIndex = 0; switchIndex < scene.switchAtMs.length; switchIndex += 1) {
      const localMs = scene.switchAtMs[switchIndex]!
      const globalSeconds = seconds(scene.startMs + localMs)
      const previous = `#asset-${sceneIndex}-${switchIndex}`
      const next = `#asset-${sceneIndex}-${switchIndex + 1}`
      timelineStatements.push(`tl.set("${previous}", { opacity: 0 }, ${globalSeconds});`)
      timelineStatements.push(`tl.set("${next}", { opacity: 1 }, ${globalSeconds});`)
    }
  }

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<script src="https://cdn.jsdelivr.net/npm/gsap@3.14.2/dist/gsap.min.js"></script>
<style>
html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#000;color:#fff;font-family:Arial,sans-serif}
#root{position:relative;width:100%;height:100%;overflow:hidden;background:#000}
.scene{position:absolute;inset:0;overflow:hidden;background:#000}
.visual-stack{position:absolute;inset:0;overflow:hidden}
.asset-layer{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;will-change:transform,opacity}
.narration{position:absolute;left:10%;right:10%;bottom:7%;z-index:20;text-align:center;font-size:30px;line-height:1.35;text-shadow:0 2px 8px #000}
</style>
</head>
<body>
<div id="root" data-composition-id="${escapeHtml(plan.compositionId)}" data-width="${plan.width}" data-height="${plan.height}" data-duration="${seconds(plan.durationMs)}" data-fps="${plan.fps}">
${scenes}
${audio}
</div>
<script>
const tl = gsap.timeline({ paused: true });
${timelineStatements.join('\n')}
window.__timelines["${escapeHtml(plan.compositionId)}"] = tl;
</script>
</body>
</html>`
}
