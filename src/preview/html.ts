import fs from 'node:fs'
import path from 'node:path'
import type { PreviewProject } from '../domain/types.js'

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function safeJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

export function preparePreviewProject(plan: PreviewProject, outputDir: string): PreviewProject {
  fs.mkdirSync(outputDir, { recursive: true })
  const assetsDir = path.join(outputDir, 'assets')
  const audioDir = path.join(outputDir, 'audio')
  fs.mkdirSync(assetsDir, { recursive: true })
  fs.mkdirSync(audioDir, { recursive: true })
  const assets = plan.assets.map(asset => {
    const extension = path.extname(asset.imagePath) || '.png'
    const dest = path.join(assetsDir, asset.assetId + extension)
    if (path.resolve(asset.imagePath) !== path.resolve(dest)) fs.copyFileSync(asset.imagePath, dest)
    return { ...asset, imagePath: path.relative(outputDir, dest).replace(/\\/g, '/') }
  })
  const audio = plan.audio.map((cue, index) => {
    const extension = path.extname(cue.audioPath) || '.mp3'
    const dest = path.join(audioDir, `${String(index + 1).padStart(3, '0')}-${cue.beatId}${extension}`)
    if (path.resolve(cue.audioPath) !== path.resolve(dest)) fs.copyFileSync(cue.audioPath, dest)
    return { ...cue, audioPath: path.relative(outputDir, dest).replace(/\\/g, '/') }
  })
  return { ...plan, assets, audio }
}

export function buildPreviewHtml(plan: PreviewProject, interactive = true): string {
  const durationSeconds = Math.max(0.001, plan.durationMs / 1000)
  const sceneHtml = plan.scenes.map((scene, index) => `<section class="scene" id="${scene.shotId}" data-shot="${scene.shotId}" data-start="${(scene.startMs/1000).toFixed(3)}" data-duration="${(scene.durationMs/1000).toFixed(3)}" data-track-index="${index}">
    <div class="visual-stack"></div>
    <div class="shot-debug">${escapeHtml(scene.shotId)} · ${escapeHtml(scene.motion.targetSubjectId)}</div>
    <div class="narration">${escapeHtml(scene.narrationText)}</div>
  </section>`).join('\n')
  const audioHtml = plan.audio.map((cue, index) => `<audio data-start="${(cue.startMs/1000).toFixed(3)}" data-duration="${(cue.durationMs/1000).toFixed(3)}" data-track-index="${1000+index}" src="${cue.audioPath}"></audio>`).join('\n')
  const controls = interactive ? `<div id="controls"><button id="play">▶</button><input id="seek" type="range" min="0" max="${durationSeconds}" step="0.01" value="0"><span id="clock">0.00</span></div>` : ''

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
html,body{margin:0;background:#090b0f;color:#fff;font-family:system-ui,sans-serif;height:100%;overflow:hidden}
#composition{position:relative;width:${plan.width}px;height:${plan.height}px;transform-origin:top left;background:#000;overflow:hidden}
.scene{position:absolute;inset:0;display:none;overflow:hidden;background:#000}
.scene.active{display:block}
.visual-stack{position:absolute;inset:0;overflow:hidden;background:#000}
.asset-layer{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;will-change:transform,opacity;transform-origin:center center}
.shot-debug{position:absolute;left:24px;top:18px;padding:8px 12px;background:rgba(0,0,0,.55);border-radius:8px;font-size:16px;z-index:20}
.narration{position:absolute;left:10%;right:10%;bottom:7%;text-align:center;font-size:30px;line-height:1.35;text-shadow:0 2px 8px #000;z-index:20}
#controls{position:fixed;left:18px;right:18px;bottom:18px;display:flex;gap:12px;align-items:center;z-index:1000;background:rgba(10,10,10,.8);padding:10px 14px;border-radius:10px}
#seek{flex:1}
</style>
</head>
<body>
<div id="composition" data-composition-id="${plan.compositionId}" data-no-timeline data-start="0" data-duration="${durationSeconds}" data-width="${plan.width}" data-height="${plan.height}" data-fps="${plan.fps}">
${sceneHtml}
${audioHtml}
</div>
${controls}
<script id="plan" type="application/json">${safeJson(plan)}</script>
<script>
const plan=JSON.parse(document.getElementById('plan').textContent);
window.__timelines=window.__timelines||{};
window.__timelines[plan.compositionId]={duration:${durationSeconds}};
const assetsById=new Map(plan.assets.map(a=>[a.assetId,a]));
const states=new Map();

function clamp(v,a=0,b=1){return Math.max(a,Math.min(b,v))}
function ease(t){t=clamp(t);return t*t*(3-2*t)}
function lerp(a,b,t){return a+(b-a)*t}
function sampleMotion(motion,localMs){
  const frames=motion.keyframes||[];
  if(!frames.length)return {focus:{x:.5,y:.5},scale:1};
  if(frames.length===1)return frames[0];
  let left=frames[0],right=frames[frames.length-1];
  for(let i=1;i<frames.length;i++){if(localMs<=frames[i].atMs){left=frames[i-1];right=frames[i];break}}
  const span=Math.max(1,right.atMs-left.atMs);
  const t=ease((localMs-left.atMs)/span);
  return {focus:{x:lerp(left.focus.x,right.focus.x,t),y:lerp(left.focus.y,right.focus.y,t)},scale:lerp(left.scale,right.scale,t)};
}
function initScene(scene){
  const root=document.querySelector('[data-shot="'+scene.shotId+'"] .visual-stack');
  const images=scene.assetIds.map((id,index)=>{
    const a=assetsById.get(id);
    const img=document.createElement('img');
    img.className='asset-layer';
    img.src=a.imagePath;
    img.dataset.index=String(index);
    img.style.opacity=index===0?'1':'0';
    root.appendChild(img);
    return img;
  });
  states.set(scene.shotId,{root,images});
}
plan.scenes.forEach(initScene);

function renderAt(seconds){
  const ms=seconds*1000;
  for(const scene of plan.scenes){
    const el=document.querySelector('[data-shot="'+scene.shotId+'"]');
    const active=ms>=scene.startMs&&ms<scene.startMs+scene.durationMs;
    el.classList.toggle('active',active);
    if(!active)continue;
    const local=ms-scene.startMs;
    const state=states.get(scene.shotId);
    let assetIndex=0;
    for(const switchMs of scene.switchAtMs){if(local>=switchMs)assetIndex++}
    state.images.forEach((img,index)=>img.style.opacity=index===assetIndex?'1':'0');
    const sampled=sampleMotion(scene.motion,local);
    for(const img of state.images){
      img.style.transformOrigin=(sampled.focus.x*100)+'% '+(sampled.focus.y*100)+'%';
      img.style.transform='scale('+sampled.scale+')';
    }
  }
  for(const audio of document.querySelectorAll('audio')){
    const start=Number(audio.dataset.start||0),duration=Number(audio.dataset.duration||0);
    if(seconds>=start&&seconds<start+duration){
      const expected=seconds-start;
      if(Math.abs(audio.currentTime-expected)>.25)audio.currentTime=expected;
    }
  }
}
window.addEventListener('hf-seek',e=>renderAt(Number(e.detail?.time??0)));
renderAt(0);
${interactive ? `
let playing=false,last=0,current=0;
const play=document.getElementById('play'),seek=document.getElementById('seek'),clock=document.getElementById('clock');
function syncAudio(){for(const a of document.querySelectorAll('audio')){if(playing){a.play().catch(()=>{})}else a.pause()}}
function tick(now){if(!playing)return;if(!last)last=now;current+=Math.max(0,(now-last)/1000);last=now;if(current>=${durationSeconds}){current=${durationSeconds};playing=false;play.textContent='▶'}renderAt(current);seek.value=String(current);clock.textContent=current.toFixed(2);syncAudio();if(playing)requestAnimationFrame(tick)}
play.onclick=()=>{playing=!playing;play.textContent=playing?'⏸':'▶';last=0;syncAudio();if(playing)requestAnimationFrame(tick)};
seek.oninput=()=>{current=Number(seek.value);renderAt(current);clock.textContent=current.toFixed(2);};
` : ''}
</script>
</body>
</html>`
}

export function writePreview(plan: PreviewProject, outputDir: string, interactive = true): string {
  const prepared = preparePreviewProject(plan, outputDir)
  const htmlPath = path.join(outputDir, 'index.html')
  fs.writeFileSync(path.join(outputDir, 'preview-plan.json'), JSON.stringify(prepared, null, 2))
  fs.writeFileSync(htmlPath, buildPreviewHtml(prepared, interactive))
  return htmlPath
}
