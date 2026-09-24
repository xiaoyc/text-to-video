import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorPackage, SubjectRef } from '../domain/types.js'
import { writeJson } from '../runtime/workspace.js'
import { assessVisualRhythm } from '../validation/visual-rhythm.js'

export interface PrecutDraftShot {
  shotId: string
  beatId: string
  purpose: string
  beatType?: string
  durationMs: number
  shotTemplateId?: string
  motionEnvelope?: string
  narrativeSummary: string
  primarySubject: SubjectRef
  secondarySubjects: SubjectRef[]
  compositionSummary: string
  motionIntentSummary: string
  displaySummary: string
  expectedAssets: Array<{ assetId: string; role: string; promptFile: string }>
  textSummary: string
  visualEventsSummary: string[]
  overlaySummary: string[]
  visualRhythm: {
    longestIdleMs: number
    maxIdleMs: number
    passed: boolean
    coverageReason: string
  }
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
    const rhythm = assessVisualRhythm(shot)
    const overlays = (shot.overlays ?? []).map(item => {
      const end = item.endMs !== undefined ? `-${(item.endMs / 1000).toFixed(1)}s` : ''
      return `${item.type} @ ${(item.atMs / 1000).toFixed(1)}s${end}: ${item.text}`
    })
    const visualEvents = rhythm.events
      .filter(item => item.source !== 'shot-start' && item.source !== 'shot-end')
      .map(item => `${(item.atMs / 1000).toFixed(1)}s ${item.type}/${item.impact}: ${item.purpose}`)
    return {
      shotId: shot.shotId,
      beatId: shot.beatId,
      purpose: beat?.purpose ?? '',
      ...(beat?.type ? { beatType: beat.type } : {}),
      durationMs: shot.durationMs,
      ...(shot.shotTemplateId ? { shotTemplateId: shot.shotTemplateId } : {}),
      ...(shot.motionEnvelope ? { motionEnvelope: shot.motionEnvelope } : {}),
      narrativeSummary: narration,
      primarySubject: shot.subject.primary,
      secondarySubjects: shot.subject.secondary,
      compositionSummary: `${shot.intent.startFraming} → ${shot.intent.endFraming}`,
      motionIntentSummary: `${motion}，目标「${target}」；${shot.motion.motivation}；节奏：${shot.motion.envelope}`,
      displaySummary: `${expectedAssets.length} 张画面${expectedAssets.length ? `（${expectedAssets.map(asset => asset.role).join(' → ')}）` : ''}，渲染模式 ${shot.renderMode}${shot.reveal ? `；${(shot.reveal.atMs / 1000).toFixed(1)}s reveal「${targetLabel(input.pkg, shot.reveal.subjectId)}」` : ''}`,
      expectedAssets,
      textSummary: narration
        ? `预计显示解说字幕：「${narration}」${overlays.length ? `；额外文字 ${overlays.length} 条。` : '；无额外字卡。'}`
        : overlays.length ? `无解说字幕；额外文字 ${overlays.length} 条。` : '未声明解说字幕或额外字卡。',
      visualEventsSummary: visualEvents,
      overlaySummary: overlays,
      visualRhythm: {
        longestIdleMs: rhythm.longestIdleMs,
        maxIdleMs: rhythm.maxIdleMs,
        passed: rhythm.passed,
        coverageReason: rhythm.coverageReason,
      },
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
      `- Beat 类型：${shot.beatType || '未标注'}`,
      `- 镜头模板：${shot.shotTemplateId || '未标注'}`,
      `- 叙事：${shot.narrativeSummary || '无'}`,
      `- 主体：${shot.primarySubject.label}（${shot.primarySubject.type}）`,
      `- 辅助主体：${secondary}`,
      `- 构图：${shot.compositionSummary}`,
      `- 运镜意图：${shot.motionIntentSummary}${shot.motionEnvelope ? `；节奏包络：${shot.motionEnvelope}` : ''}`,
      `- 显示：${shot.displaySummary}`,
      `- 视觉事件：${shot.visualEventsSummary.length ? shot.visualEventsSummary.join('；') : '无额外内部事件'}`,
      `- 文字：${shot.textSummary}`,
      `- 额外文字：${shot.overlaySummary.length ? shot.overlaySummary.join('；') : '无'}`,
      `- 视觉空窗：${(shot.visualRhythm.longestIdleMs / 1000).toFixed(1)}s / 预算 ${(shot.visualRhythm.maxIdleMs / 1000).toFixed(1)}s · ${shot.visualRhythm.passed ? 'PASS' : 'FAIL'}`,
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
