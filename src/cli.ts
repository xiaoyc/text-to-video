#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import type { DirectorPackage, GeneratedAsset, ResolvedMotion, TtsCue, VisionReviewResult } from './domain/types.js'
import type { TextModel } from './director/single-pass.js'
import { runPipeline } from './pipeline/run.js'
import { CommandTextModel } from './providers/text-command.js'
import { CommandImageProvider } from './providers/image.js'
import { CommandVisionProvider } from './providers/vision-command.js'
import { CommandTtsProvider } from './providers/tts.js'
import { buildPreviewProject } from './preview/project.js'
import { writePreview } from './preview/html.js'
import { renderHyperFrames } from './render/hyperframes.js'
import { readJson } from './runtime/workspace.js'

function args(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {}
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (!token?.startsWith('--')) continue
    const key = token.slice(2)
    const next = argv[i + 1]
    if (!next || next.startsWith('--')) out[key] = true
    else { out[key] = next; i++ }
  }
  return out
}

class FileTextModel implements TextModel {
  constructor(private readonly file: string) {}
  async completeJson<T>(): Promise<T> {
    return readJson<T>(this.file)
  }
}

async function main() {
  const [command = 'help', ...rest] = process.argv.slice(2)
  const opts = args(rest)

  if (command === 'run') {
    const scriptPath = String(opts.script ?? '')
    const outputDir = path.resolve(String(opts.out ?? 'data/run'))
    if (!scriptPath) throw new Error('--script is required')
    const script = fs.readFileSync(scriptPath, 'utf8')
    const directorJson = opts['director-json'] ? String(opts['director-json']) : undefined
    const textCommand = opts['text-command'] ? String(opts['text-command']) : process.env.TEXT_TO_VIDEO_TEXT_COMMAND
    if (!directorJson && !textCommand) throw new Error('use --director-json <file> or --text-command <command>')
    const textModel: TextModel = directorJson ? new FileTextModel(directorJson) : new CommandTextModel(textCommand!)
    const reviews = opts['vision-json'] ? readJson<VisionReviewResult[]>(String(opts['vision-json'])) : undefined
    const imageCommand = opts['image-command'] ? String(opts['image-command']) : process.env.TEXT_TO_VIDEO_IMAGE_COMMAND
    const visionCommand = opts['vision-command'] ? String(opts['vision-command']) : process.env.TEXT_TO_VIDEO_VISION_COMMAND
    const ttsCommand = opts['tts-command'] ? String(opts['tts-command']) : process.env.TEXT_TO_VIDEO_TTS_COMMAND
    const result = await runPipeline({
      script,
      style: String(opts.style ?? 'cinematic historical realism'),
      aspectRatio: String(opts['aspect-ratio'] ?? '16:9'),
      outputDir,
      textModel,
      ...(opts['images-dir'] ? { imagesDir: String(opts['images-dir']) } : {}),
      ...(imageCommand ? { imageProvider: new CommandImageProvider(imageCommand) } : {}),
      ...(visionCommand ? { visionProvider: new CommandVisionProvider(visionCommand) } : {}),
      ...(reviews ? { suppliedReviews: reviews } : {}),
      ...(ttsCommand ? { ttsProvider: new CommandTtsProvider(ttsCommand) } : {}),
    })
    console.log(JSON.stringify({ previewPath: result.previewPath, metrics: result.metrics }, null, 2))
    return
  }

  if (command === 'preview') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const pkgFile = fs.existsSync(path.join(runDir, 'director-retimed.json')) ? 'director-retimed.json' : 'director.json'
    const pkg = readJson<DirectorPackage>(path.join(runDir, pkgFile))
    const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const motions = readJson<ResolvedMotion[]>(path.join(runDir, 'resolved-motions.json'))
    const tts = fs.existsSync(path.join(runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(runDir, 'tts.json')) : []
    const plan = buildPreviewProject({ pkg, assets, motions, tts })
    const previewPath = writePreview(plan, path.join(runDir, 'preview'), true)
    console.log(previewPath)
    return
  }

  if (command === 'render') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const pkgFile = fs.existsSync(path.join(runDir, 'director-retimed.json')) ? 'director-retimed.json' : 'director.json'
    const pkg = readJson<DirectorPackage>(path.join(runDir, pkgFile))
    const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const motions = readJson<ResolvedMotion[]>(path.join(runDir, 'resolved-motions.json'))
    const tts = fs.existsSync(path.join(runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(runDir, 'tts.json')) : []
    const plan = buildPreviewProject({ pkg, assets, motions, tts })
    const result = renderHyperFrames({
      plan,
      outputDir: path.join(runDir, 'render'),
      quality: String(opts.quality ?? 'high') as 'draft' | 'standard' | 'high',
      gpu: opts.gpu !== 'false',
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`text-to-video

Commands:
  run --script article.md --out data/run --text-command "<cmd>" --image-command "<cmd>" --vision-command "<cmd>" [--tts-command "<cmd>"]
  run --script article.md --out data/run --director-json director.json --images-dir images --vision-json reviews.json
  preview --run data/run
  render --run data/run [--quality draft|standard|high] [--gpu false]

Command providers read one JSON request from stdin and must write one JSON result to stdout.
`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
