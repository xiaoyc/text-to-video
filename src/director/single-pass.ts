import type { DirectorFinding, DirectorPackage } from '../domain/types.js'
import { blockingFindings, validateDirectorPackage } from '../validation/director-validator.js'
import { directorPlaybookPrompt } from './playbook.js'

export interface TextModel {
  completeJson<T>(input: {
    system: string
    prompt: string
  }): Promise<T>
}

export interface DirectorInput {
  script: string
  style: string
  aspectRatio: string
}

export interface DirectorRunResult {
  package: DirectorPackage
  findings: DirectorFinding[]
  metrics: {
    llmCalls: number
    repairCalls: number
  }
}

const CONTRACT = `
Return exactly one JSON object with this shape:

{
  "version": 1,
  "script": "<original script>",
  "style": "<requested style>",
  "aspectRatio": "<requested aspect ratio>",
  "narrative": {
    "beats": [
      {
        "beatId": "beat-001",
        "text": "...",
        "purpose": "...",
        "importance": "low|medium|high",
        "type": "hook|setup|tension|suspense|contrast|reveal|turn|emotion-peak|aftermath|transition"
      }
    ]
  },
  "attention": {
    "attentionQuestion": "...",
    "hookWindowMs": 8000,
    "strategy": "...",
    "withheldSubjectIds": [],
    "patternInterrupt": { "type": "...", "description": "..." },
    "payoff": { "targetBeatId": "beat-...", "description": "..." },
    "curve": [
      { "beatId": "beat-001", "goal": "interrupt|curiosity|partial-payoff|context|escalate|contrast|reveal|emotion|breath", "energy": 0.9, "reason": "..." }
    ]
  },
  "bible": {
    "historicalContext": "...",
    "visualStyle": "...",
    "forbiddenElements": [],
    "characters": [
      {
        "characterId": "...",
        "canonicalDescription": "...",
        "looks": []
      }
    ]
  },
  "ttsHints": [
    {
      "beatId": "beat-001",
      "emphasisWords": [],
      "pauseAfter": []
    }
  ],
  "shots": [
    {
      "shotId": "shot-001",
      "beatId": "beat-001",
      "narrationText": "...",
      "startMs": 0,
      "endMs": 3000,
      "durationMs": 3000,
      "subject": {
        "primary": {
          "id": "...",
          "label": "...",
          "type": "character|object|landmark|relationship|space",
          "narrativeRole": "..."
        },
        "secondary": [],
        "mustKeepVisible": [],
        "mayLeaveFrame": []
      },
      "intent": {
        "narrativeGoal": "...",
        "cameraTask": "...",
        "startFraming": "...",
        "endFraming": "...",
        "subjectDominance": "low|medium|high",
        "preferredPlacement": "center|left-third|right-third|lower-third|upper-third|environmental"
      },
      "motion": {
        "type": "static|push-in|pull-out|pan-left|pan-right|tracking|arc|crane-up|crane-down",
        "targetSubjectId": "...",
        "intensity": "subtle|medium|strong",
        "motivation": "...",
        "envelope": "..."
      },
      "shotTemplateId": "historical-still|low-angle-reveal|portrait-identity|relationship-reveal|document-insert|character-card|citation-card|chapter-card|micro-action",
      "motionEnvelope": "steady|punch-in|reveal-accelerate-settle|slow-build-payoff|float-observe|whip-settle|orbit-reveal|crane-discovery|map-dive",
      "visualEvents": [
        { "atMs": 1800, "type": "internal-beat|overlay-enter|overlay-update|asset-state-change|reveal|camera-phase|diagram-update|deliberate-breath", "impact": "structural|informational|decorative", "purpose": "..." }
      ],
      "overlays": [
        { "type": "emphasis-word|identity|explanation|citation|chapter-label", "text": "...", "atMs": 1200, "endMs": 3200, "purpose": "..." }
      ],
      "assetStates": [
        {
          "role": "primary|before|after|contact|...",
          "state": "one fixed visual moment only",
          "composition": "...",
          "visibleSubjectIds": [],
          "hiddenSubjectIds": []
        }
      ],
      "internalBeatsMs": [],
      "renderMode": "2d|2.5d|3d|hybrid",
      "rawVisualDescription": "...",
      "reveal": {
        "subjectId": "...",
        "atMs": 1800
      }
    }
  ]
}

Rules:
- Omit "reveal" when the shot has no reveal.
- Every shot has exactly one primary subject.
- motion.targetSubjectId must reference the primary or a declared secondary subject.
- startMs/endMs/durationMs must be internally consistent and shots must form a sensible estimated timeline.
- Do not split shots mechanically at every sentence. A shot may cover multiple phrases when visual progression remains meaningful.
- A long shot must contain a meaningful internal beat, reveal, or asset-state change; decorative camera movement alone is not new information.
- assetStates describe fixed moments. Never merge before/after handoff states into one still image.
- Hidden reveal subjects must stay hidden in before states.
- Use relationship as a subject when the visual point is the relationship between people/objects, and space when the overall spatial layout is the subject.
- Camera motion is creative intent only. Never invent normalized coordinates, pixels, bounding boxes, or exact crop values before the image exists.
- Do not write final image-generation prompts.
- Narrative beats must preserve the whole article in order; do not silently omit sections just to reduce shot count.
- The first 5-12 seconds should create a source-supported attention question and partial payoff before settling into context.
- A normal image-first shot must not leave viewers without meaningful new visual information for tens of seconds. Split long visual ideas or author timed visualEvents/overlays/reveals.
- assetStates without timing do not by themselves justify an arbitrarily long shot.
`.trim()

const SYSTEM = [
  'You are the single creative director for a narrative-to-video engine.',
  'Make the narrative, hook, project bible, shot, visual-subject, framing, asset-state, and creative-camera decisions in one coherent pass.',
  'Do not delegate those decisions to other agents.',
  'Preserve historical/visual continuity and delay reveals exactly when the narrative requires it.',
  'Every camera move must serve the declared shot subject and narrative goal.',
  directorPlaybookPrompt(),
  CONTRACT,
].join('\n\n')

export async function planDirectorPackage(model: TextModel, input: DirectorInput): Promise<DirectorPackage> {
  return model.completeJson<DirectorPackage>({
    system: SYSTEM,
    prompt: [
      `SCRIPT:\n${input.script}`,
      `REQUESTED STYLE: ${input.style}`,
      `ASPECT RATIO: ${input.aspectRatio}`,
      'Return JSON only. The script field must preserve the supplied script exactly.',
    ].join('\n\n'),
  })
}

export async function repairDirectorPackage(
  model: TextModel,
  pkg: DirectorPackage,
  findings: DirectorFinding[],
): Promise<DirectorPackage> {
  return model.completeJson<DirectorPackage>({
    system: [
      SYSTEM,
      'This is the only repair pass.',
      'Preserve all valid creative decisions and stable IDs.',
      'Fix every blocking finding together instead of solving one category at a time.',
      'Do not redesign unrelated shots.',
    ].join('\n\n'),
    prompt: JSON.stringify({
      task: 'repair-director-package',
      directorPackage: pkg,
      findings,
    }),
  })
}

function inputContractFindings(pkg: DirectorPackage, input: DirectorInput): DirectorFinding[] {
  const findings: DirectorFinding[] = []
  if (pkg.script !== input.script) findings.push({ severity: 'blocking', category: 'schema', issue: 'Director changed the source script' })
  if (pkg.style !== input.style) findings.push({ severity: 'blocking', category: 'schema', issue: 'Director changed the requested style' })
  if (pkg.aspectRatio !== input.aspectRatio) findings.push({ severity: 'blocking', category: 'schema', issue: 'Director changed the requested aspect ratio' })
  return findings
}

function repairPreservationFindings(
  before: DirectorPackage,
  after: DirectorPackage,
  initialFindings: DirectorFinding[],
): DirectorFinding[] {
  const findings: DirectorFinding[] = []
  const affectedShotIds = new Set(blockingFindings(initialFindings).flatMap(item => item.shotId ? [item.shotId] : []))
  const affectedBeatIds = new Set(before.shots.filter(shot => affectedShotIds.has(shot.shotId)).map(shot => shot.beatId))
  const afterBeatIds = new Set(after.narrative.beats.map(beat => beat.beatId))
  const afterShots = new Map(after.shots.map(shot => [shot.shotId, shot]))

  for (const beat of before.narrative.beats) {
    if (!afterBeatIds.has(beat.beatId)) {
      findings.push({ severity: 'blocking', category: 'repair', issue: `repair removed narrative beat ${beat.beatId}` })
    }
  }
  for (const shot of before.shots) {
    if (affectedBeatIds.has(shot.beatId)) continue
    const repaired = afterShots.get(shot.shotId)
    if (!repaired) {
      findings.push({
        severity: 'blocking',
        category: 'repair',
        issue: `repair removed unaffected shot ${shot.shotId}`,
        shotId: shot.shotId,
        suggestedDirection: 'Preserve unaffected shots and repair only the beats implicated by blocking findings.',
      })
    } else if (repaired.beatId !== shot.beatId) {
      findings.push({
        severity: 'blocking',
        category: 'repair',
        issue: `repair reassigned unaffected shot ${shot.shotId} from ${shot.beatId} to ${repaired.beatId}`,
        shotId: shot.shotId,
      })
    }
  }
  return findings
}

export async function runSinglePassDirector(
  model: TextModel,
  input: DirectorInput,
  options: { maxRepairs?: number } = {},
): Promise<DirectorRunResult> {
  let llmCalls = 1
  let repairCalls = 0
  let pkg = await planDirectorPackage(model, input)
  let findings = [...validateDirectorPackage(pkg), ...inputContractFindings(pkg, input)]

  if (blockingFindings(findings).length && (options.maxRepairs ?? 1) > 0) {
    const beforeRepair = pkg
    const beforeFindings = findings
    pkg = await repairDirectorPackage(model, pkg, findings)
    llmCalls += 1
    repairCalls += 1
    findings = [
      ...validateDirectorPackage(pkg),
      ...inputContractFindings(pkg, input),
      ...repairPreservationFindings(beforeRepair, pkg, beforeFindings),
    ]
  }

  return {
    package: pkg,
    findings,
    metrics: { llmCalls, repairCalls },
  }
}
