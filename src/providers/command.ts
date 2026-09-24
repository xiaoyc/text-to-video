import { spawnSync } from 'node:child_process'

export function runJsonCommand<T>(command: string, payload: unknown): T {
  const result = spawnSync(command, {
    shell: true,
    input: JSON.stringify(payload),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (result.error) throw new Error(`command failed to start: ${result.error.message}`)
  if (result.status !== 0) {
    throw new Error(`command failed (exit ${result.status}): ${String(result.stderr || result.stdout || '').slice(-3000)}`)
  }
  const output = String(result.stdout || '').trim()
  if (!output) throw new Error('command returned empty stdout; expected JSON')
  try {
    return JSON.parse(output) as T
  } catch {
    throw new Error(`command returned invalid JSON: ${output.slice(0, 1000)}`)
  }
}
