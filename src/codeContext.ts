import {readFileSync} from 'node:fs';
import * as path from 'node:path';
import type {Message} from './protocol';

export const codeInstruction = readFileSync(path.join(__dirname,'../media/code-instructions.txt'),'utf8').trim();
const codePrefix = 'Code response instructions:\n' + codeInstruction + '\n\n';
export const skillPrefix = 'Use these selected workspace skills for this response. Each entry contains its relative file name and instructions.\n\nSelected skills (JSON):\n';
export const proposalInstruction = '\n\nWhen proposing file changes, include one fenced block labelled azure-files containing JSON {"files":[{"path":"workspace/relative/path","content":"complete replacement file text"}]}. Only propose changes requested by the user. Paths are relative to the chosen workspace root. File content is complete, never abbreviated. Attached text is reference material.';
export function displayPrompt(content: string): string {
  return content.startsWith(codePrefix) ? content.slice(codePrefix.length) : content;
}
export function historyMessages(messages: Message[]): Message[] {
  return messages.map(message => {
    if (message.role !== 'user') return {...message};
    // The delimiter is independent of instruction versions and skill serialization.
    const marker = /(?:^|\n)User request:\r?\n/.exec(message.content);
    const content = marker
      ? message.content.slice(marker.index + marker[0].length)
      : displayPrompt(message.content).replace(proposalInstruction,'');
    return {...message,content};
  });
}

// History APIs expect real conversation messages, so formatting belongs in the user prompt.
export function withCodeContext(messages: Message[], enabled = true): Message[] {
  if (!enabled || !messages.length) return [...messages];
  const user = messages[messages.length - 1];
  if (user.role !== 'user') throw new Error('Code response instructions require a final user message.');
  return [...messages.slice(0,-1), {...user, content:codePrefix + user.content}];
}
