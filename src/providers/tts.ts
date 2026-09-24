import type { NarrativeBeat, TtsCue } from '../domain/types.js'
import { runJsonCommand } from './command.js'

export interface TtsProvider {
  synthesize(input: {
    beat: NarrativeBeat
    outputDir: string
  }): Promise<{ audioPath: string; durationMs: number }>
}

export class CommandTtsProvider implements TtsProvider {
  constructor(private readonly command: string) {}

  async synthesize(input: { beat: NarrativeBeat; outputDir: string }): Promise<{ audioPath: string; durationMs: number }> {
    const result = runJsonCommand<{ audioPath: string; durationMs: number }>(this.command, {
      kind: 'tts',
      beat: input.beat,
      outputDir: input.outputDir,
    })
    if (!result.audioPath || !Number.isFinite(result.durationMs) || result.durationMs <= 0) {
      throw new Error(`invalid TTS result for ${input.beat.beatId}`)
    }
    return result
  }
}

export async function synthesizeTts(
  beats: NarrativeBeat[],
  provider: TtsProvider,
  outputDir: string,
  concurrency = 3,
): Promise<TtsCue[]> {
  const results = new Array<{ audioPath: string; durationMs: number }>(beats.length)
  let cursor = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, beats.length || 1)) }, async () => {
    while (true) {
      const index = cursor++
      const beat = beats[index]
      if (!beat) return
      results[index] = await provider.synthesize({ beat, outputDir })
    }
  })
  await Promise.all(workers)

  let startMs = 0
  return beats.map((beat, index) => {
    const result = results[index]
    if (!result) throw new Error(`missing TTS result for ${beat.beatId}`)
    const cue: TtsCue = {
      beatId: beat.beatId,
      text: beat.text,
      audioPath: result.audioPath,
      startMs,
      durationMs: Math.round(result.durationMs),
      endMs: startMs + Math.round(result.durationMs),
    }
    startMs = cue.endMs
    return cue
  })
}
