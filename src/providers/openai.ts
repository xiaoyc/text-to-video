import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AssetRequest } from '../domain/types.js'
import type { TextModel } from '../director/single-pass.js'
import type { ImageProvider } from './image.js'

type JsonRecord = Record<string, unknown>

function getApiKey(apiKey?: string): string {
  const key = apiKey ?? process.env.OPENAI_API_KEY
  if (!key) throw new Error('OPENAI_API_KEY is required for the native OpenAI provider')
  return key
}

async function postOpenAI(pathname: string, apiKey: string, body: JsonRecord): Promise<JsonRecord> {
  const response = await fetch(`https://api.openai.com/v1/${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  const responseText = await response.text()
  let payload: JsonRecord
  try {
    payload = JSON.parse(responseText) as JsonRecord
  } catch {
    throw new Error(`OpenAI ${pathname} returned non-JSON (HTTP ${response.status})`)
  }
  if (!response.ok) {
    const error = payload.error as JsonRecord | undefined
    const message = typeof error?.message === 'string' ? error.message : response.statusText
    throw new Error(`OpenAI ${pathname} failed (HTTP ${response.status}): ${message}`)
  }
  return payload
}

function responseText(payload: JsonRecord): string {
  const output = Array.isArray(payload.output) ? payload.output as JsonRecord[] : []
  const chunks: string[] = []
  for (const item of output) {
    const content = Array.isArray(item.content) ? item.content as JsonRecord[] : []
    for (const part of content) {
      if (part.type === 'refusal') {
        throw new Error(`OpenAI refused the request: ${String(part.refusal ?? 'no reason provided')}`)
      }
      if (part.type === 'output_text' && typeof part.text === 'string') chunks.push(part.text)
    }
  }
  if (!chunks.length) throw new Error('OpenAI Responses API returned no output text')
  return chunks.join('\n')
}

export class OpenAIResponsesTextModel implements TextModel {
  constructor(private readonly options: { apiKey?: string; model?: string } = {}) {}

  async completeJson<T>(input: { system: string; prompt: string }): Promise<T> {
    const payload = await postOpenAI('responses', getApiKey(this.options.apiKey), {
      model: this.options.model ?? process.env.TEXT_TO_VIDEO_OPENAI_TEXT_MODEL ?? 'gpt-6-luna',
      input: [
        { role: 'system', content: input.system },
        { role: 'user', content: input.prompt },
      ],
      text: { format: { type: 'json_object' } },
      store: false,
    })
    try {
      return JSON.parse(responseText(payload)) as T
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`OpenAI Responses API returned invalid JSON: ${error.message}`)
      throw error
    }
  }
}

function imageSizeForAspectRatio(aspectRatio: string): string {
  const match = aspectRatio.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)\s*$/)
  if (!match) return '1536x864'
  const ratio = Number(match[1]) / Number(match[2])
  if (!Number.isFinite(ratio) || ratio < 1 / 3 || ratio > 3) {
    throw new Error(`gpt-image-2 aspect ratio must be between 1:3 and 3:1; received ${aspectRatio}`)
  }
  const targetPixels = 1536 * 864
  const roundTo16 = (value: number) => Math.max(16, Math.round(value / 16) * 16)
  const width = roundTo16(Math.sqrt(targetPixels * ratio))
  const height = roundTo16(Math.sqrt(targetPixels / ratio))
  return `${width}x${height}`
}

export interface OpenAIImageProviderOptions {
  apiKey?: string
  model?: string
  quality?: 'low' | 'medium' | 'high'
  format?: 'png' | 'jpeg' | 'webp'
  aspectRatio?: string
}

export class OpenAIImageProvider implements ImageProvider {
  readonly maxConcurrency = 1

  constructor(private readonly options: OpenAIImageProviderOptions = {}) {}

  async generate(input: {
    request: AssetRequest
    outputDir: string
    attempt?: number
    retryHints?: string[]
  }): Promise<{ imagePath: string; provider: string }> {
    const model = this.options.model ?? process.env.TEXT_TO_VIDEO_OPENAI_IMAGE_MODEL ?? 'gpt-image-2'
    const quality = this.options.quality ?? 'low'
    const format = this.options.format ?? 'jpeg'
    const prompt = [
      input.request.prompt,
      input.request.negativePrompt ? `Avoid: ${input.request.negativePrompt}.` : '',
      input.retryHints?.length ? `Revision guidance: ${input.retryHints.join('; ')}.` : '',
    ].filter(Boolean).join('\n\n')
    const payload = await postOpenAI('images/generations', getApiKey(this.options.apiKey), {
      model,
      prompt,
      size: imageSizeForAspectRatio(this.options.aspectRatio ?? '16:9'),
      quality,
      output_format: format,
      n: 1,
    })
    const data = Array.isArray(payload.data) ? payload.data as JsonRecord[] : []
    const base64 = data[0]?.b64_json
    if (typeof base64 !== 'string' || !base64.length) {
      throw new Error(`OpenAI Images API returned no image data for ${input.request.assetId}`)
    }

    fs.mkdirSync(input.outputDir, { recursive: true })
    const imagePath = path.join(
      input.outputDir,
      `${input.request.assetId}-${Date.now()}-${randomUUID().slice(0, 8)}.${format}`,
    )
    fs.writeFileSync(imagePath, Buffer.from(base64, 'base64'))
    return { imagePath, provider: `openai:${model}` }
  }
}

export { imageSizeForAspectRatio }
