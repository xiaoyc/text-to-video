import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorPackage, SubjectRef } from '../domain/types.js'
import { writeJson } from '../runtime/workspace.js'

export interface PrecutDraftShot {
  shotId: string
  beatId: string
  purpose: string
  durationMs: number
  narrativeSummary: string
  primarySubject: SubjectRef
  secondarySubjects: SubjectRef[]
  compositionSummary: string
  motionIntentSummary: string
  displaySummary: string
  expectedAssets: Array<{ assetId: string; role: string; promptFile: string }>
  textSummary: string
  status: 'draft'
}

export interface PrecutDraft {
  version: 1
  generatedAt: string
  planSource: 'director' | 'dry-run-cache'
  directorCalls: number
  inputFingerprint: string
  overview: {
    shotCount: number
    totalDurationMs: number
    assetRequestCount: number
  }
  shots: PrecutDraftShot[]
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

function targetLabel(pkg: DirectorPackage, subjectId: string): string {
  return pkg.shots.flatMap(shot => [shot.subject.primary, ...shot.subject.secondary])
    .find(subject => subject.id === subjectId)?.label ?? subjectId
}

export function buildPrecutDraft(input: {
  pkg: DirectorPackage
  requests: AssetRequest[]
  planSource: PrecutDraft['planSource']
  directorCalls: number
  inputFingerprint: string
}): PrecutDraft {
  const beatById = new Map(input.pkg.narrative.beats.map(beat => [beat.beatId, beat]))
  const shots = input.pkg.shots.map(shot => {
    const beat = beatById.get(shot.beatId)
    const expectedAssets = input.requests
      .filter(request => request.shotId === shot.shotId)
      .map(request => ({
        assetId: request.assetId,
        role: request.role,
        promptFile: `prompts/${request.assetId}.md`,
      }))
    const target = targetLabel(input.pkg, shot.motion.targetSubjectId)
    const motion = MOTION_LABELS[shot.motion.type] ?? shot.motion.type
    const narration = shot.narrationText?.trim() || beat?.text || ''
    return {
      shotId: shot.shotId,
      beatId: shot.beatId,
      purpose: beat?.purpose ?? '',
      durationMs: shot.durationMs,
      narrativeSummary: narration,
      primarySubject: shot.subject.primary,
      secondarySubjects: shot.subject.secondary,
      compositionSummary: `${shot.intent.startFraming} → ${shot.intent.endFraming}`,
      motionIntentSummary: `${motion}，目标「${target}」；${shot.motion.motivation}；节奏：${shot.motion.envelope}`,
      displaySummary: `${expectedAssets.length} 张画面${expectedAssets.length ? `（${expectedAssets.map(asset => asset.role).join(' → ')}）` : ''}，渲染模式 ${shot.renderMode}${shot.reveal ? `；${(shot.reveal.atMs / 1000).toFixed(1)}s reveal「${targetLabel(input.pkg, shot.reveal.subjectId)}」` : ''}`,
      expectedAssets,
      textSummary: narration
        ? `预计显示解说字幕：「${narration}」；当前 Director 合约未声明额外字卡。`
        : '未声明解说字幕或额外字卡。',
      status: 'draft' as const,
    }
  })

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    planSource: input.planSource,
    directorCalls: input.directorCalls,
    inputFingerprint: input.inputFingerprint,
    overview: {
      shotCount: shots.length,
      totalDurationMs: Math.max(0, ...input.pkg.shots.map(shot => shot.endMs)),
      assetRequestCount: input.requests.length,
    },
    shots,
  }
}

export function renderPrecutDraftMarkdown(draft: PrecutDraft): string {
  const lines = [
    '# Dry Run Precut',
    '',
    '> 导演剪辑草案；尚未生成真实图片，也未经过 Vision、Grounding 或实际运镜验证。',
    '',
    `- 镜头总数：${draft.overview.shotCount}`,
    `- 预计总时长：${(draft.overview.totalDurationMs / 1000).toFixed(1)}s`,
    `- 预计图片数：${draft.overview.assetRequestCount}`,
    `- 本次 Director Calls：${draft.directorCalls}`,
    `- Plan 来源：${draft.planSource === 'dry-run-cache' ? '复用 dry-run plan' : '本次 Director 生成'}`,
    '- 状态：Draft',
    '',
  ]

  draft.shots.forEach((shot, index) => {
    const secondary = shot.secondarySubjects.length
      ? shot.secondarySubjects.map(subject => subject.label).join('、')
      : '无'
    const assets = shot.expectedAssets.length
      ? shot.expectedAssets.map(asset => `${asset.assetId}（${asset.role}，${asset.promptFile}）`).join('；')
      : '无'
    lines.push(
      `## ${index + 1}. ${shot.shotId} — ${(shot.durationMs / 1000).toFixed(1)}s`,
      '',
      `- 作用：${shot.purpose || '未标注'}`,
      `- 叙事：${shot.narrativeSummary || '无'}`,
      `- 主体：${shot.primarySubject.label}（${shot.primarySubject.type}）`,
      `- 辅助主体：${secondary}`,
      `- 构图：${shot.compositionSummary}`,
      `- 运镜意图：${shot.motionIntentSummary}`,
      `- 显示：${shot.displaySummary}`,
      `- 文字：${shot.textSummary}`,
      `- 生图 Prompt：${assets}`,
      '- 状态：Draft / 尚未经过真实素材验证',
      '',
    )
  })

  return lines.join('\n')
}

export function writePrecutDraft(input: {
  runDir: string
  pkg: DirectorPackage
  requests: AssetRequest[]
  planSource: PrecutDraft['planSource']
  directorCalls: number
  inputFingerprint: string
}): PrecutDraft {
  const draft = buildPrecutDraft(input)
  writeJson(path.join(input.runDir, 'precut-draft.json'), draft)
  fs.writeFileSync(path.join(input.runDir, 'precut-draft.md'), renderPrecutDraftMarkdown(draft))
  return draft
}
