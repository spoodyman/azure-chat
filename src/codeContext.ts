import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import {Message} from './protocol';

export const codeInstruction = readFileSync(path.join(__dirname,'../media/code-instructions.txt'),'utf8').trim();
const codePrefix = 'Code response instructions:\n' + codeInstruction + '\n\n';
export function displayPrompt(content: string): string {
  return content.startsWith(codePrefix) ? content.slice(codePrefix.length) : content;
}

// History APIs expect real conversation messages, so formatting belongs in the user prompt.
export function withCodeContext(messages: Message[], enabled = true): Message[] {
  if (!enabled || !messages.length) return [...messages];
  const user = messages[messages.length - 1];
  if (user.role !== 'user') throw new Error('Code response instructions require a final user message.');
  return [...messages.slice(0,-1), {...user, content:codePrefix + user.content}];
}
