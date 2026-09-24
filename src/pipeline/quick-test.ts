import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorPackage, GeneratedAsset } from '../domain/types.js'
import type { ImageProvider } from '../providers/image.js'
import { generateOneAsset } from '../assets/runtime.js'
import { createRunLogger } from '../runtime/run-log.js'
import { readJson, writeJson } from '../runtime/workspace.js'

export interface QuickTestOptions {
  runDir: string
  imageProvider: ImageProvider
  shots?: number
  shotId?: string
  hint?: string
}

export interface QuickTestResult {
  iterationDir: string
  galleryPath: string
  assets: GeneratedAsset[]
  shotIds: string[]
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!)
}

function galleryHtml(input: {
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  shotIds: string[]
  relativeAssetsPath: (asset: GeneratedAsset) => string
  hint?: string
}): string {
  const requestById = new Map(input.requests.map(request => [request.assetId, request]))
  const shotById = new Map(input.pkg.shots.map(shot => [shot.shotId, shot]))
  const sections = input.shotIds.map(shotId => {
    const shot = shotById.get(shotId)!
    const cards = input.assets.filter(asset => asset.shotId === shotId).map(asset => {
      const request = requestById.get(asset.assetId)!
      return `<article class="card"><img src="${escapeHtml(input.relativeAssetsPath(asset))}" alt="${escapeHtml(shotId)} ${escapeHtml(asset.role)}"><div class="meta"><strong>${escapeHtml(asset.assetId)} · ${escapeHtml(asset.role)}</strong><p>${escapeHtml(request.prompt)}</p><small>Avoid: ${escapeHtml(request.negativePrompt)}</small></div></article>`
    }).join('\n')
    return `<section><h2>${escapeHtml(shotId)} · ${escapeHtml(shot.subject.primary.label)}</h2><p class="narration">${escapeHtml(shot.narrationText)}</p><div class="grid">${cards}</div></section>`
  }).join('\n')
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>快速生图测试</title><style>
body{margin:0;background:#111318;color:#f1f2f6;font:15px/1.55 system-ui,sans-serif}main{max-width:1240px;margin:0 auto;padding:28px}h1{margin:0 0 6px}header,.narration,small{color:#b4bac7}section{margin:32px 0}section h2{border-bottom:1px solid #363b47;padding-bottom:8px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px}.card{overflow:hidden;border:1px solid #363b47;border-radius:10px;background:#1b1e26}.card img{display:block;width:100%;aspect-ratio:16/9;object-fit:contain;background:#08090c}.meta{padding:12px}.meta p{margin:8px 0}small{display:block}.hint{white-space:pre-wrap;color:#d3c49a}
</style></head><body><main><h1>快速生图测试</h1><header>${input.shotIds.length} 个镜头 · ${input.assets.length} 张候选图 · ${new Date().toISOString()}</header>${input.hint ? `<p class="hint">迭代提示：${escapeHtml(input.hint)}</p>` : ''}${sections}</main></body></html>`
}

export async function generateQuickTest(input: QuickTestOptions): Promise<QuickTestResult> {
  const runDir = path.resolve(input.runDir)
  if (fs.existsSync(path.join(runDir, 'lock.json'))) throw new Error('quick-test cannot add candidates to a locked run')
  if (!fs.existsSync(path.join(runDir, 'dry-run-state.json'))) {
    throw new Error('quick-test requires a plan created by run --dry-run')
  }
  const pkg = readJson<DirectorPackage>(path.join(runDir, 'director.json'))
  const allRequests = readJson<AssetRequest[]>(path.join(runDir, 'asset-requests.json'))
  const shots = input.shotId
    ? pkg.shots.filter(shot => shot.shotId === input.shotId)
    : pkg.shots.slice(0, input.shots ?? 3)
  if (input.shotId && shots.length === 0) throw new Error(`shot not found in director.json: ${input.shotId}`)
  if (!shots.length) throw new Error('quick-test selected no shots')
  const shotIds = shots.map(shot => shot.shotId)
  const selectedIds = new Set(shotIds)
  const requests = allRequests.filter(request => selectedIds.has(request.shotId))
  if (!requests.length) throw new Error(`no asset requests found for selected shots: ${shotIds.join(', ')}`)

  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const testRoot = path.join(runDir, 'quick-test')
  const iterationDir = path.join(testRoot, `iteration-${stamp}`)
  const assetsDir = path.join(iterationDir, 'assets')
  fs.mkdirSync(assetsDir, { recursive: true })
  const logger = createRunLogger(runDir)
  logger.emit({
    stage: 'pipeline', type: 'quick-test.start', message: 'quick image test started',
    data: { shotIds, assetCount: requests.length, hint: input.hint ?? '' },
  })

  const assets: GeneratedAsset[] = []
  for (const request of requests) {
    logger.emit({ stage: 'asset', type: 'quick-test.generation-start', message: 'generating quick-test candidate', assetId: request.assetId, shotId: request.shotId })
    try {
      const asset = await generateOneAsset({
        request,
        outputDir: assetsDir,
        provider: input.imageProvider,
        ...(input.hint ? { retryHints: [input.hint] } : {}),
      })
      assets.push(asset)
      logger.emit({
        stage: 'asset', type: 'quick-test.generated', message: 'quick-test candidate generated',
        assetId: asset.assetId, shotId: asset.shotId,
        data: { imagePath: asset.imagePath, provider: asset.provider },
      })
    } catch (error) {
      logger.emit({
        stage: 'asset', type: 'quick-test.generation-failed', message: 'quick-test candidate generation failed',
        assetId: request.assetId, shotId: request.shotId,
        data: { error: error instanceof Error ? error.message : String(error) },
      })
      throw error
    }
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    shotIds,
    hint: input.hint ?? '',
    requests,
    assets,
  }
  writeJson(path.join(iterationDir, 'quick-test.json'), manifest)
  const iterationGallery = path.join(iterationDir, 'index.html')
  fs.writeFileSync(iterationGallery, galleryHtml({
    pkg, requests, assets, shotIds, relativeAssetsPath: asset => path.relative(iterationDir, asset.imagePath).replace(/\\/g, '/'),
    ...(input.hint ? { hint: input.hint } : {}),
  }))
  const latestGallery = path.join(testRoot, 'index.html')
  fs.writeFileSync(latestGallery, galleryHtml({
    pkg, requests, assets, shotIds, relativeAssetsPath: asset => path.relative(testRoot, asset.imagePath).replace(/\\/g, '/'),
    ...(input.hint ? { hint: input.hint } : {}),
  }))
  logger.emit({
    stage: 'pipeline', type: 'quick-test.complete', message: 'quick image test completed',
    data: { galleryPath: latestGallery, iterationDir, shotIds, assetCount: assets.length },
  })
  return { iterationDir, galleryPath: latestGallery, assets, shotIds }
}
