import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {Message} from './protocol';

export const codeInstruction = readFileSync(path.join(__dirname,'../media/code-instructions.txt'),'utf8').trim();

// A transient message keeps response formatting out of stored user messages and save retries.
export function withCodeContext(messages: Message[], enabled = true): Message[] {
  if (!enabled || !messages.length) return [...messages];
  return [...messages.slice(0,-1),{id:'code-response-format',role:'system',content:codeInstruction},...messages.slice(-1)];
}
