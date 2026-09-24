import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorFinding, DirectorPackage } from '../domain/types.js'
import type { TextModel } from '../director/single-pass.js'
import { runSinglePassDirector } from '../director/single-pass.js'
import { blockingFindings } from '../validation/director-validator.js'
import { compileAssetRequests } from '../assets/prompt-compiler.js'
import { createRunLogger, type RunLogger } from '../runtime/run-log.js'
import {
  ASSET_PROMPT_COMPILER_VERSION,
  DIRECTOR_CONTRACT_VERSION,
  hashJson,
  inputFingerprint,
  sha256,
} from '../runtime/input-fingerprint.js'
import { writeAssetPromptFiles, writeJson, readJson } from '../runtime/workspace.js'

export interface DryRunPlanState {
  version: 1
  mode: 'dry-run'
  inputFingerprint: string
  scriptHash: string
  style: string
  aspectRatio: string
  directorContractVersion: number
  promptCompilerVersion: number
  directorHash: string
  findingsHash: string
  assetRequestHash: string
  shotCount: number
  assetRequestCount: number
  generatedAt: string
}

export interface PreparedPlan {
  pkg: DirectorPackage
  findings: DirectorFinding[]
  requests: AssetRequest[]
  source: 'director' | 'dry-run-cache'
  inputFingerprint: string
  metrics: { llmCalls: number; repairCalls: number }
}

export interface PreparePlanOptions {
  script: string
  style: string
  aspectRatio: string
  outputDir: string
  textModel?: TextModel
  maxRepairs?: number
  forceDirector?: boolean
  saveDryRunCache?: boolean
  logger?: RunLogger
}

type CacheLookup =
  | { hit: true; plan: Omit<PreparedPlan, 'source' | 'metrics'> }
  | { hit: false; reason: string }

function cacheMissReason(state: DryRunPlanState, input: PreparePlanOptions): string | undefined {
  if (state.version !== 1) return 'unsupported plan cache version'
  if (state.mode !== 'dry-run') return 'plan manifest is not a dry-run plan'
  if (state.scriptHash !== sha256(input.script)) return 'script changed'
  if (state.style !== input.style) return 'style changed'
  if (state.aspectRatio !== input.aspectRatio) return 'aspect ratio changed'
  if (state.directorContractVersion !== DIRECTOR_CONTRACT_VERSION) return 'Director contract version changed'
  if (state.promptCompilerVersion !== ASSET_PROMPT_COMPILER_VERSION) return 'prompt compiler version changed'
  if (state.inputFingerprint !== inputFingerprint(input)) return 'input fingerprint changed'
  return undefined
}

function readReusablePlan(input: PreparePlanOptions): CacheLookup {
  const stateFile = path.join(input.outputDir, 'dry-run-state.json')
  if (!fs.existsSync(stateFile)) return { hit: false, reason: 'no dry-run plan' }

  try {
    const state = readJson<DryRunPlanState>(stateFile)
    const miss = cacheMissReason(state, input)
    if (miss) return { hit: false, reason: miss }

    const directorFile = path.join(input.outputDir, 'director.json')
    const findingsFile = path.join(input.outputDir, 'director-findings.json')
    const requestsFile = path.join(input.outputDir, 'asset-requests.json')
    const promptsDir = path.join(input.outputDir, 'prompts')
    for (const [label, file] of [
      ['director.json', directorFile],
      ['director-findings.json', findingsFile],
      ['asset-requests.json', requestsFile],
    ] as const) {
      if (!fs.existsSync(file)) return { hit: false, reason: `${label} is missing` }
    }
    if (!fs.existsSync(promptsDir) || !fs.statSync(promptsDir).isDirectory()) {
      return { hit: false, reason: 'prompts directory is missing' }
    }

    const pkg = readJson<DirectorPackage>(directorFile)
    const findings = readJson<DirectorFinding[]>(findingsFile)
    const requests = readJson<AssetRequest[]>(requestsFile)
    if (pkg.script !== input.script || pkg.style !== input.style || pkg.aspectRatio !== input.aspectRatio) {
      return { hit: false, reason: 'Director plan inputs do not match the requested inputs' }
    }
    if (state.directorHash !== hashJson(pkg)) return { hit: false, reason: 'director.json changed since dry run' }
    if (state.findingsHash !== hashJson(findings)) return { hit: false, reason: 'director-findings.json changed since dry run' }
    if (state.assetRequestHash !== hashJson(requests)) return { hit: false, reason: 'asset-requests.json changed since dry run' }
    if (state.shotCount !== pkg.shots.length || state.assetRequestCount !== requests.length) {
      return { hit: false, reason: 'cached plan counts do not match plan artifacts' }
    }
    if (hashJson(compileAssetRequests(pkg)) !== hashJson(requests)) {
      return { hit: false, reason: 'asset requests do not match the cached Director plan' }
    }
    for (const request of requests) {
      if (!fs.existsSync(path.join(promptsDir, `${request.assetId}.md`))) {
        return { hit: false, reason: `prompt file is missing for ${request.assetId}` }
      }
    }

    return {
      hit: true,
      plan: { pkg, findings, requests, inputFingerprint: state.inputFingerprint },
    }
  } catch (error) {
    return {
      hit: false,
      reason: `plan cache is invalid: ${error instanceof Error ? error.message : String(error)}`,
    }
  }
}

function saveDryRunState(input: {
  options: PreparePlanOptions
  plan: PreparedPlan
}): DryRunPlanState {
  const state: DryRunPlanState = {
    version: 1,
    mode: 'dry-run',
    inputFingerprint: input.plan.inputFingerprint,
    scriptHash: sha256(input.options.script),
    style: input.options.style,
    aspectRatio: input.options.aspectRatio,
    directorContractVersion: DIRECTOR_CONTRACT_VERSION,
    promptCompilerVersion: ASSET_PROMPT_COMPILER_VERSION,
    directorHash: hashJson(input.plan.pkg),
    findingsHash: hashJson(input.plan.findings),
    assetRequestHash: hashJson(input.plan.requests),
    shotCount: input.plan.pkg.shots.length,
    assetRequestCount: input.plan.requests.length,
    generatedAt: new Date().toISOString(),
  }
  writeJson(path.join(input.options.outputDir, 'dry-run-state.json'), state)
  return state
}

export async function preparePlan(options: PreparePlanOptions): Promise<PreparedPlan> {
  const logger = options.logger ?? createRunLogger(options.outputDir)
  const fingerprint = inputFingerprint(options)

  if (options.forceDirector) {
    logger.emit({ stage: 'plan', type: 'plan.cache-bypass', message: 'Director regeneration forced by request' })
  } else {
    const cached = readReusablePlan(options)
    if (cached.hit) {
      logger.emit({ stage: 'plan', type: 'plan.cache-hit', message: 'dry-run cache hit' })
      logger.emit({ stage: 'director', type: 'director.plan-reused', message: 'reused cached director plan' })
      logger.emit({ stage: 'prompt', type: 'prompt.plan-reused', message: 'reused cached asset requests' })
      return {
        ...cached.plan,
        source: 'dry-run-cache',
        metrics: { llmCalls: 0, repairCalls: 0 },
      }
    }
    logger.emit({ stage: 'plan', type: 'plan.cache-miss', message: `dry-run cache miss: ${cached.reason}` })
  }

  if (!options.textModel) {
    throw new Error('no reusable dry-run plan is available; provide --text-command or --director-json to create one')
  }

  const director = await runSinglePassDirector(options.textModel, {
    script: options.script,
    style: options.style,
    aspectRatio: options.aspectRatio,
  }, { maxRepairs: options.maxRepairs ?? 1 })
  const blocking = blockingFindings(director.findings)
  writeJson(path.join(options.outputDir, 'director.json'), director.package)
  writeJson(path.join(options.outputDir, 'director-findings.json'), director.findings)
  logger.emit({
    stage: 'director', type: 'director.complete', message: `director produced ${director.package.shots.length} shots`,
    data: {
      llmCalls: director.metrics.llmCalls,
      repairCalls: director.metrics.repairCalls,
      blockingFindings: blocking.length,
      warningFindings: director.findings.filter(item => item.severity === 'warning').length,
    },
  })
  if (blocking.length) {
    logger.emit({ stage: 'director', type: 'director.blocked', message: 'blocking validation findings remain', data: { issues: blocking.map(item => item.issue) } })
    throw new Error(`Director validation failed after bounded repair: ${blocking.map(item => item.issue).join('; ')}`)
  }

  const requests = compileAssetRequests(director.package)
  writeJson(path.join(options.outputDir, 'asset-requests.json'), requests)
  writeAssetPromptFiles(options.outputDir, requests)
  logger.emit({ stage: 'prompt', type: 'prompt.compiled', message: `compiled ${requests.length} deterministic image prompts` })

  const plan: PreparedPlan = {
    pkg: director.package,
    findings: director.findings,
    requests,
    source: 'director',
    inputFingerprint: fingerprint,
    metrics: director.metrics,
  }
  if (options.saveDryRunCache) saveDryRunState({ options, plan })
  return plan
}
