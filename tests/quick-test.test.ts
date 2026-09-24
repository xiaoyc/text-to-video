import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import type { AssetRequest } from '../src/domain/types.js'
import type { ImageProvider } from '../src/providers/image.js'
import { compileAssetRequests } from '../src/assets/prompt-compiler.js'
import { generateQuickTest } from '../src/pipeline/quick-test.js'
import { zhouDiGoldenPackage } from './fixtures/zhou-di.js'

describe('quick image test', () => {
  it('generates only selected first shots in an isolated iteration and writes a gallery', async () => {
    const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'quick-image-test-'))
    fs.writeFileSync(path.join(runDir, 'director.json'), JSON.stringify(zhouDiGoldenPackage))
    const requests = compileAssetRequests(zhouDiGoldenPackage)
    fs.writeFileSync(path.join(runDir, 'asset-requests.json'), JSON.stringify(requests))
    fs.writeFileSync(path.join(runDir, 'dry-run-state.json'), '{}')
    const calledShots: string[] = []
    const provider: ImageProvider = {
      async generate(input: { request: AssetRequest; outputDir: string }) {
        calledShots.push(input.request.shotId)
        fs.mkdirSync(input.outputDir, { recursive: true })
        const imagePath = path.join(input.outputDir, `${input.request.assetId}.jpeg`)
        fs.writeFileSync(imagePath, 'candidate')
        return { imagePath, provider: 'mock-image' }
      },
    }

    const result = await generateQuickTest({ runDir, imageProvider: provider, shots: 3, hint: 'larger subject' })
    const expectedShotIds = zhouDiGoldenPackage.shots.slice(0, 3).map(shot => shot.shotId)

    expect(result.shotIds).toEqual(expectedShotIds)
    expect(new Set(calledShots)).toEqual(new Set(expectedShotIds))
    expect(result.assets).toHaveLength(requests.filter(request => expectedShotIds.includes(request.shotId)).length)
    expect(fs.existsSync(result.galleryPath)).toBe(true)
    expect(fs.readFileSync(result.galleryPath, 'utf8')).toContain('larger subject')
    expect(fs.existsSync(path.join(result.iterationDir, 'quick-test.json'))).toBe(true)
    expect(fs.existsSync(path.join(runDir, 'assets.json'))).toBe(false)
  })
})
