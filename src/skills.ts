import * as vscode from 'vscode';
import {realpath} from 'node:fs/promises';
import * as path from 'node:path';
import {Message, parseChanges} from './protocol';

export interface Skill {id: string; name: string; uri: vscode.Uri; root: vscode.Uri;}
export interface SkillContext {name: string; content: string;}

export function skillPath(value: string): string {
  const relative = value.replace(/\\/g, '/');
  if (!/\.(md|json)$/i.test(relative)) throw new Error('Skill files must end in .md or .json.');
  try {
    parseChanges('```azure-files\n' + JSON.stringify({files:[{path:relative,content:''}]}) + '\n```');
  } catch { throw new Error('Use a safe path relative to skills, such as Test/write-unit-test.md.'); }
  return relative;
}

async function validateSkill(skill: Skill) {
  if (skill.uri.scheme !== 'file') return;
  const root = await realpath(vscode.Uri.joinPath(skill.root, 'skills').fsPath);
  const actual = await realpath(skill.uri.fsPath);
  const workspace = await realpath(skill.root.fsPath);
  for (const [base, target] of [[workspace, root], [root, actual]]) {
    const relative = path.relative(base, target);
    if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
      throw new Error('Skill path escapes the workspace skills folder through a symbolic link.');
    }
  }
}

export async function discoverSkills(): Promise<Skill[]> {
  if (!vscode.workspace.isTrusted) return [];
  const roots = vscode.workspace.workspaceFolders ?? [];
  const skills: Skill[] = [];
  for (const root of roots) {
    const directory = vscode.Uri.joinPath(root.uri, 'skills');
    async function walk(uri: vscode.Uri, prefix: string) {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      for (const [name, type] of entries) {
        if (type & vscode.FileType.SymbolicLink) continue;
        const relative = prefix + name;
        const child = vscode.Uri.joinPath(uri, name);
        if (type & vscode.FileType.Directory) await walk(child, relative + '/');
        else if ((type & vscode.FileType.File) && /\.(md|json)$/i.test(name)) {
          const skill = {id:child.toString(), name:(roots.length > 1 ? root.name + '/' : '') + relative, uri:child, root:root.uri};
          await validateSkill(skill);
          skills.push(skill);
        }
      }
    }
    try { await walk(directory, ''); }
    catch (error: any) { if (error.code !== 'FileNotFound' && error.code !== 'ENOENT') throw error; }
  }
  return skills.sort((a,b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export async function readSkills(skills: Skill[], maxBytes: number): Promise<SkillContext[]> {
  if (skills.length && !vscode.workspace.isTrusted) throw new Error('Trust this workspace before using its skills.');
  const result: SkillContext[] = [];
  let bytes = 0;
  for (const skill of skills) {
    await validateSkill(skill);
    const document = vscode.workspace.textDocuments?.find(document => document.uri.toString() === skill.id);
    if (!document && (await vscode.workspace.fs.stat(skill.uri)).size > maxBytes - bytes) throw new Error(`Skills and attachments exceed the ${maxBytes} byte limit.`);
    const content = document?.getText() ?? Buffer.from(await vscode.workspace.fs.readFile(skill.uri)).toString('utf8');
    bytes += Buffer.byteLength(content, 'utf8');
    if (bytes > maxBytes) throw new Error(`Skills and attachments exceed the ${maxBytes} byte limit.`);
    if (content.includes('\0')) throw new Error('Skills must contain text.');
    result.push({name:skill.name,content});
  }
  return result;
}

// Keep the final user message unchanged: generation may persist it on the backend.
// This temporary context never enters the local conversation or history updates.
export function withSkills(messages: Message[], skills: SkillContext[]): Message[] {
  if (!skills.length) return [...messages];
  const context: Message = {id:'workspace-skills',role:'system',content:'Use these selected workspace skills for this response. Each entry contains its relative file name and instructions.\n\nSelected skills (JSON):\n' + JSON.stringify(skills)};
  return [...messages.slice(0,-1),context,...messages.slice(-1)];
}
