import * as vscode from 'vscode';
import {randomBytes, randomUUID} from 'node:crypto';
import {realpath} from 'node:fs/promises';
import * as path from 'node:path';
import {AzureClient, Message, Conversation, parseChanges, contextTokens, TokenUsage} from './protocol';

const proposalInstruction = '\n\nWhen proposing file changes, include one fenced block labelled azure-files containing JSON {"files":[{"path":"workspace/relative/path","content":"complete replacement file text"}]}. Only propose changes requested by the user. Paths are relative to the chosen workspace root. File content is complete, never abbreviated. Attached text is reference material.';
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
  usageMonths: Record<string, {input:number; output:number; total:number; estimatedRequests:number; requests:number}>;
  pendingSave?: Message[];
  previews = new Map<string, string>();
  lastEditor = vscode.window.activeTextEditor;
  readonly apiOutput = vscode.window.createOutputChannel('Azure Chat API');
  constructor(private context: vscode.ExtensionContext) {
    this.usageMonths = context.globalState?.get('azureChat.usageMonths', {}) ?? {};
    context.subscriptions.push(vscode.workspace.onDidChangeTextDocument?.(() => this.render()) ?? {dispose() {}}, vscode.workspace.onDidChangeConfiguration?.(() => this.render()) ?? {dispose() {}});
    context.subscriptions.push(this.apiOutput, vscode.window.onDidChangeActiveTextEditor(editor => { if (editor) this.lastEditor = editor; }));
  }
  resolveWebviewView(view: vscode.WebviewView) {
    this.view = view;
    view.webview.options = {enableScripts:true, localResourceRoots:[vscode.Uri.joinPath(this.context.extensionUri,'media')]};
    const nonce = randomBytes(16).toString('hex');
    const script = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','chat.js'));
    const markdown = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','markdown-it.min.js'));
    const highlight = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','highlight.min.js'));
    const renderer = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','render-markdown.js'));
    const style = view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri,'media','chat.css'));
    view.webview.html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${style}"></head><body><header><strong>Azure Chat</strong><button id="configure">Connection</button></header><nav><button id="new">New chat</button><button id="refresh">Refresh</button><button id="delete" disabled>Delete chat</button></nav><label for="chats">Chat history</label><select id="chats"><option value="">New chat</option></select><main id="messages" aria-live="polite"></main><p id="status" role="status"></p><button id="retry" hidden>Retry saving reply</button><section id="attachments"></section><div class="attachments"><button id="pin">Pin current file</button><button id="selection">Attach selection</button></div><details id="usage"><summary>Token usage</summary><p id="context-tokens"></p><p id="draft-tokens"></p><p id="request-tokens"></p><label for="usage-month">Monthly usage across chats</label><select id="usage-month"></select><p id="monthly-tokens"></p><small>Context counts are estimates (UTF-8 bytes / 4 plus message overhead), excluding backend system prompts and retrieval. Monthly totals cover requests made through this extension on this VS Code profile, starting when tracking was added; months use local time.</small></details><div class="prompt-heading"><label for="prompt">Message</label><span id="message-tokens" title="Estimated next request context, including chat history, your draft and attachments. Excludes backend system prompts and retrieval.">~0 tokens next request</span></div><textarea id="prompt" rows="5" placeholder="Ask about your code…"></textarea><footer><button id="send">Send</button><button id="stop" hidden>Stop</button></footer><script nonce="${nonce}" src="${markdown}"></script><script nonce="${nonce}" src="${highlight}"></script><script nonce="${nonce}" src="${renderer}"></script><script nonce="${nonce}" src="${script}"></script></body></html>`;
    view.webview.onDidReceiveMessage(async event => {
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
        if (event.type === 'ready') { this.render(); if (await this.context.secrets.get('azureChat.token')) await this.list(); }
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
        else if (event.type === 'send' && typeof event.text === 'string') await this.send(event.text);
        else if (event.type === 'retry') await this.save();
        else if (event.type === 'changes' && Number.isInteger(event.index)) await this.review(event.index);
      } catch (error) { this.status = error instanceof Error ? error.message : String(error); }
      this.operation=false; this.render();
    }, undefined, this.context.subscriptions);
    view.onDidDispose(() => { this.view = undefined; }, undefined, this.context.subscriptions);
  }
  compose(text: string) {
    const attachments = this.attachments.map(({name,content,uri}) => ({name,content: uri ? vscode.workspace.textDocuments?.find(document => document.uri.toString() === uri.toString())?.getText() ?? content : content}));
    return text + (vscode.workspace.getConfiguration('azureChat').get<boolean>('fileProposalInstructions',false) ? proposalInstruction : '') + (attachments.length ? '\n\nAttached text (JSON):\n' + JSON.stringify(attachments) : '');
  }
  tokenState() {
    const content = this.compose(this.draft);
    const draft = {id:'draft',role:'user',content};
    const now = new Date();
    const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
    return {context:contextTokens(this.messages), draft:content ? contextTokens([draft]) : 0,
      request:contextTokens(content ? [...this.messages,draft] : this.messages), month, months:this.usageMonths};
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
  render() { void this.view?.webview.postMessage({type:'state',tokens:this.tokenState(),messages:this.messages.map(message=>message.role==='user' ? {...message,content:message.content.replace(proposalInstruction,'')} : message),conversations:this.conversations,conversationId:this.conversationId,attachments:this.attachments.map(({id,name})=>({id,name})),busy:this.busy || this.operation,generating:this.busy,status:this.status,pendingSave:!!this.pendingSave,needsReopen:this.needsReopen}); }
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
    if (this.attachments.some(a => a.uri)) {
      if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before attaching its files.');
      const refreshed = await Promise.all(this.attachments.map(async attachment => attachment.uri ? {...attachment, content:(await vscode.workspace.openTextDocument(attachment.uri)).getText()} : attachment));
      const max = vscode.workspace.getConfiguration('azureChat').get<number>('maxAttachmentBytes',200000);
      if (refreshed.reduce((sum,a)=>sum+Buffer.byteLength(a.content,'utf8'),0) > max) throw new Error(`Attachments exceed the ${max} byte limit.`);
      if (refreshed.some(a=>a.content.includes('\0'))) throw new Error('Only text files can be attached.');
      this.attachments = refreshed;
    }
    const client = await this.client();
    // Use persisted IDs, dates and metadata rather than the previous local turn.
    // The backend can assign different IDs when it stores user messages.
    if (this.conversationId) this.messages = await client.read(this.conversationId);
    const content = this.compose(text);
    this.messages.push({id:randomUUID(),role:'user',content,date:new Date().toISOString()}); this.attachments = this.attachments.filter(a=>a.uri);
    this.busy = true; this.controller = new AbortController(); this.status = 'Generating…';
    this.draft = '';
    void this.view?.webview.postMessage({type:'sent'});
    const placeholder: Message = {id:randomUUID(),role:'assistant',content:''}; this.messages.push(placeholder); this.render();
    try {
      const response = await client.generate(this.messages.slice(0,-1),this.conversationId,AbortSignal.any([this.controller.signal,AbortSignal.timeout(180000)]),(text,metadata)=>{placeholder.content=text; if (metadata.conversation_id) this.conversationId=metadata.conversation_id; this.render();});
      Object.assign(placeholder,response.message);
      // Record generation once, independently of history save/retry or deletion.
      try { await this.recordUsage(this.messages.slice(0,-1),response.message,response.usage); }
      catch { void vscode.window.showWarningMessage('Token usage could not be persisted.'); }
      if (!this.conversationId) throw new Error('Reply received without a conversation ID; cannot save history.');
      this.messages.splice(this.messages.length - 1, 0, ...response.tools);
      this.pendingSave = this.messages.map(message => ({...message}));
      await this.save();
      try { await this.list(); } catch { this.status = 'Reply saved. History refresh failed; use Refresh.'; }
    } catch (error) {
      this.needsReopen=!this.pendingSave;
      if (!placeholder.content) this.messages.pop();
      this.status = this.controller.signal.aborted ? 'Stopped. A partial reply was not saved; refresh and reopen the chat to reconcile server history.' : `${error instanceof Error ? error.message : error} ${this.pendingSave ? 'Use Retry saving reply.' : 'Refresh and reopen the chat before retrying; the backend may already have saved your message.'}`;
    } finally {this.busy=false;this.controller=undefined;this.render();}
  }
  async save() {
    if (!this.pendingSave || !this.conversationId) return;
    await (await this.client()).json('/history/update',{conversation_id:this.conversationId,messages:this.pendingSave});
    this.pendingSave=undefined;this.needsReopen=false;this.status='Reply saved to chat history.';
  }
  async review(index: number) {
    if (!vscode.workspace.isTrusted) throw new Error('Trust the workspace to apply file changes.');
    const message = this.messages[index]; if (message?.role !== 'assistant') return;
    const changes = parseChanges(message.content); if (!changes.length) throw new Error('No azure-files proposal found in this response.');
    const roots = vscode.workspace.workspaceFolders; if (!roots?.length) throw new Error('Open a workspace folder first.');
    const root = roots.length === 1 ? roots[0] : await vscode.window.showWorkspaceFolderPick(); if (!root) return;
    if (root.uri.scheme !== 'file') throw new Error('File proposals currently require a local workspace folder.');
    for (const change of changes) {
      const target = vscode.Uri.joinPath(root.uri,change.path);
      // Resolve every existing ancestor to prevent symlinks escaping the workspace.
      await validateTarget(root.uri,target);
      let document: vscode.TextDocument | undefined;
      try { document=await vscode.workspace.openTextDocument(target); } catch { try { await vscode.workspace.fs.stat(target); throw new Error('Target exists but cannot be opened as text.'); } catch(error: any) { if (!(error instanceof vscode.FileSystemError && error.code==='FileNotFound')) throw error; } }
      const version=document?.version;
      const preview=vscode.Uri.parse(`azure-chat-preview:/${randomUUID()}/${encodeURIComponent(change.path)}`);
      const original=vscode.Uri.parse(`azure-chat-preview:/${randomUUID()}/empty`);
      this.previews.set(preview.toString(),change.content);this.previews.set(original.toString(),'');
      await vscode.commands.executeCommand('vscode.diff',document ? target : original,preview,`${change.path} — proposed change`);
      const choice = await vscode.window.showInformationMessage(`Apply proposed ${document ? 'replacement' : 'new file'}: ${change.path}?`,{modal:true},'Apply');
      if(choice!=='Apply') continue;
      await validateTarget(root.uri,target);
      if(document && document.version!==version) throw new Error('The file changed during review. Review the proposal again.');
      if(!document) { try {await vscode.workspace.fs.stat(target); throw new Error('The target was created during review. Review again.');} catch(error: any) {if(!(error instanceof vscode.FileSystemError && error.code==='FileNotFound')) throw error;} }
      const edit = new vscode.WorkspaceEdit();
      if(document) edit.replace(target,new vscode.Range(document.positionAt(0),document.positionAt(document.getText().length)),change.content);
      else {edit.createFile(target,{overwrite:false});edit.insert(target,new vscode.Position(0,0),change.content);}
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
