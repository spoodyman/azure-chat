import * as vscode from 'vscode';
import {randomBytes, randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import * as path from 'node:path';
import {AzureClient, Message, Conversation, parseChanges, applyDiff, contextTokens, estimateTokens, TokenUsage} from './protocol';
import {Skill, SkillContext, discoverSkills, readSkills, skillPath, withSkills} from './skills';
import {displayPrompt, proposalInstruction, withCodeContext} from './codeContext';

async function validateTarget(root: vscode.Uri, target: vscode.Uri) {
  const realRoot = await realpath(root.fsPath);
  let ancestor = target.fsPath;
  while (true) {
    try {
      const actual = await realpath(ancestor), relative = path.relative(realRoot,actual);
      if (relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw new Error('File path escapes the workspace through a symbolic link.');
      return;
    } catch(error: any) {
      if (error.code !== 'ENOENT') throw error;
      const parent = path.dirname(ancestor); if(parent === ancestor) throw error; ancestor = parent;
    }
  }
}
interface Attachment {id: string; name: string; content: string; uri?: vscode.Uri;}
class Chat implements vscode.WebviewViewProvider {
  view?: vscode.WebviewView;
  messages: Message[] = [];
  conversations: Conversation[] = [];
  attachments: Attachment[] = [];
  conversationId?: string;
  busy = false;
  operation = false;
  needsReopen = false;
  controller?: AbortController;
  status = '';
  draft = '';
  skills: Skill[] = [];
  selectedSkillIds: string[] = [];
  skillContents: SkillContext[] = [];
  skillsRevision = 0;
  usageMonths: Record<string, {input:number; output:number; total:number; estimatedRequests:number; requests:number}>;
  pendingSave?: Message[];
  pendingConversationId?: string;
  pendingDraft?: string;
  previews = new Map<string, string>();
  lastEditor = vscode.window.activeTextEditor;
  readonly apiOutput = vscode.window.createOutputChannel('Azure Chat API');
  constructor(private context: vscode.ExtensionContext) {
    this.usageMonths = context.globalState?.get('azureChat.usageMonths', {}) ?? {};
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument?.(() => this.render()) ?? {dispose() {}}, vscode.workspace.onDidChangeConfiguration?.(() => this.render()) ?? {dispose() {}});
    context.subscriptions.push(this.apiOutput, vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) this.lastEditor = editor; }));
    context.subscriptions.push(vscode.workspace.onDidCloseTextDocument?.(document=>this.previews.delete(document.uri.toString())) ?? {dispose() {}});
    const watcher = vscode.workspace.createFileSystemWatcher?.('**/skills/**');
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const refreshSkills = () => {
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => { void this.refreshSkills().catch(error => {this.status=String(error);this.render();}); },150);
    };
    if (watcher) context.subscriptions.push(watcher,watcher.onDidCreate(refreshSkills),watcher.onDidChange(refreshSkills),watcher.onDidDelete(refreshSkills));
    context.subscriptions.push({dispose:()=>clearTimeout(refreshTimer)},vscode.workspace.onDidChangeWorkspaceFolders?.(refreshSkills) ?? {dispose() {}},vscode.workspace.onDidGrantWorkspaceTrust?.(refreshSkills) ?? {dispose() {}});
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {enableScripts:true, localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};
    const nonce = randomBytes(16).toString('hex');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','chat.js'));
    const markdown = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','markdown-it.min.js'));
    const highlight = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','highlight.min.js'));
    const renderer = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','render-markdown.js'));
    const cards = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','code-cards.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','chat.css'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><header><strong>Azure Chat</strong><button id="configure">Connection</button></header><nav><button id="new">New chat</button><button id="refresh">Refresh</button><button id="delete" disabled>Delete chat</button></nav><label for="chats">Chat history</label><select id="chats"><option value="">New chat</option></select><main id="messages" aria-live="polite"></main><p id="status" role="status"></p><button id="retry" hidden>Retry saving reply</button><section id="attachments"></section><div class="attachments"><button id="pin">Pin current file</button><button id="selection">Attach selection</button></div><details id="usage"><summary>Token usage</summary><p id="context-tokens"></p><p id="skills-tokens"></p><p id="chatbox-tokens"></p><p id="pinned-tokens"></p><p id="overhead-tokens"></p><p id="request-tokens"></p><label for="usage-month">Monthly usage across chats</label><select id="usage-month"></select><p id="monthly-tokens"></p><small>Context counts are estimates (UTF-8 bytes / 4 plus message overhead), excluding backend system prompts and retrieval. Monthly totals cover requests made through this extension on this VS Code profile, starting when tracking was added; months use local time.</small></details><details id="skill-picker" aria-label="Workspace skills" open><summary id="skills-label">Skills (0/0)</summary><div class="skill-body"><div class="skill-heading"><label for="skill-search">Search skills</label><button id="create-skill">New skill</button></div><div id="selected-skills"></div><input id="skill-search" type="search" placeholder="Search skills..." aria-controls="skill-options"><div id="skill-options" role="group" aria-label="Available skills"></div><small id="skill-hint">Select skills to use for generation.</small></div></details><div class="prompt-heading"><label for="prompt">Message</label><span id="message-tokens" title="Estimated next request context, including chat history, your draft, pinned files and selected skills. Excludes backend system prompts and retrieval.">~0 tokens next request</span></div><textarea id="prompt" rows="5" placeholder="Ask about your code…"></textarea><footer><button id="send">Send</button><button id="stop" hidden>Stop</button></footer><script nonce="${nonce}" src="${markdown}"></script><script nonce="${nonce}" src="${highlight}"></script><script nonce="${nonce}" src="${renderer}"></script><script nonce="${nonce}" src="${cards}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async event => {
      if (event.type === 'open-code' && typeof event.text === 'string') {
        try { await this.openCode(event.text,event.path,event.language); }
        catch(error) { void vscode.window.showErrorMessage(String(error)); }
        return;
      }
      if (event.type === 'copy' && typeof event.text === 'string' && Number.isInteger(event.id)) {
        try {
          await vscode.env.clipboard.writeText(event.text);
          void view.webview.postMessage({type:'copied',id:event.id});
        } catch { void view.webview.postMessage({type:'copied',id:event.id,error:true}); }
        return;
      }
      if (event.type === 'draft' && typeof event.text === 'string') { this.draft = event.text; this.render(); return; }
      if (event.type === 'stop') { this.controller?.abort(); return; }
      if (this.operation || this.busy) return;
      this.operation = true; this.render();
      try {
        if (event.type === 'ready') { await this.refreshSkills(); this.render(); if (await this.context.secrets.get('azureChat.token')) await this.list(); }
        else if (event.type === 'configure') await this.configure();
        else if (event.type === 'stop') this.controller?.abort();
        else if (this.busy) return;
        else if (event.type === 'new') { if (this.pendingSave) throw new Error('Save the pending reply before changing chats.'); this.conversationId = undefined; this.messages = []; this.status = ''; this.needsReopen=false; }
        else if (event.type === 'refresh') await this.list();
        else if (event.type === 'delete') await this.deleteChat();
        else if (event.type === 'open' && typeof event.id === 'string') { if (this.pendingSave) throw new Error('Save the pending reply before changing chats.'); this.messages = await (await this.client()).read(event.id); this.conversationId = event.id; this.status = ''; this.needsReopen=false; }
        else if (event.type === 'pin') await this.pinCurrentFile();
        else if (event.type === 'selection') await this.attachSelection();
        else if (event.type === 'remove') this.attachments = this.attachments.filter(a => a.id !== event.id);
        else if (event.type === 'create-skill') await this.createSkill();
        else if (event.type === 'select-skills' && Array.isArray(event.ids) && event.ids.every((id: unknown) => typeof id === 'string')) await this.selectSkills(event.ids);
        else if (event.type === 'send' && typeof event.text === 'string') await this.send(event.text);
        else if (event.type === 'retry') await this.save();
        else if (event.type === 'changes' && Number.isInteger(event.index)) await this.review(event.index);
        else if (event.type === 'apply-code' && typeof event.path === 'string' && typeof event.text === 'string') await this.applyCode(event.text,event.path,event.kind);
      } catch (error) { this.status = error instanceof Error ? error.message : String(error); }
      this.operation=false; this.render();
    }, undefined, this.context.subscriptions);
    view.onDidDispose(() => { this.view = undefined; }, undefined, this.context.subscriptions);
  }
  attachmentText() {
    const attachments = this.attachments.map(({name,content,uri}) => ({name,content: uri ? vscode.workspace.textDocuments?.find(document => document.uri.toString() === uri.toString())?.getText() ?? content : content}));
    return attachments.length ? '\n\nAttached text (JSON):\n' + JSON.stringify(attachments.map(item=>({...item,path:item.name.replace(/:\d+-\d+$/,''),kind:/:\d+-\d+$/.test(item.name) ? 'selection' : 'file'}))) : '';
  }
  compose(text: string) {
    return text + (vscode.workspace.getConfiguration('azureChat').get<boolean>('fileProposalInstructions',false) ? proposalInstruction : '') + this.attachmentText();
  }
  currentSkillContents() {
    return this.skillContents.map((skill,index) => ({...skill,content:vscode.workspace.textDocuments?.find(document=>document.uri.toString()===this.selectedSkillIds[index])?.getText() ?? skill.content}));
  }
  async selectSkills(ids: string[]) {
    const revision = ++this.skillsRevision;
    const selected = [...new Set(ids)];
    const skills = selected.map(id=>this.skills.find(skill=>skill.id===id));
    if (skills.some(skill=>!skill)) throw new Error('A selected skill is no longer available.');
    const max = vscode.workspace.getConfiguration('azureChat').get<number>('maxAttachmentBytes',200000);
    const contents = await readSkills(skills as Skill[],max);
    if (revision === this.skillsRevision) {this.selectedSkillIds=selected;this.skillContents=contents;}
  }
  async refreshSkills() {
    const revision = ++this.skillsRevision;
    const skills = await discoverSkills();
    if (revision !== this.skillsRevision) return;
    const selected = this.selectedSkillIds.filter(id=>skills.some(skill=>skill.id===id));
    const max = vscode.workspace.getConfiguration('azureChat').get<number>('maxAttachmentBytes',200000);
    const contents = await readSkills(selected.map(id=>skills.find(skill=>skill.id===id)!),max);
    if (revision !== this.skillsRevision) return;
    this.skills=skills;this.selectedSkillIds=selected;this.skillContents=contents;this.render();
  }
  async createSkill() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating skills.');
    const roots = vscode.workspace.workspaceFolders;
    if (!roots?.length) throw new Error('Open a workspace folder first.');
    const root = roots.length === 1 ? roots[0] : await vscode.window.showWorkspaceFolderPick();
    if (!root) return;
    if (root.uri.scheme !== 'file') throw new Error('Creating skills currently requires a local workspace folder.');
    const value = await vscode.window.showInputBox({title:'New workspace skill',prompt:'Path inside the root skills folder, for example Test/write-component-unit-test.md. Nested folders are created automatically.',placeHolder:'Test/write-component-unit-test.md',validateInput:value=>{try {skillPath(value);return undefined;} catch(error) {return error instanceof Error ? error.message : String(error);}}});
    if (value === undefined) return;
    const relative = skillPath(value);
    const target = vscode.Uri.joinPath(root.uri,'skills',relative);
    const skillsRoot = vscode.Uri.joinPath(root.uri,'skills');
    const directory = vscode.Uri.joinPath(root.uri,'skills',...relative.split('/').slice(0,-1));
    await validateTarget(root.uri,target);
    try { await validateTarget(skillsRoot,target); } catch (error: any) {if (error.code !== 'ENOENT') throw error;}
    await vscode.workspace.fs.createDirectory(directory);
    await validateTarget(skillsRoot,target);
    const edit = new vscode.WorkspaceEdit();
    edit.createFile(target,{overwrite:false});
    const title = path.posix.basename(relative,path.posix.extname(relative));
    const content = /\.json$/i.test(relative) ? JSON.stringify({instructions:'Describe how to perform this skill.'},null,2) + '\n' : `# ${title}\n\nDescribe how to perform this skill.\n`;
    edit.insert(target,new vscode.Position(0,0),content);
    if (!await vscode.workspace.applyEdit(edit)) throw new Error('Could not create the skill. The file may already exist.');
    await vscode.window.showTextDocument(target);
    await this.refreshSkills();
    this.status='Skill created. Edit its instructions and save the file.';
  }
  tokenState() {
    const content = this.compose(this.draft);
    const draft = {id:'draft',role:'user',content};
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    const skills = this.currentSkillContents();
    const context = contextTokens(this.messages);
    const request = contextTokens(content || skills.length ? withCodeContext(withSkills([...this.messages,draft],skills)) : this.messages);
    const chatbox = estimateTokens(this.draft);
    const pinnedFiles = estimateTokens(this.attachmentText());
    const emptyDraft = {...draft,content:''};
    const skillTokens = contextTokens(withSkills([emptyDraft],skills)) - contextTokens([emptyDraft]);
    return {context, draft:content || skills.length ? contextTokens(withSkills([draft],skills)) : 0,
      chatbox, pinnedFiles, skills:skillTokens, overhead:request-context-chatbox-pinnedFiles-skillTokens,
      request, month, months:this.usageMonths};
  }
  async recordUsage(input: Message[], output: Message, usage?: TokenUsage) {
    const {month} = this.tokenState();
    const previous = this.usageMonths[month] ?? {input:0,output:0,total:0,estimatedRequests:0,requests:0};
    const prompt = usage?.prompt_tokens ?? contextTokens(input);
    const completion = usage?.completion_tokens ?? contextTokens([output]);
    this.usageMonths = {...this.usageMonths, [month]:{input:previous.input+prompt,output:previous.output+completion,
      total:previous.total+(usage?.total_tokens ?? prompt+completion),requests:previous.requests+1,
      estimatedRequests:previous.estimatedRequests+(usage ? 0 : 1)}};
    await this.context.globalState?.update('azureChat.usageMonths',this.usageMonths);
  }
  render() { void this.view?.webview.postMessage({type:'state',tokens:this.tokenState(),messages:this.messages.map(message=>message.role==='user' ? {...message,content:displayPrompt(message.content).replace(proposalInstruction,'')} : message),conversations:this.conversations,conversationId:this.conversationId,attachments:this.attachments.map(({id,name})=>({id,name})),skills:this.skills.map(({id,name})=>({id,name})),selectedSkillIds:this.selectedSkillIds,busy:this.busy || this.operation,generating:this.busy,status:this.status,pendingSave:!!this.pendingSave,needsReopen:this.needsReopen}); }
  async client() {
    const url = vscode.workspace.getConfiguration('azureChat').get<string>('baseUrl') || '';
    const token = await this.context.secrets.get('azureChat.token');
    if (!url || !token) throw new Error('Configure the Azure sample URL and bearer token first.');
    const config = vscode.workspace.getConfiguration('azureChat');
    return new AzureClient(url, token, config.get<boolean>('logApiCalls',false) ? entry => this.apiOutput.appendLine(entry) : undefined, config.get<'GET' | 'POST'>('historyReadMethod','GET'));
  }
  async configure() {
    if (this.busy || this.pendingSave) throw new Error('Finish the current reply and save it before changing connections.');
    const url = await vscode.window.showInputBox({title:'Azure Chat sample base URL',prompt:'Example: https://your-chat-app.azurewebsites.net',value:vscode.workspace.getConfiguration('azureChat').get('baseUrl'),ignoreFocusOut:true,validateInput:value=>{try {new AzureClient(value,'');return undefined;}catch(error){return String(error);}}});
    if (url === undefined) return;
    const token = await vscode.window.showInputBox({title:'User bearer token',prompt:'Token for your deployed chat app. Leave empty to keep the current token.',password:true,ignoreFocusOut:true});
    if (token === undefined) return;
    if (!token.trim() && !await this.context.secrets.get('azureChat.token')) throw new Error('A bearer token is required.');
    await vscode.workspace.getConfiguration('azureChat').update('baseUrl',url,vscode.ConfigurationTarget.Global);
    if (token.trim()) await this.context.secrets.store('azureChat.token',token.trim().replace(/^Bearer\s+/i,''));
    this.messages = []; this.conversationId = undefined; this.conversations = [];
    await this.list(); this.render();
  }
  async list() {
    const data = await (await this.client()).json('/history/list?offset=0');
    if (!Array.isArray(data)) throw new Error('Unexpected chat history response.');
    this.conversations = data;
    this.status = data.length ? '' : 'No chats.';
  }
  async deleteChat() {
    if (this.busy || this.pendingSave) throw new Error('Finish the current reply and save it before deleting the chat.');
    const id = this.conversationId;
    if (!id) return;
    const title = this.conversations.find(c=>c.id===id)?.title || 'Current chat';
    const choice = await vscode.window.showWarningMessage(`Delete "${title}" and all its messages?`, {modal:true}, 'Delete');
    if (choice !== 'Delete') return;
    await (await this.client()).deleteConversation(id);
    this.conversations = this.conversations.filter(c=>c.id!==id);
    this.conversationId = undefined; this.messages = []; this.needsReopen = false;
    this.status = 'Chat deleted.';
  }
  addAttachment(name: string, content: string) {
    const max = vscode.workspace.getConfiguration('azureChat').get<number>('maxAttachmentBytes',200000);
    if (Buffer.byteLength(content,'utf8') + this.attachments.reduce((sum,a)=>sum+Buffer.byteLength(a.content,'utf8'),0) > max) throw new Error(`Attachments exceed the ${max} byte limit.`);
    if (content.includes('\0')) throw new Error('Only text files can be attached.');
    this.attachments.push({id:randomUUID(),name,content});
  }
  async pinCurrentFile() {
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching its files.');
    const editor = vscode.window.activeTextEditor ?? this.lastEditor;
    if (!editor || editor.document.isClosed) throw new Error('Open a text file in an editor first.');
    const uri = editor.document.uri;
    if (this.attachments.some(a => a.uri?.toString() === uri.toString())) return;
    this.addAttachment(vscode.workspace.asRelativePath(uri),editor.document.getText());
    this.attachments[this.attachments.length - 1].uri = uri;
  }
  async attachSelection() {
    if (this.busy) return;
    if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching its files.');
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) throw new Error('Select text in an editor first.');
    this.addAttachment(`${vscode.workspace.asRelativePath(editor.document.uri)}:${editor.selection.start.line+1}-${editor.selection.end.line+1}`,editor.document.getText(editor.selection));
    await vscode.commands.executeCommand('azureChat.chat.focus'); this.render();
  }
  async send(text: string) {
    if(this.needsReopen) throw new Error('Reopen the chat from history or start a new chat before sending.');
    if (this.pendingSave) throw new Error('Save the previous reply before sending another message.');
    if (!text.trim()) return;
    this.draft = text;
    await this.refreshSkills();
    if (this.attachments.some(a => a.uri)) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching its files.');
      const refreshed = await Promise.all(this.attachments.map(async attachment => attachment.uri ? {...attachment, content:(await vscode.workspace.openTextDocument(attachment.uri)).getText()} : attachment));
      const max = vscode.workspace.getConfiguration('azureChat').get<number>('maxAttachmentBytes',200000);
      if (refreshed.reduce((sum,a)=>sum+Buffer.byteLength(a.content,'utf8'),0) > max) throw new Error(`Attachments exceed the ${max} byte limit.`);
      if (refreshed.some(a=>a.content.includes('\0'))) throw new Error('Only text files can be attached.');
      this.attachments = refreshed;
    }
    const selectedSkills = this.currentSkillContents();
    const max = vscode.workspace.getConfiguration('azureChat').get<number>('maxAttachmentBytes',200000);
    const contextBytes = [...selectedSkills,...this.attachments].reduce((sum,item)=>sum+Buffer.byteLength(item.content,'utf8'),0);
    if (contextBytes > max) throw new Error(`Skills and attachments exceed the ${max} byte limit.`);
    if (selectedSkills.some(skill=>skill.content.includes('\0'))) throw new Error('Skills must contain text.');
    const client = await this.client();
    // Use persisted IDs, dates and metadata rather than the previous local turn.
    // The backend can assign different IDs when it stores user messages.
    if (this.conversationId) this.messages = await client.read(this.conversationId);
    const previousMessages = [...this.messages], previousConversationId = this.conversationId;
    const content = this.compose(text);
    this.messages.push({id:randomUUID(),role:'user',content,date:new Date().toISOString()});
    const generationMessages = withCodeContext(withSkills(this.messages,selectedSkills));
    this.busy = true; this.controller = new AbortController(); this.status = 'Generating…';
    const placeholder: Message = {id:randomUUID(),role:'assistant',content:''}; this.messages.push(placeholder); this.render();
    try {
      const response = await client.generate(generationMessages,this.conversationId,AbortSignal.any([this.controller.signal,AbortSignal.timeout(180000)]),(text,metadata)=>{placeholder.content=text; if (metadata.conversation_id) this.conversationId=metadata.conversation_id; this.render();});
      Object.assign(placeholder,response.message);
      // Record generation once, independently of history save/retry or deletion.
      try { await this.recordUsage(generationMessages,response.message,response.usage); }
      catch { void vscode.window.showWarningMessage('Token usage could not be persisted.'); }
      if (!this.conversationId) throw new Error('Reply received without a conversation ID; cannot save history.');
      this.messages.splice(this.messages.length - 1, 0, ...response.tools);
      this.pendingSave = this.messages.map(message=>({...message}));
      this.pendingConversationId = this.conversationId; this.pendingDraft = text;
      await this.save();
      try { await this.list(); } catch { this.status = 'Reply saved. History refresh failed; use Refresh.'; }
    } catch (error) {
      this.messages = previousMessages; this.conversationId = previousConversationId;
      this.needsReopen = !this.pendingSave && !!previousConversationId;
      const detail = this.controller.signal.aborted && !this.pendingSave ? 'Stopped.' : error instanceof Error ? error.message : String(error);
      this.status = `${detail} Your draft is kept. ${this.pendingSave ? 'Use Retry saving reply.' : previousConversationId ? 'Reopen the chat before retrying; Azure may already have saved your message.' : 'Azure may already have saved your message; check history before retrying.'}`;
    } finally {this.busy=false;this.controller=undefined;this.render();}
  }
  async save() {
    const conversationId=this.pendingConversationId ?? this.conversationId;
    if (!this.pendingSave || !conversationId) return;
    await (await this.client()).json('/history/update',{conversation_id:conversationId,messages:this.pendingSave});
    this.messages=this.pendingSave.map(message=>({...message}));this.conversationId=conversationId;
    if(this.pendingDraft!==undefined) {
      if(this.draft===this.pendingDraft)this.draft='';
      void this.view?.webview.postMessage({type:'sent',text:this.pendingDraft});
    }
    this.pendingConversationId=undefined;this.pendingDraft=undefined;
    this.attachments=[];this.selectedSkillIds=[];this.skillContents=[];this.skillsRevision++;
    this.pendingSave=undefined;this.needsReopen=false;this.status='Reply saved to chat history.';
  }
  async openCode(text: string, filePath?: unknown, language?: unknown) {
    if (Buffer.byteLength(text,'utf8')>5000000) throw new Error('Code preview exceeds the 5 MB limit.');
    if (typeof filePath==='string' && filePath && filePath!=='code' && vscode.workspace.workspaceFolders?.length) {
      const safe = parseChanges('```azure-files\n'+JSON.stringify({files:[{path:filePath,content:text}]})+'\n```')[0].path;
      const target = await this.fileTarget(safe); if (!target) return;
      await validateTarget(target.root,target.uri);
      const exists = await vscode.workspace.fs.stat(target.uri).then(()=>true,(error: any)=>{if(error instanceof vscode.FileSystemError && error.code==='FileNotFound')return false;throw error;});
      if (exists) { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(target.uri),{preview:false}); return; }
    }
    const extensions: Record<string,string>={typescript:'ts',javascript:'js',python:'py',kotlin:'kt',csharp:'cs',bash:'sh',powershell:'ps1',diff:'diff',patch:'diff'};
    const label=typeof filePath==='string' && filePath ? path.posix.basename(filePath.replace(/\\/g,'/')).replace(/[^a-z0-9._-]/gi,'_')+(['diff','patch'].includes(String(language)) ? '.diff' : '') : 'code.'+(extensions[String(language)] || String(language || 'txt').replace(/[^a-z0-9]/gi,'') || 'txt');
    const previewPath=typeof filePath==='string' && filePath && filePath!=='code' ? filePath.replace(/\\/g,'/').split('/').map(encodeURIComponent).join('/') : encodeURIComponent(label);
    const preview=vscode.Uri.parse(`azure-chat-preview:/${previewPath}?id=${randomUUID()}`);
    this.previews.set(preview.toString(),text);
    try { const document=await vscode.workspace.openTextDocument(preview); await vscode.window.showTextDocument(document,{preview:false}); }
    catch(error) { this.previews.delete(preview.toString()); throw error; }
  }
  async review(index: number) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace to apply file changes.');
    const message = this.messages[index]; if (message?.role !== 'assistant') return;
    const changes = parseChanges(message.content); if (!changes.length) throw new Error('No azure-files proposal found in this response.');
    await this.reviewFiles(changes.map(change=>({...change,kind:'replacement'})));
  }
  async applyCode(text: string, filePath: string, kind: unknown) {
    if (!filePath || filePath==='code') throw new Error('The code block needs a workspace-relative file path.');
    if (Buffer.byteLength(text,'utf8')>5000000) throw new Error('File proposal exceeds the 5 MB limit.');
    if (!['diff','replacement','snippet'].includes(String(kind))) throw new Error('Unsupported file proposal.');
    const change=parseChanges('```azure-files\n'+JSON.stringify({files:[{path:filePath,content:text}]})+'\n```')[0];
    await this.reviewFiles([{...change,kind:String(kind)}]);
  }
  async fileTarget(filePath: string) {
    const roots = vscode.workspace.workspaceFolders; if (!roots?.length) throw new Error('Open a workspace folder first.');
    const named=roots.length>1 ? roots.find(root=>filePath.startsWith(root.name+'/')) : undefined;
    const root = named ?? (roots.length === 1 ? roots[0] : await vscode.window.showWorkspaceFolderPick()); if (!root) return;
    if (root.uri.scheme !== 'file') throw new Error('File proposals currently require a local workspace folder.');
    const relative=named ? filePath.slice(named.name.length+1) : filePath;
    return {root:root.uri,uri:vscode.Uri.joinPath(root.uri,relative)};
  }
  async reviewFiles(changes: {path:string;content:string;kind:string}[]) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace to apply file changes.');
    for (const change of changes) {
      const resolved=await this.fileTarget(change.path);if(!resolved)return;
      const {root,uri:target}=resolved;
      // Resolve every existing ancestor to prevent symlinks escaping the workspace.
      await validateTarget(root,target);
      let document: vscode.TextDocument | undefined;
      try { document=await vscode.workspace.openTextDocument(target); } catch { try { await vscode.workspace.fs.stat(target); throw new Error('Target exists but cannot be opened as text.'); } catch(error: any) { if (!(error instanceof vscode.FileSystemError && error.code==='FileNotFound')) throw error; } }
      const version=document?.version;
      if (document && change.kind==='snippet') throw new Error('This file already exists. Use a unified diff or a complete replacement to patch it.');
      const proposed=change.kind==='diff' ? applyDiff(document?.getText() ?? '',change.content,change.path) : change.content;
      const preview=vscode.Uri.parse(`azure-chat-preview:/${randomUUID()}/${encodeURIComponent(change.path)}`);
      const original=vscode.Uri.parse(`azure-chat-preview:/${randomUUID()}/empty`);
      this.previews.set(preview.toString(),proposed);this.previews.set(original.toString(),'');
      await vscode.commands.executeCommand('vscode.diff',document ? target : original,preview,`${change.path} — proposed change`);
      const choice = await vscode.window.showInformationMessage(`Apply proposed ${document ? 'replacement' : 'new file'}: ${change.path}?`,{modal:true},'Apply');
      if(choice!=='Apply') continue;
      await validateTarget(root,target);
      if(document && document.version!==version) throw new Error('The file changed during review. Review the proposal again.');
      if(!document) { try {await vscode.workspace.fs.stat(target); throw new Error('The target was created during review. Review again.');} catch(error: any) {if(!(error instanceof vscode.FileSystemError && error.code==='FileNotFound')) throw error;} }
      const edit = new vscode.WorkspaceEdit();
      if(!document) await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(target.fsPath)));
      await validateTarget(root,target);
      if(document) edit.replace(target,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),proposed);
      else {edit.createFile(target,{overwrite:false});edit.insert(target,new vscode.Position(0,0),proposed);}
      if(!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the file change.');
      await vscode.window.showTextDocument(target); this.status='File change applied. Save the editor to write it to disk.';
    }
  }
}
export function activate(context: vscode.ExtensionContext) {
  const chat = new Chat(context);
  context.subscriptions.push(vscode.commands.registerCommand('azureChat.showApiLog',async()=>{
    await vscode.workspace.getConfiguration('azureChat').update('logApiCalls',true,vscode.ConfigurationTarget.Global);
    chat.apiOutput.show(true);
  }));
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('azureChat.chat',chat,{webviewOptions:{retainContextWhenHidden:true}}),vscode.workspace.registerTextDocumentContentProvider('azure-chat-preview',{provideTextDocumentContent:uri=>chat.previews.get(uri.toString()) || ''}),vscode.commands.registerCommand('azureChat.configure',()=>chat.configure().catch(error=>vscode.window.showErrorMessage(String(error)))),vscode.commands.registerCommand('azureChat.attachSelection',()=>chat.attachSelection().catch(error=>vscode.window.showErrorMessage(String(error)))));
}
