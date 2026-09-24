import crypto from 'node:crypto'

// Bump these when the Director output contract or deterministic prompt compilation changes.
export const DIRECTOR_CONTRACT_VERSION = 2
export const ASSET_PROMPT_COMPILER_VERSION = 1

export interface PlanInputFingerprint {
  script: string
  style: string
  aspectRatio: string
}

export function sha256(value: string | Buffer): string {
  return `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`
}

export function hashJson(value: unknown): string {
  return sha256(JSON.stringify(value))
}

export function inputFingerprint(input: PlanInputFingerprint): string {
  return hashJson({
    script: input.script,
    style: input.style,
    aspectRatio: input.aspectRatio,
    directorContractVersion: DIRECTOR_CONTRACT_VERSION,
    promptCompilerVersion: ASSET_PROMPT_COMPILER_VERSION,
  })
}
