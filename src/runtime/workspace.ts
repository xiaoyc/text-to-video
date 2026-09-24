import fs from 'node:fs'
import path from 'node:path'

export function ensureDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function writeJson(file: string, value: unknown): string {
  ensureDir(path.dirname(file))
  fs.writeFileSync(file, JSON.stringify(value, null, 2))
  return file
}

export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T
}

export function writeAssetPromptFiles(outputDir: string, requests: Array<{ assetId: string; shotId: string; role: string; prompt: string; negativePrompt: string }>): void {
  const dir = ensureDir(path.join(outputDir, 'prompts'))
  for (const request of requests) {
    fs.writeFileSync(path.join(dir, request.assetId + '.md'), [
      `# ${request.assetId}`,
      '',
      `- Shot: ${request.shotId}`,
      `- Role: ${request.role}`,
      '',
      '## Prompt',
      '',
      request.prompt,
      '',
      '## Negative prompt',
      '',
      request.negativePrompt,
      '',
    ].join('\n'))
  }
}
