import fs from 'node:fs'
import path from 'node:path'
import type {
  AssetRequest,
  DirectorPackage,
  GeneratedAsset,
  ResolvedMotion,
  VisionReviewResult,
} from '../domain/types.js'
import { assetRequestHash, readAssetCache } from '../assets/cache.js'
import { readAssetState } from '../assets/state.js'
import { readJson, writeJson } from '../runtime/workspace.js'
import { assessVisualRhythm } from '../validation/visual-rhythm.js'

export interface PrecutAssetStatus {
  assetId: string
  role: string
  version: number
  source: string
  provider: string
  cacheValid: boolean
  visionAccepted: boolean
  visionScore: number | null
}

export interface PrecutShotSummary {
  shotId: string
  beatId: string
  purpose: string
  durationMs: number
  narrativeSummary: string
  visualSummary: string
  motionSummary: string
  displaySummary: string
  textSummary: string
  visualRhythmSummary: string
  assetStatus: PrecutAssetStatus[]
  motionCompatible: boolean
  warnings: string[]
}

export interface PrecutSummary {
  version: 1
  generatedAt: string
  overview: {
    shotCount: number
    totalDurationMs: number
    assetCount: number
    cacheValidAssets: number
    visionAcceptedAssets: number
    motionCompatibleShots: number
    longShots: number
  }
  shots: PrecutShotSummary[]
}

const MOTION_LABELS: Record<string, string> = {
  static: '基本静止',
  'push-in': '缓慢推近',
  'pull-out': '缓慢拉远',
  'pan-left': '向左平移',
  'pan-right': '向右平移',
  tracking: '跟随主体移动',
  arc: '环绕主体运动',
  'crane-up': '镜头上升',
  'crane-down': '镜头下降',
}

function movementSummary(pkg: DirectorPackage, shotId: string, motion: ResolvedMotion | undefined): string {
  const shot = pkg.shots.find(item => item.shotId === shotId)
  if (!shot) return '未找到镜头定义。'
  const label = MOTION_LABELS[shot.motion.type] ?? shot.motion.type
  const target = [shot.subject.primary, ...shot.subject.secondary]
    .find(subject => subject.id === shot.motion.targetSubjectId)?.label
    ?? shot.motion.targetSubjectId
  const frames = motion?.keyframes ?? []
  const start = frames[0]
  const end = frames.at(-1)
  const scale = start && end
    ? `，实际缩放 ${start.scale.toFixed(2)} → ${end.scale.toFixed(2)}`
    : ''
  const adjustment = motion?.adjustments.length
    ? `；执行调整：${motion.adjustments.join('；')}`
    : ''
  const envelope = shot.motionEnvelope ? `；节奏包络：${shot.motionEnvelope}` : ''
  return `${label}，目标是「${target}」；导演任务：${shot.intent.cameraTask}${envelope}${scale}${adjustment}`
}

function visualSummary(pkg: DirectorPackage, shotId: string): string {
  const shot = pkg.shots.find(item => item.shotId === shotId)
  if (!shot) return '未找到镜头定义。'
  const secondary = shot.subject.secondary.map(item => item.label)
  const keep = shot.subject.mustKeepVisible.length
    ? `；必须保持可见：${shot.subject.mustKeepVisible.join('、')}`
    : ''
  return `主体「${shot.subject.primary.label}」${secondary.length ? `；辅助主体：${secondary.join('、')}` : ''}${keep}`
}

function displaySummary(pkg: DirectorPackage, shotId: string, requests: AssetRequest[]): string {
  const shot = pkg.shots.find(item => item.shotId === shotId)
  if (!shot) return '未找到镜头定义。'
  const roles = requests.map(item => item.role)
  const roleText = roles.length ? `（${roles.join(' → ')}）` : ''
  const reveal = shot.reveal ? `；在 ${(shot.reveal.atMs / 1000).toFixed(1)}s 触发 reveal` : ''
  const template = shot.shotTemplateId ? `；模板 ${shot.shotTemplateId}` : ''
  return `${requests.length} 张画面${roleText}，渲染模式 ${shot.renderMode}${template}${reveal}。构图意图：${shot.intent.startFraming} → ${shot.intent.endFraming}`
}

function textSummary(pkg: DirectorPackage, shotId: string): string {
  const shot = pkg.shots.find(item => item.shotId === shotId)
  if (!shot) return '未找到镜头定义。'
  const subtitle = shot.narrationText?.trim()
  const overlays = (shot.overlays ?? []).map(item => `${item.type} @ ${(item.atMs / 1000).toFixed(1)}s：「${item.text}」`)
  const extra = overlays.length ? `额外文字：${overlays.join('；')}` : '无额外字卡/讲解文字'
  return subtitle ? `解说字幕：「${subtitle}」；${extra}。` : `无解说字幕；${extra}。`
}

function cacheIsValid(input: {
  request: AssetRequest
  asset: GeneratedAsset | undefined
  cacheEntry: ReturnType<typeof readAssetCache>['entries'][string] | undefined
}): boolean {
  if (!input.asset || !input.cacheEntry) return false
  return input.cacheEntry.requestHash === assetRequestHash(input.request)
    && input.cacheEntry.imagePath === input.asset.imagePath
    && fs.existsSync(input.cacheEntry.imagePath)
}

export function buildPrecutSummary(input: {
  runDir: string
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
  motions: ResolvedMotion[]
}): PrecutSummary {
  const state = readAssetState(path.join(input.runDir, 'asset-state.json'))
  const cache = readAssetCache(path.join(input.runDir, 'asset-cache.json'))
  const assetById = new Map(input.assets.map(asset => [asset.assetId, asset]))
  const reviewById = new Map(input.reviews.map(review => [review.grounding.assetId, review]))
  const motionByShot = new Map(input.motions.map(motion => [motion.shotId, motion]))
  const beatById = new Map(input.pkg.narrative.beats.map(beat => [beat.beatId, beat]))

  const shots = input.pkg.shots.map(shot => {
    const requests = input.requests.filter(request => request.shotId === shot.shotId)
    const motion = motionByShot.get(shot.shotId)
    const rhythm = assessVisualRhythm(shot)
    const statuses: PrecutAssetStatus[] = requests.map(request => {
      const asset = assetById.get(request.assetId)
      const review = reviewById.get(request.assetId)
      const activeState = state.entries[request.assetId]
      const cacheEntry = cache.entries[request.assetId]
      return {
        assetId: request.assetId,
        role: request.role,
        version: activeState?.version ?? 1,
        source: activeState?.lastObservedReason ?? activeState?.lastChangeReason ?? asset?.provider ?? 'unknown',
        provider: asset?.provider ?? activeState?.provider ?? 'unknown',
        cacheValid: cacheIsValid({ request, asset, cacheEntry }),
        visionAccepted: review?.accepted ?? false,
        visionScore: review?.score ?? null,
      }
    })

    const warnings = [
      ...(motion?.warnings ?? []),
      ...input.reviews
        .filter(review => review.grounding.shotId === shot.shotId && !review.accepted)
        .flatMap(review => review.reasons),
    ]

    return {
      shotId: shot.shotId,
      beatId: shot.beatId,
      purpose: beatById.get(shot.beatId)?.purpose ?? '',
      durationMs: shot.durationMs,
      narrativeSummary: shot.narrationText || beatById.get(shot.beatId)?.text || '',
      visualSummary: visualSummary(input.pkg, shot.shotId),
      motionSummary: movementSummary(input.pkg, shot.shotId, motion),
      displaySummary: displaySummary(input.pkg, shot.shotId, requests),
      textSummary: textSummary(input.pkg, shot.shotId),
      visualRhythmSummary: `${(rhythm.longestIdleMs / 1000).toFixed(1)}s / budget ${(rhythm.maxIdleMs / 1000).toFixed(1)}s · ${rhythm.passed ? 'PASS' : 'FAIL'}`,
      assetStatus: statuses,
      motionCompatible: motion?.compatible ?? false,
      warnings: [...new Set(warnings)],
    }
  })

  const allStatuses = shots.flatMap(shot => shot.assetStatus)
  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    overview: {
      shotCount: shots.length,
      totalDurationMs: Math.max(0, ...input.pkg.shots.map(shot => shot.endMs)),
      assetCount: allStatuses.length,
      cacheValidAssets: allStatuses.filter(item => item.cacheValid).length,
      visionAcceptedAssets: allStatuses.filter(item => item.visionAccepted).length,
      motionCompatibleShots: shots.filter(item => item.motionCompatible).length,
      longShots: shots.filter(item => item.durationMs >= 5000).length,
    },
    shots,
  }
}

export function renderPrecutSummaryMarkdown(summary: PrecutSummary): string {
  const lines: string[] = [
    '# Precut Summary',
    '',
    '> 给人看的预剪辑总览。内容来自当前 Director / Asset / Vision / Motion / Cache 实际状态，不额外调用 LLM。',
    '',
    `- 镜头总数：${summary.overview.shotCount}`,
    `- 总时长：${(summary.overview.totalDurationMs / 1000).toFixed(1)}s`,
    `- 图片资产：${summary.overview.assetCount}`,
    `- Cache 有效：${summary.overview.cacheValidAssets}/${summary.overview.assetCount}`,
    `- Vision 通过：${summary.overview.visionAcceptedAssets}/${summary.overview.assetCount}`,
    `- Motion 兼容：${summary.overview.motionCompatibleShots}/${summary.overview.shotCount}`,
    `- 长镜头（≥5s）：${summary.overview.longShots}`,
    '',
  ]

  summary.shots.forEach((shot, index) => {
    const status = shot.assetStatus.length
      ? shot.assetStatus.map(asset => {
          const score = asset.visionScore === null ? '?' : String(asset.visionScore)
          return `${asset.assetId} v${asset.version} · ${asset.source} · cache:${asset.cacheValid ? 'hit' : 'miss'} · vision:${asset.visionAccepted ? `pass(${score})` : `fail(${score})`}`
        }).join(' | ')
      : '无图片资产'

    lines.push(
      `## ${index + 1}. ${shot.shotId} — ${(shot.durationMs / 1000).toFixed(1)}s`,
      '',
      `- 作用：${shot.purpose || '未标注'}`,
      `- 叙事：${shot.narrativeSummary || '无'}`,
      `- 画面：${shot.visualSummary}`,
      `- 运镜：${shot.motionSummary}`,
      `- 显示：${shot.displaySummary}`,
      `- 文字：${shot.textSummary}`,
      `- 视觉空窗：${shot.visualRhythmSummary}`,
      `- 状态：${status} · motion:${shot.motionCompatible ? 'compatible' : 'incompatible'}`,
      `- 注意：${shot.warnings.length ? shot.warnings.join('；') : '无'}`,
      '',
    )
  })

  return lines.join('\n')
}

export function writePrecutSummary(input: {
  runDir: string
  pkg: DirectorPackage
  requests: AssetRequest[]
  assets: GeneratedAsset[]
  reviews: VisionReviewResult[]
  motions: ResolvedMotion[]
}): PrecutSummary {
  const summary = buildPrecutSummary(input)
  writeJson(path.join(input.runDir, 'precut-summary.json'), summary)
  fs.writeFileSync(path.join(input.runDir, 'precut-summary.md'), renderPrecutSummaryMarkdown(summary))
  return summary
}

export function refreshPrecutSummaryFromRun(runDir: string): PrecutSummary {
  const retimed = fs.existsSync(path.join(runDir, 'director-retimed.json'))
  const pkg = readJson<DirectorPackage>(path.join(runDir, retimed ? 'director-retimed.json' : 'director.json'))
  const requests = readJson<AssetRequest[]>(path.join(runDir, 'asset-requests.json'))
  const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
  const reviews = readJson<VisionReviewResult[]>(path.join(runDir, 'vision-reviews.json'))
  const motionsFile = retimed && fs.existsSync(path.join(runDir, 'resolved-motions-retimed.json'))
    ? 'resolved-motions-retimed.json'
    : 'resolved-motions.json'
  const motions = readJson<ResolvedMotion[]>(path.join(runDir, motionsFile))
  return writePrecutSummary({ runDir, pkg, requests, assets, reviews, motions })
}
