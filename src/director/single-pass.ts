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

const SYSTEM = [
  'You are the single creative director for a narrative-to-video engine.',
  'Return one complete DirectorPackage JSON object. Do not delegate narrative, hook, bible, shot, prompt, or camera planning to other agents.',
  'Every shot must have exactly one primary subject and a camera intent centered on that subject or declared relationship/space.',
  'Author creative camera intent, never exact image pixels; image coordinates do not exist until after generation.',
  'Do not write final image prompts. Structured shot intent is the source of truth.',
  'Avoid long visual idle windows. Preserve reveal timing and hidden subjects through asset states.',
].join('\n')

export async function planDirectorPackage(model: TextModel, input: DirectorInput): Promise<DirectorPackage> {
  return model.completeJson<DirectorPackage>({
    system: SYSTEM,
    prompt: [
      `Script:\n${input.script}`,
      `Style: ${input.style}`,
      `Aspect ratio: ${input.aspectRatio}`,
      'Return DirectorPackage version 1 with narrative beats, attention plan, project bible, TTS hints, and executable shots.',
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
      'Repair the existing DirectorPackage once. Preserve valid creative decisions and stable IDs whenever possible.',
      'Fix every blocking finding together. Do not introduce an independent new concept unless required by the findings.',
    ].join('\n'),
    prompt: JSON.stringify({
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
