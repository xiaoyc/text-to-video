#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import type {
  DirectorPackage,
  GeneratedAsset,
  ResolvedMotion,
  TtsCue,
  VisionReviewResult,
} from './domain/types.js'
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
import { createRunLock, verifyRunLock } from './runtime/lock.js'
import { finalizeLockedRun } from './pipeline/finalize.js'
import { rerunShot } from './pipeline/rerun.js'

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

function providerCommand(opts: Record<string, string | boolean>, key: string, envKey: string): string | undefined {
  return opts[key] ? String(opts[key]) : process.env[envKey]
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
    const textCommand = providerCommand(opts, 'text-command', 'TEXT_TO_VIDEO_TEXT_COMMAND')
    if (!directorJson && !textCommand) throw new Error('use --director-json <file> or --text-command <command>')
    const textModel: TextModel = directorJson ? new FileTextModel(directorJson) : new CommandTextModel(textCommand!)
    const reviews = opts['vision-json'] ? readJson<VisionReviewResult[]>(String(opts['vision-json'])) : undefined
    const imageCommand = providerCommand(opts, 'image-command', 'TEXT_TO_VIDEO_IMAGE_COMMAND')
    const visionCommand = providerCommand(opts, 'vision-command', 'TEXT_TO_VIDEO_VISION_COMMAND')
    const ttsCommand = providerCommand(opts, 'tts-command', 'TEXT_TO_VIDEO_TTS_COMMAND')
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
      maxImageRetries: Number(opts['image-retries'] ?? 2),
    })
    console.log(JSON.stringify({ previewPath: result.previewPath, metrics: result.metrics }, null, 2))
    return
  }

  if (command === 'rerun-shot') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const shotId = String(opts.shot ?? '')
    if (!shotId) throw new Error('--shot is required')
    if (fs.existsSync(path.join(runDir, 'lock.json'))) {
      throw new Error('run is locked; do not mutate assets after lock. Start a new run or remove the lock intentionally.')
    }
    const imageCommand = providerCommand(opts, 'image-command', 'TEXT_TO_VIDEO_IMAGE_COMMAND')
    const visionCommand = providerCommand(opts, 'vision-command', 'TEXT_TO_VIDEO_VISION_COMMAND')
    if (!imageCommand || !visionCommand) throw new Error('rerun-shot requires image and vision commands')
    const previewPath = await rerunShot({
      runDir,
      shotId,
      imageProvider: new CommandImageProvider(imageCommand),
      visionProvider: new CommandVisionProvider(visionCommand),
    })
    console.log(previewPath)
    return
  }

  if (command === 'lock') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const lock = createRunLock(runDir)
    console.log(JSON.stringify(lock, null, 2))
    return
  }

  if (command === 'tts') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const ttsCommand = providerCommand(opts, 'tts-command', 'TEXT_TO_VIDEO_TTS_COMMAND')
    if (!ttsCommand) throw new Error('tts requires --tts-command or TEXT_TO_VIDEO_TTS_COMMAND')
    const result = await finalizeLockedRun({
      runDir,
      ttsProvider: new CommandTtsProvider(ttsCommand),
      concurrency: Number(opts.concurrency ?? 3),
    })
    console.log(JSON.stringify({ previewPath: result.previewPath, durationMs: result.tts.at(-1)?.endMs ?? 0 }, null, 2))
    return
  }

  if (command === 'preview') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const retimed = fs.existsSync(path.join(runDir, 'director-retimed.json'))
    const pkg = readJson<DirectorPackage>(path.join(runDir, retimed ? 'director-retimed.json' : 'director.json'))
    const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const motionsFile = retimed && fs.existsSync(path.join(runDir, 'resolved-motions-retimed.json'))
      ? 'resolved-motions-retimed.json'
      : 'resolved-motions.json'
    const motions = readJson<ResolvedMotion[]>(path.join(runDir, motionsFile))
    const tts = fs.existsSync(path.join(runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(runDir, 'tts.json')) : []
    const plan = buildPreviewProject({ pkg, assets, motions, tts })
    const previewPath = writePreview(plan, path.join(runDir, retimed ? 'preview-retimed' : 'preview'), true)
    console.log(previewPath)
    return
  }

  if (command === 'render') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    verifyRunLock(runDir)
    const retimed = fs.existsSync(path.join(runDir, 'director-retimed.json'))
    const pkg = readJson<DirectorPackage>(path.join(runDir, retimed ? 'director-retimed.json' : 'director.json'))
    const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const motionsFile = retimed && fs.existsSync(path.join(runDir, 'resolved-motions-retimed.json'))
      ? 'resolved-motions-retimed.json'
      : 'resolved-motions.json'
    const motions = readJson<ResolvedMotion[]>(path.join(runDir, motionsFile))
    const tts = fs.existsSync(path.join(runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(runDir, 'tts.json')) : []
    const plan = buildPreviewProject({ pkg, assets, motions, tts })
    const result = renderHyperFrames({
      plan,
      outputDir: path.join(runDir, 'render'),
      quality: String(opts.quality ?? 'high') as 'draft' | 'standard' | 'high',
      gpu: opts.gpu !== 'false',
      runCheck: opts.check !== 'false',
    })
    console.log(JSON.stringify(result, null, 2))
    return
  }

  console.log(`text-to-video

Interactive workflow:
  1. run        script -> Director -> prompts/images -> Vision grounding -> grounded preview
  2. rerun-shot fix one bad shot without rerunning the Director
  3. lock       freeze Director/assets/reviews/motion
  4. tts        synthesize real audio and retime the locked creative plan
  5. render     HyperFrames final render

Commands:
  run --script article.md --out data/run --text-command "<cmd>" --image-command "<cmd>" --vision-command "<cmd>"
  run --script article.md --out data/run --director-json director.json --images-dir images --vision-json reviews.json
  rerun-shot --run data/run --shot shot-001 --image-command "<cmd>" --vision-command "<cmd>"
  lock --run data/run
  tts --run data/run --tts-command "<cmd>" [--concurrency 3]
  preview --run data/run
  render --run data/run [--quality draft|standard|high] [--gpu false]

Command providers read one JSON request from stdin and must write one JSON result to stdout.
`)
}

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
