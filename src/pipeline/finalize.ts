import fs from 'node:fs'
import path from 'node:path'
import type { AssetRequest, DirectorPackage, GeneratedAsset, TtsCue, VisionReviewResult } from '../domain/types.js'
import type { TtsProvider } from '../providers/tts.js'
import { synthesizeTts } from '../providers/tts.js'
import { retimeDirectorPackage } from './retime.js'
import { resolveAllMotions } from '../vision/runtime.js'
import { buildPreviewProject } from '../preview/project.js'
import { writePreview } from '../preview/html.js'
import { readJson, writeJson } from '../runtime/workspace.js'
import { verifyRunLock } from '../runtime/lock.js'
import { writePrecutSummary } from './precut-summary.js'

export async function finalizeLockedRun(input: {
  runDir: string
  ttsProvider: TtsProvider
  concurrency?: number
}): Promise<{ pkg: DirectorPackage; tts: TtsCue[]; previewPath: string }> {
  verifyRunLock(input.runDir)
  const pkg = readJson<DirectorPackage>(path.join(input.runDir, 'director.json'))
  const requests = readJson<AssetRequest[]>(path.join(input.runDir, 'asset-requests.json'))
  const assets = readJson<GeneratedAsset[]>(path.join(input.runDir, 'assets.json'))
  const reviews = readJson<VisionReviewResult[]>(path.join(input.runDir, 'vision-reviews.json'))
  const ttsDir = path.join(input.runDir, 'tts')
  fs.mkdirSync(ttsDir, { recursive: true })
  const tts = await synthesizeTts(pkg.narrative.beats, input.ttsProvider, ttsDir, input.concurrency ?? 3)
  const retimed = retimeDirectorPackage(pkg, tts)
  const motions = resolveAllMotions(retimed, reviews)
  const incompatible = motions.filter(motion => !motion.compatible)
  if (incompatible.length) throw new Error(`retimed motion incompatible for shots: ${incompatible.map(item => item.shotId).join(', ')}`)
  writeJson(path.join(input.runDir, 'tts.json'), tts)
  writeJson(path.join(input.runDir, 'director-retimed.json'), retimed)
  writeJson(path.join(input.runDir, 'resolved-motions-retimed.json'), motions)
  const plan = buildPreviewProject({ pkg: retimed, assets, motions, tts })
  writeJson(path.join(input.runDir, 'preview-plan-retimed.json'), plan)
  const previewPath = writePreview(plan, path.join(input.runDir, 'preview-retimed'), true)
  writePrecutSummary({ runDir: input.runDir, pkg: retimed, requests, assets, reviews, motions })
  return { pkg: retimed, tts, previewPath }
}
