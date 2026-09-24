import type { DirectorFinding, DirectorPackage } from '../domain/types.js'
import { blockingFindings, validateDirectorPackage } from '../validation/director-validator.js'

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
        "importance": "low|medium|high"
      }
    ]
  },
  "attention": {
    "attentionQuestion": "...",
    "hookWindowMs": 8000,
    "strategy": "...",
    "withheldSubjectIds": []
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
`.trim()

const SYSTEM = [
  'You are the single creative director for a narrative-to-video engine.',
  'Make the narrative, hook, project bible, shot, visual-subject, framing, asset-state, and creative-camera decisions in one coherent pass.',
  'Do not delegate those decisions to other agents.',
  'Preserve historical/visual continuity and delay reveals exactly when the narrative requires it.',
  'Every camera move must serve the declared shot subject and narrative goal.',
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

export async function runSinglePassDirector(
  model: TextModel,
  input: DirectorInput,
  options: { maxRepairs?: number } = {},
): Promise<DirectorRunResult> {
  let llmCalls = 1
  let repairCalls = 0
  let pkg = await planDirectorPackage(model, input)
  let findings = validateDirectorPackage(pkg)

  if (blockingFindings(findings).length && (options.maxRepairs ?? 1) > 0) {
    pkg = await repairDirectorPackage(model, pkg, findings)
    llmCalls += 1
    repairCalls += 1
    findings = validateDirectorPackage(pkg)
  }

  return {
    package: pkg,
    findings,
    metrics: { llmCalls, repairCalls },
  }
}
