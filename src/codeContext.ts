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
    let content = displayPrompt(message.content);
    if (content.startsWith(skillPrefix)) {
      const marker = '\n\nUser request:\n', end = content.indexOf(marker,skillPrefix.length);
      if (end >= 0) {
        try {
          const skills = JSON.parse(content.slice(skillPrefix.length,end));
          if (Array.isArray(skills) && skills.every(skill => skill && typeof skill.name === 'string' && typeof skill.content === 'string')) content = content.slice(end + marker.length);
        } catch {}
      }
    }
    return {...message,content:content.replace(proposalInstruction,'')};
  });
}

// History APIs expect real conversation messages, so formatting belongs in the user prompt.
export function withCodeContext(messages: Message[], enabled = true): Message[] {
  if (!enabled || !messages.length) return [...messages];
  const user = messages[messages.length - 1];
  if (user.role !== 'user') throw new Error('Code response instructions require a final user message.');
  return [...messages.slice(0,-1), {...user, content:codePrefix + user.content}];
}
