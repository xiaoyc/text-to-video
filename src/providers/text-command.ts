import type { TextModel } from '../director/single-pass.js'
import { runJsonCommand } from './command.js'

export class CommandTextModel implements TextModel {
  constructor(private readonly command: string) {}

  async completeJson<T>(input: { system: string; prompt: string }): Promise<T> {
    return runJsonCommand<T>(this.command, {
      kind: 'text',
      responseFormat: 'json',
      ...input,
    })
  }
}
