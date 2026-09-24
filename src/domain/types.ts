export type SubjectType = 'character' | 'object' | 'landmark' | 'relationship' | 'space'
export type SubjectDominance = 'low' | 'medium' | 'high'
export type Placement = 'center' | 'left-third' | 'right-third' | 'lower-third' | 'upper-third' | 'environmental'
export type MotionType = 'static' | 'push-in' | 'pull-out' | 'pan-left' | 'pan-right' | 'tracking' | 'arc' | 'crane-up' | 'crane-down'
export type MotionIntensity = 'subtle' | 'medium' | 'strong'
export type RenderMode = '2d' | '2.5d' | '3d' | 'hybrid'
export type BeatType = 'hook' | 'setup' | 'tension' | 'suspense' | 'contrast' | 'reveal' | 'turn' | 'emotion-peak' | 'aftermath' | 'transition'
export type ShotTemplateId =
  | 'historical-still'
  | 'low-angle-reveal'
  | 'portrait-identity'
  | 'relationship-reveal'
  | 'document-insert'
  | 'character-card'
  | 'citation-card'
  | 'chapter-card'
  | 'micro-action'
export type MotionEnvelope =
  | 'steady'
  | 'punch-in'
  | 'reveal-accelerate-settle'
  | 'slow-build-payoff'
  | 'float-observe'
  | 'whip-settle'
  | 'orbit-reveal'
  | 'crane-discovery'
  | 'map-dive'
export type AttentionGoal = 'interrupt' | 'curiosity' | 'partial-payoff' | 'context' | 'escalate' | 'contrast' | 'reveal' | 'emotion' | 'breath'
export type VisualEventType =
  | 'internal-beat'
  | 'overlay-enter'
  | 'overlay-update'
  | 'asset-state-change'
  | 'reveal'
  | 'camera-phase'
  | 'diagram-update'
  | 'deliberate-breath'
export type VisualImpact = 'structural' | 'informational' | 'decorative'
export type OverlayType = 'emphasis-word' | 'identity' | 'explanation' | 'citation' | 'chapter-label'

export interface VisualEvent {
  atMs: number
  type: VisualEventType
  impact: VisualImpact
  purpose: string
}

export interface OverlayPlan {
  type: OverlayType
  text: string
  atMs: number
  endMs?: number
  purpose?: string
}

export interface Point {
  x: number
  y: number
}

export interface NormalizedBox extends Point {
  width: number
  height: number
}

export interface NarrativeBeat {
  beatId: string
  text: string
  purpose: string
  importance: 'low' | 'medium' | 'high'
  type?: BeatType
}

export interface AttentionPlan {
  attentionQuestion: string
  hookWindowMs: number
  strategy: string
  withheldSubjectIds: string[]
  patternInterrupt?: {
    type: string
    description: string
  }
  payoff?: {
    targetBeatId: string
    description: string
  }
  curve?: Array<{
    beatId: string
    goal: AttentionGoal
    energy: number
    reason: string
  }>
}

export interface CharacterDesign {
  characterId: string
  canonicalDescription: string
  looks: string[]
}

export interface ProjectBible {
  historicalContext: string
  visualStyle: string
  forbiddenElements: string[]
  characters: CharacterDesign[]
}

export interface TtsBeatHint {
  beatId: string
  emphasisWords: string[]
  pauseAfter?: string[]
}

export interface SubjectRef {
  id: string
  label: string
  type: SubjectType
  narrativeRole?: string
}

export interface ShotSubject {
  primary: SubjectRef
  secondary: SubjectRef[]
  mustKeepVisible: string[]
  mayLeaveFrame: string[]
}

export interface ShotIntent {
  narrativeGoal: string
  cameraTask: string
  startFraming: string
  endFraming: string
  subjectDominance: SubjectDominance
  preferredPlacement?: Placement
}

export interface CreativeMotionIntent {
  type: MotionType
  targetSubjectId: string
  intensity: MotionIntensity
  motivation: string
  envelope: string
}

export interface AssetState {
  role: string
  state: string
  composition: string
  visibleSubjectIds: string[]
  hiddenSubjectIds: string[]
}

export interface DirectorShot {
  shotId: string
  beatId: string
  narrationText: string
  startMs: number
  endMs: number
  durationMs: number
  subject: ShotSubject
  intent: ShotIntent
  motion: CreativeMotionIntent
  shotTemplateId?: ShotTemplateId
  motionEnvelope?: MotionEnvelope
  visualEvents?: VisualEvent[]
  overlays?: OverlayPlan[]
  assetStates: AssetState[]
  internalBeatsMs: number[]
  renderMode: RenderMode
  rawVisualDescription: string
  reveal?: {
    subjectId: string
    atMs: number
  }
}

export interface DirectorPackage {
  version: 1
  script: string
  style: string
  aspectRatio: string
  narrative: {
    beats: NarrativeBeat[]
  }
  attention: AttentionPlan
  bible: ProjectBible
  ttsHints: TtsBeatHint[]
  shots: DirectorShot[]
}

export type FindingSeverity = 'warning' | 'blocking'
export type FindingCategory =
  | 'schema'
  | 'hook'
  | 'camera'
  | 'visual-rhythm'
  | 'asset-state'
  | 'identity'
  | 'spatial'
  | 'repair'

export interface DirectorFinding {
  severity: FindingSeverity
  category: FindingCategory
  issue: string
  shotId?: string
  evidence?: string
  suggestedDirection?: string
}

export interface AssetRequest {
  assetId: string
  shotId: string
  role: string
  primarySubjectId: string
  prompt: string
  negativePrompt: string
  visibleSubjectIds: string[]
  hiddenSubjectIds: string[]
}

export interface GroundedSubject {
  subjectId: string
  detected: boolean
  bbox: NormalizedBox
  center: Point
  confidence: number
}

export interface AssetGrounding {
  assetId: string
  shotId: string
  primary: GroundedSubject
  secondary: GroundedSubject[]
  safeCrop: {
    maxScale: number
    recommendedFocusCenter: Point
  }
}

export interface VisionReviewResult {
  accepted: boolean
  score: number
  reasons: string[]
  retryHints: string[]
  grounding: AssetGrounding
}

export interface MotionKeyframe {
  atMs: number
  focus: Point
  scale: number
}

export interface ResolvedMotion {
  shotId: string
  targetSubjectId: string
  compatible: boolean
  keyframes: MotionKeyframe[]
  adjustments: string[]
  warnings: string[]
}


export interface GeneratedAsset {
  assetId: string
  shotId: string
  role: string
  imagePath: string
  provider: string
}

export interface TtsCue {
  beatId: string
  text: string
  audioPath: string
  startMs: number
  endMs: number
  durationMs: number
}

export interface PreviewScene {
  shotId: string
  startMs: number
  durationMs: number
  renderMode: RenderMode
  narrationText: string
  assetIds: string[]
  switchAtMs: number[]
  motion: ResolvedMotion
}

export interface PreviewProject {
  compositionId: string
  width: number
  height: number
  fps: number
  durationMs: number
  scenes: PreviewScene[]
  assets: GeneratedAsset[]
  audio: TtsCue[]
}

export interface RunMetrics {
  director: {
    llmCalls: number
    repairCalls: number
    durationMs: number
  }
  validation: {
    blockingFindings: number
    warningFindings: number
  }
  assets: {
    count: number
  }
  vision: {
    calls: number
    accepted: number
  }
  preview: {
    rebuiltShots: string[]
  }
}
