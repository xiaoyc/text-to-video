import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { OpenAIImageProvider, OpenAIResponsesTextModel, imageSizeForAspectRatio } from '../src/providers/openai.js'
import type { AssetRequest } from '../src/domain/types.js'

afterEach(() => vi.unstubAllGlobals())

describe('native OpenAI providers', () => {
  it('uses Responses API JSON mode for Director text', async () => {
    let requestBody: Record<string, unknown> | undefined
    let authorization = ''
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>
      authorization = new Headers(init.headers).get('Authorization') ?? ''
      return new Response(JSON.stringify({
        output: [{ content: [{ type: 'output_text', text: '{"ok":true}' }] }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    const model = new OpenAIResponsesTextModel({ apiKey: 'test-key' })
    const result = await model.completeJson<{ ok: boolean }>({ system: 'system', prompt: 'prompt' })

    expect(result).toEqual({ ok: true })
    expect(authorization).toBe('Bearer test-key')
    expect(requestBody?.model).toBe('gpt-6-luna')
    expect(requestBody?.text).toEqual({ format: { type: 'json_object' } })
    expect(requestBody?.store).toBe(false)
  })

  it('saves an Images API candidate using quick low-quality settings and retry guidance', async () => {
    let requestBody: Record<string, unknown> | undefined
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      requestBody = JSON.parse(String(init.body)) as Record<string, unknown>
      return new Response(JSON.stringify({ data: [{ b64_json: Buffer.from('fake-image').toString('base64') }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }))
    const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'openai-image-provider-'))
    const request: AssetRequest = {
      assetId: 'asset-0001', shotId: 'shot-001', role: 'primary', primarySubjectId: 'coins',
      prompt: 'copper coins in a market', negativePrompt: 'modern objects',
      visibleSubjectIds: ['coins'], hiddenSubjectIds: [],
    }

    const result = await new OpenAIImageProvider({ apiKey: 'test-key', aspectRatio: '16:9' }).generate({
      request, outputDir, retryHints: ['larger coins'],
    })

    expect(requestBody?.model).toBe('gpt-image-2')
    expect(requestBody?.size).toBe('1536x864')
    expect(requestBody?.quality).toBe('low')
    expect(requestBody?.output_format).toBe('jpeg')
    expect(requestBody?.prompt).toContain('Avoid: modern objects')
    expect(requestBody?.prompt).toContain('larger coins')
    expect(fs.readFileSync(result.imagePath, 'utf8')).toBe('fake-image')
    expect(result.provider).toBe('openai:gpt-image-2')
  })

  it('chooses valid landscape and portrait dimensions and rejects unsupported ratios', () => {
    expect(imageSizeForAspectRatio('16:9')).toBe('1536x864')
    expect(imageSizeForAspectRatio('9:16')).toBe('864x1536')
    expect(() => imageSizeForAspectRatio('4:1')).toThrow(/between 1:3 and 3:1/)
  })
})
