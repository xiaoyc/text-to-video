import fs from 'node:fs'
import path from 'node:path'

export interface RunEvent {
  at: string
  sessionId: string
  stage: string
  type: string
  message: string
  assetId?: string
  shotId?: string
  data?: Record<string, unknown>
}

export type RunEventInput = Omit<RunEvent, 'at' | 'sessionId'>

export class RunLogger {
  readonly sessionId: string
  readonly file: string

  constructor(runDir: string, private readonly echo = true) {
    this.sessionId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${process.pid}`
    this.file = path.join(runDir, 'run-events.jsonl')
    fs.mkdirSync(runDir, { recursive: true })
  }

  emit(input: RunEventInput): RunEvent {
    const event: RunEvent = { at: new Date().toISOString(), sessionId: this.sessionId, ...input }
    fs.appendFileSync(this.file, JSON.stringify(event) + '\n')
    if (this.echo) {
      const identity = [event.assetId, event.shotId].filter(Boolean).join(' ')
      console.log(`[${event.stage}] ${event.message}${identity ? ` (${identity})` : ''}`)
    }
    return event
  }
}

export function createRunLogger(runDir: string, echo = true): RunLogger {
  return new RunLogger(runDir, echo)
}
