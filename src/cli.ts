#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import type { DirectorPackage, GeneratedAsset, ResolvedMotion, TtsCue, VisionReviewResult } from './domain/types.js'
import type { TextModel } from './director/single-pass.js'
import { runDryRunPipeline, runPipeline } from './pipeline/run.js'
import { CommandTextModel } from './providers/text-command.js'
import { CommandImageProvider } from './providers/image.js'
import { OpenAIImageProvider, OpenAIResponsesTextModel } from './providers/openai.js'
import { CommandVisionProvider } from './providers/vision-command.js'
import { CommandTtsProvider } from './providers/tts.js'
import { buildPreviewProject } from './preview/project.js'
import { writePreview } from './preview/html.js'
import { renderHyperFrames } from './render/hyperframes.js'
import { readJson } from './runtime/workspace.js'
import { createRunLock, verifyRunLock } from './runtime/lock.js'
import { finalizeLockedRun } from './pipeline/finalize.js'
import { rerunAsset, rerunShot } from './pipeline/rerun.js'
import { analyzeAssetDebug } from './pipeline/debug.js'
import { refreshPrecutSummaryFromRun } from './pipeline/precut-summary.js'
import { generateQuickTest } from './pipeline/quick-test.js'

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
  async completeJson<T>(): Promise<T> { return readJson<T>(this.file) }
}

function providerCommand(opts: Record<string, string | boolean>, key: string, envKey: string): string | undefined {
  return opts[key] ? String(opts[key]) : process.env[envKey]
}

function loadLocalOpenAIKey(): void {
  if (process.env.OPENAI_API_KEY) return
  const envFile = path.resolve('.env.local')
  if (!fs.existsSync(envFile)) return
  const match = fs.readFileSync(envFile, 'utf8').match(/^\s*OPENAI_API_KEY\s*=\s*(.*?)\s*$/m)
  if (!match?.[1]) return
  const value = match[1].replace(/^(?:"(.*)"|'(.*)')$/, (_whole, doubleQuoted: string | undefined, singleQuoted: string | undefined) => doubleQuoted ?? singleQuoted ?? '')
  if (value) process.env.OPENAI_API_KEY = value
}

function openAIImageOptions(opts: Record<string, string | boolean>, aspectRatio: string) {
  const quality = String(opts['image-quality'] ?? 'low')
  const format = String(opts['image-format'] ?? 'jpeg')
  if (!['low', 'medium', 'high'].includes(quality)) throw new Error('--image-quality must be low, medium, or high')
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('--image-format must be png, jpeg, or webp')
  return {
    aspectRatio,
    quality: quality as 'low' | 'medium' | 'high',
    format: format as 'png' | 'jpeg' | 'webp',
  }
}

function defaultTextModel(textCommand: string | undefined, directorJson: string | undefined): TextModel | undefined {
  if (directorJson) return new FileTextModel(directorJson)
  if (textCommand) return new CommandTextModel(textCommand)
  if (process.env.OPENAI_API_KEY) return new OpenAIResponsesTextModel()
  return undefined
}

function defaultImageProvider(
  opts: Record<string, string | boolean>,
  aspectRatio: string,
  imageCommand?: string,
) {
  if (imageCommand) return new CommandImageProvider(imageCommand)
  if (process.env.OPENAI_API_KEY) return new OpenAIImageProvider(openAIImageOptions(opts, aspectRatio))
  return undefined
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
    const textModel = defaultTextModel(textCommand, directorJson)
    const style = String(opts.style ?? 'cinematic historical realism')
    const aspectRatio = String(opts['aspect-ratio'] ?? '16:9')
    const forceDirector = Boolean(opts['force-director'])
    if (opts['dry-run']) {
      const result = await runDryRunPipeline({
        script, style, aspectRatio, outputDir,
        ...(textModel ? { textModel } : {}),
        ...(forceDirector ? { forceDirector: true } : {}),
      })
      console.log(JSON.stringify({
        draftPath: result.draftPath,
        draftJsonPath: result.draftJsonPath,
        source: result.source,
        directorCalls: result.directorCalls,
      }, null, 2))
      return
    }
    const reviews = opts['vision-json'] ? readJson<VisionReviewResult[]>(String(opts['vision-json'])) : undefined
    const imageCommand = providerCommand(opts, 'image-command', 'TEXT_TO_VIDEO_IMAGE_COMMAND')
    const visionCommand = providerCommand(opts, 'vision-command', 'TEXT_TO_VIDEO_VISION_COMMAND')
    const ttsCommand = providerCommand(opts, 'tts-command', 'TEXT_TO_VIDEO_TTS_COMMAND')
    const imageProvider = defaultImageProvider(opts, aspectRatio, imageCommand)
    if (imageProvider && !visionCommand && !reviews) {
      throw new Error('run requires --vision-command or --vision-json after image generation; use quick-test for image-only iteration')
    }
    const result = await runPipeline({
      script,
      style,
      aspectRatio,
      outputDir,
      ...(textModel ? { textModel } : {}),
      ...(forceDirector ? { forceDirector: true } : {}),
      ...(opts['images-dir'] ? { imagesDir: String(opts['images-dir']) } : {}),
      ...(imageProvider ? { imageProvider } : {}),
      ...(visionCommand ? { visionProvider: new CommandVisionProvider(visionCommand) } : {}),
      ...(reviews ? { suppliedReviews: reviews } : {}),
      ...(ttsCommand ? { ttsProvider: new CommandTtsProvider(ttsCommand) } : {}),
      maxImageRetries: Number(opts['image-retries'] ?? 2),
    })
    console.log(JSON.stringify({ previewPath: result.previewPath, metrics: result.metrics }, null, 2))
    return
  }

  if (command === 'quick-test') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const imageCommand = providerCommand(opts, 'image-command', 'TEXT_TO_VIDEO_IMAGE_COMMAND')
    const quickTestPkg = readJson<DirectorPackage>(path.join(runDir, 'director.json'))
    const imageProvider = defaultImageProvider(opts, quickTestPkg.aspectRatio, imageCommand)
    if (!imageProvider) throw new Error('quick-test requires OPENAI_API_KEY or --image-command')
    const shotsValue = Number(opts.shots ?? 3)
    if (!Number.isInteger(shotsValue) || shotsValue < 1) throw new Error('--shots must be a positive integer')
    const result = await generateQuickTest({
      runDir,
      imageProvider,
      shots: shotsValue,
      ...(opts.shot ? { shotId: String(opts.shot) } : {}),
      ...(opts.hint ? { hint: String(opts.hint) } : {}),
    })
    console.log(JSON.stringify({
      galleryPath: result.galleryPath,
      iterationDir: result.iterationDir,
      shots: result.shotIds,
      generatedImages: result.assets.length,
    }, null, 2))
    return
  }

  if (command === 'rerun-asset') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const assetId = String(opts.asset ?? '')
    if (!assetId) throw new Error('--asset is required')
    if (fs.existsSync(path.join(runDir, 'lock.json'))) throw new Error('run is locked; do not mutate assets after lock. Start a new run or remove the lock intentionally.')
    const imageCommand = providerCommand(opts, 'image-command', 'TEXT_TO_VIDEO_IMAGE_COMMAND')
    const visionCommand = providerCommand(opts, 'vision-command', 'TEXT_TO_VIDEO_VISION_COMMAND')
    if (!imageCommand || !visionCommand) throw new Error('rerun-asset requires image and vision commands')
    const previewPath = await rerunAsset({
      runDir, assetId, imageProvider: new CommandImageProvider(imageCommand), visionProvider: new CommandVisionProvider(visionCommand),
      ...(opts.hint ? { retryHint: String(opts.hint) } : {}),
    })
    console.log(previewPath)
    return
  }

  if (command === 'rerun-shot') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const shotId = String(opts.shot ?? '')
    if (!shotId) throw new Error('--shot is required')
    if (fs.existsSync(path.join(runDir, 'lock.json'))) throw new Error('run is locked; do not mutate assets after lock. Start a new run or remove the lock intentionally.')
    const imageCommand = providerCommand(opts, 'image-command', 'TEXT_TO_VIDEO_IMAGE_COMMAND')
    const visionCommand = providerCommand(opts, 'vision-command', 'TEXT_TO_VIDEO_VISION_COMMAND')
    if (!imageCommand || !visionCommand) throw new Error('rerun-shot requires image and vision commands')
    const previewPath = await rerunShot({ runDir, shotId, imageProvider: new CommandImageProvider(imageCommand), visionProvider: new CommandVisionProvider(visionCommand) })
    console.log(previewPath)
    return
  }

  if (command === 'debug-asset') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const assetId = String(opts.asset ?? '')
    if (!assetId) throw new Error('--asset is required')
    console.log(JSON.stringify(analyzeAssetDebug(runDir, assetId), null, 2))
    return
  }

  if (command === 'precut-summary') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const summary = refreshPrecutSummaryFromRun(runDir)
    console.log(JSON.stringify({
      markdownPath: path.join(runDir, 'precut-summary.md'),
      jsonPath: path.join(runDir, 'precut-summary.json'),
      overview: summary.overview,
    }, null, 2))
    return
  }

  if (command === 'lock') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    console.log(JSON.stringify(createRunLock(runDir), null, 2))
    return
  }

  if (command === 'tts') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const ttsCommand = providerCommand(opts, 'tts-command', 'TEXT_TO_VIDEO_TTS_COMMAND')
    if (!ttsCommand) throw new Error('tts requires --tts-command or TEXT_TO_VIDEO_TTS_COMMAND')
    const result = await finalizeLockedRun({ runDir, ttsProvider: new CommandTtsProvider(ttsCommand), concurrency: Number(opts.concurrency ?? 3) })
    console.log(JSON.stringify({ previewPath: result.previewPath, durationMs: result.tts.at(-1)?.endMs ?? 0 }, null, 2))
    return
  }

  if (command === 'preview') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    const retimed = fs.existsSync(path.join(runDir, 'director-retimed.json'))
    const pkg = readJson<DirectorPackage>(path.join(runDir, retimed ? 'director-retimed.json' : 'director.json'))
    const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const motionsFile = retimed && fs.existsSync(path.join(runDir, 'resolved-motions-retimed.json')) ? 'resolved-motions-retimed.json' : 'resolved-motions.json'
    const motions = readJson<ResolvedMotion[]>(path.join(runDir, motionsFile))
    const tts = fs.existsSync(path.join(runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(runDir, 'tts.json')) : []
    const plan = buildPreviewProject({ pkg, assets, motions, tts })
    console.log(writePreview(plan, path.join(runDir, retimed ? 'preview-retimed' : 'preview'), true))
    return
  }

  if (command === 'render') {
    const runDir = path.resolve(String(opts.run ?? 'data/run'))
    verifyRunLock(runDir)
    const retimed = fs.existsSync(path.join(runDir, 'director-retimed.json'))
    const pkg = readJson<DirectorPackage>(path.join(runDir, retimed ? 'director-retimed.json' : 'director.json'))
    const assets = readJson<GeneratedAsset[]>(path.join(runDir, 'assets.json'))
    const motionsFile = retimed && fs.existsSync(path.join(runDir, 'resolved-motions-retimed.json')) ? 'resolved-motions-retimed.json' : 'resolved-motions.json'
    const motions = readJson<ResolvedMotion[]>(path.join(runDir, motionsFile))
    const tts = fs.existsSync(path.join(runDir, 'tts.json')) ? readJson<TtsCue[]>(path.join(runDir, 'tts.json')) : []
    const plan = buildPreviewProject({ pkg, assets, motions, tts })
    console.log(JSON.stringify(renderHyperFrames({
      plan, outputDir: path.join(runDir, 'render'), quality: String(opts.quality ?? 'high') as 'draft' | 'standard' | 'high',
      gpu: opts.gpu !== 'false', runCheck: opts.check !== 'false',
    }), null, 2))
    return
  }

  console.log(`text-to-video

Interactive workflow:
  1. run         script -> Director -> prompts/images -> Vision grounding -> grounded preview
  2. rerun-asset regenerate exactly one prompt/image and update downstream workflow state
  3. rerun-shot  regenerate all image assets for one shot without rerunning the Director
  4. debug-asset diagnose one asset back to Director/prompt/image/Vision/motion/cache source
  5. precut-summary rebuild the human-readable shot/motion/display/text summary
  6. lock        freeze Director/assets/reviews/motion
  7. tts         synthesize real audio and retime the locked creative plan
  8. render      HyperFrames final render
  9. quick-test  generate first N image candidates and write a rapid-iteration gallery

Commands:
  run --script article.md --out data/run --text-command "<cmd>" --dry-run [--force-director]
  run --script article.md --out data/run --image-command "<cmd>" --vision-command "<cmd>" [--text-command "<cmd>"]
  run --script article.md --out data/run --director-json director.json --images-dir images --vision-json reviews.json
  quick-test --run data/run --shots 3 [--image-quality low] [--hint "adjustment for this iteration"]
  quick-test --run data/run --shot shot-001 [--hint "make the subject larger"]
  rerun-asset --run data/run --asset asset-0001 --image-command "<cmd>" --vision-command "<cmd>" [--hint "user feedback"]
  rerun-shot --run data/run --shot shot-001 --image-command "<cmd>" --vision-command "<cmd>"
  debug-asset --run data/run --asset asset-0001
  precut-summary --run data/run
  lock --run data/run
  tts --run data/run --tts-command "<cmd>" [--concurrency 3]
  preview --run data/run
  render --run data/run [--quality draft|standard|high] [--gpu false]

OpenAI API:
  Set OPENAI_API_KEY. The native text provider uses gpt-6-luna with /v1/responses;
  the image provider uses gpt-image-2 with /v1/images/generations. Image calls default
  to low quality, JPEG, and serial execution for quick tests. A quick-test requires
  a prior run --dry-run and writes candidates under data/run/quick-test/.
`)
}

loadLocalOpenAIKey()

main().catch(error => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error))
  process.exitCode = 1
})
