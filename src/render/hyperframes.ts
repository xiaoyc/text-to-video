import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import type { PreviewProject } from '../domain/types.js'
import { preparePreviewProject, buildPreviewHtml } from '../preview/html.js'

export const HYPERFRAMES_VERSION = '0.8.57'

export interface HyperFramesRenderResult {
  outputPath: string
  projectDir: string
  planPath: string
  htmlPath: string
}

function runHyperFrames(projectDir: string, args: string[]): void {
  const command = process.platform === 'win32' ? 'npx.cmd' : 'npx'
  const result = spawnSync(command, ['--yes', `hyperframes@${HYPERFRAMES_VERSION}`, ...args], {
    cwd: projectDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.error) throw new Error(`HyperFrames failed to start: ${result.error.message}`)
  if (result.status !== 0) throw new Error(`HyperFrames ${args[0]} failed: ${String(result.stderr || result.stdout || '').slice(-3000)}`)
}

export function renderHyperFrames(input: {
  plan: PreviewProject
  outputDir: string
  outputPath?: string
  quality?: 'draft' | 'standard' | 'high'
  fps?: number
  gpu?: boolean
  runCheck?: boolean
}): HyperFramesRenderResult {
  const projectDir = path.join(input.outputDir, 'hyperframes-project')
  const prepared = preparePreviewProject(input.plan, projectDir)
  const planPath = path.join(projectDir, 'video-plan.json')
  const htmlPath = path.join(projectDir, 'index.html')
  fs.writeFileSync(planPath, JSON.stringify({ ...prepared, renderer: { hyperframes: HYPERFRAMES_VERSION } }, null, 2))
  fs.writeFileSync(htmlPath, buildPreviewHtml(prepared, false))
  runHyperFrames(projectDir, ['lint'])
  if (input.runCheck !== false) runHyperFrames(projectDir, ['check'])
  const outputPath = path.resolve(input.outputPath ?? path.join(input.outputDir, 'render.mp4'))
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })
  const args = ['render', '--output', outputPath, '--fps', String(input.fps ?? prepared.fps), '--quality', input.quality ?? 'high']
  if (input.gpu !== false) args.push('--gpu')
  runHyperFrames(projectDir, args)
  if (!fs.existsSync(outputPath)) throw new Error(`HyperFrames completed without output: ${outputPath}`)
  return { outputPath, projectDir, planPath, htmlPath }
}
