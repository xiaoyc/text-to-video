import type { BeatType, MotionEnvelope, ShotTemplateId } from '../domain/types.js'

export const BEAT_TYPES: readonly BeatType[] = [
  'hook', 'setup', 'tension', 'suspense', 'contrast',
  'reveal', 'turn', 'emotion-peak', 'aftermath', 'transition',
]

export const MOTION_ENVELOPES: readonly MotionEnvelope[] = [
  'steady',
  'punch-in',
  'reveal-accelerate-settle',
  'slow-build-payoff',
  'float-observe',
  'whip-settle',
  'orbit-reveal',
  'crane-discovery',
  'map-dive',
]

export const SHOT_TEMPLATE_CATALOG: ReadonlyArray<{ id: ShotTemplateId; description: string }> = [
  { id: 'historical-still', description: '普通历史场景/人物；克制静帧或微运动，画面负责情绪或证据。' },
  { id: 'low-angle-reveal', description: '从异常局部/低机位逐步揭示主体或空间，适合冷开场。' },
  { id: 'portrait-identity', description: '人物首次露脸、身份/职位介绍；身份稳定优先。' },
  { id: 'relationship-reveal', description: '先隔离主体，再通过空间/匹配状态揭示人物关系。' },
  { id: 'document-insert', description: '文书、器物、证据特写；用于 inspect / clue / proof。' },
  { id: 'character-card', description: '人物档案/身份信息卡；允许较长阅读停留。' },
  { id: 'citation-card', description: '史料引用/制度证据卡；阅读稳定性优先。' },
  { id: 'chapter-card', description: '章节或时空转换；短标题配环境建立。' },
  { id: 'micro-action', description: '递物、抬眼、转身等明确前后状态；动作完整性优先。' },
]

export const READABLE_SHOT_TEMPLATES = new Set<ShotTemplateId>([
  'character-card',
  'citation-card',
  'chapter-card',
])

export function directorPlaybookPrompt(): string {
  return [
    'DIRECTOR PLAYBOOK:',
    'Narrative beats are semantic units, not punctuation cuts. A beat may produce 1..N shots.',
    'Beat types: ' + BEAT_TYPES.join(', ') + '.',
    'The opening 5-12 seconds must be source-driven: create a real pattern interrupt/curiosity question and a partial payoff from facts already in the script. Do not invent clickbait.',
    'Useful hook strategies include unusual object/detail, visual contradiction, before/after, identity withholding, spatial reveal, scale change and value reversal.',
    'Do not interpret "do not cut every sentence" as "use very few shots". Image-first video still needs continuing visual information.',
    'Normal non-card shots should usually deliver a meaningful structural/informational visual change within about 5 seconds. If narration is longer, split the visual idea or plan internal events/overlays/reveals.',
    'Decorative movement such as dust, weak particles, ambient light or a tiny continuous push does not count as new information.',
    'Choose shotTemplateId from: ' + SHOT_TEMPLATE_CATALOG.map(item => item.id).join(', ') + '.',
    'Templates are candidate directing grammar, not keyword mappings. Choose from narrative intent.',
    'Use visualEvents for source-driven structural/informational changes. Mark decorative-only events as decorative.',
    'Use overlays for emphasis/identity/explanation/citation/chapter text. Never bake those words into image prompts.',
    'Use motionEnvelope to describe pacing/energy; the resolver owns numeric implementation.',
    'Shots must form one contiguous estimated timeline starting at 0 with no gaps/overlaps, and every NarrativeBeat must be covered by at least one shot.',
    'Repair must preserve unaffected beats and unaffected shot IDs. Never solve one invalid shot by silently deleting unrelated valid shots.',
  ].join('\n')
}
