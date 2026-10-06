import {historyMessages} from './codeContext';
export interface Message { id: string; role: string; content: string; date?: string; createdAt?: string; attachments?: unknown; feedback?: unknown; prompt_fragments?: unknown; }
export interface TokenUsage { prompt_tokens: number; completion_tokens: number; total_tokens: number; }
export function readTokenUsage(value: any): TokenUsage | undefined {
  if (!value || !Number.isSafeInteger(value.prompt_tokens) || value.prompt_tokens < 0 ||
      !Number.isSafeInteger(value.completion_tokens) || value.completion_tokens < 0) return undefined;
  const total = value.prompt_tokens + value.completion_tokens;
  return {prompt_tokens:value.prompt_tokens, completion_tokens:value.completion_tokens,
    total_tokens:Number.isSafeInteger(value.total_tokens) && value.total_tokens >= total ? value.total_tokens : total};
}
// Approximation only: the backend model and tokenizer are not exposed by the sample.
export function estimateTokens(text: string): number { return Math.ceil(Buffer.byteLength(text, 'utf8') / 4); }
export function contextTokens(messages: Message[]): number {
  return messages.length ? 3 + messages.reduce((sum, message) => sum + 4 + estimateTokens(message.role) + estimateTokens(message.content || ''), 0) : 0;
}
export interface Conversation { id: string; title: string; createdAt?: string; updatedAt?: string; }
export interface FileChange { path: string; content: string; }

// Apply one file's unified diff exactly; never guess when the current file differs.
export function applyDiff(original: string, patch: string, filePath: string): string {
  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  const source = original.replace(/\r\n?/g,'\n').split('\n');
  if (!original || source.at(-1) === '') source.pop();
  const rows = patch.replace(/\r\n?/g,'\n').split('\n'), output: string[] = [];
  let cursor = 0, hunks = 0, headers = false, finalNewline = /[\r\n]$/.test(original);
  const fail = () => { throw new Error('The patch does not match the current file, or is incomplete. Regenerate it against the current file.'); };
  for (let i = 0; i < rows.length;) {
    const row = rows[i];
    if (row.startsWith('--- ')) {
      if (headers || hunks || !rows[i+1]?.startsWith('+++ ')) fail();
      const oldPath = row.slice(4).split('\t')[0], newPath = rows[i+1].slice(4).split('\t')[0];
      const normalize = (value: string) => value.replace(/^[ab]\//,'').replace(/\\/g,'/');
      if (newPath === '/dev/null' || normalize(newPath) !== filePath || (oldPath !== '/dev/null' && normalize(oldPath) !== filePath) || (oldPath === '/dev/null' && original)) fail();
      headers = true; i += 2; continue;
    }
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?:.*)$/.exec(row);
    if (!hunk) {
      if ((!hunks && /^(?:diff --git |index |new file mode )/.test(row)) || (i === rows.length-1 && row === '')) { i++; continue; }
      fail();
    }
    const oldStart = Number(hunk![1]), oldCount = hunk![2] === undefined ? 1 : Number(hunk![2]);
    const newStart = Number(hunk![3]), newCount = hunk![4] === undefined ? 1 : Number(hunk![4]);
    if (![oldStart,oldCount,newStart,newCount].every(Number.isSafeInteger)) fail();
    const position = oldCount ? oldStart-1 : oldStart, newPosition = newCount ? newStart-1 : newStart;
    if (position < cursor || position > source.length || newPosition !== output.length+position-cursor) fail();
    for (const line of source.slice(cursor,position)) output.push(line); cursor = position; i++;
    let oldUsed = 0, newUsed = 0, previous = '', noNewline = false;
    while (i < rows.length && (oldUsed < oldCount || newUsed < newCount || rows[i] === '\\ No newline at end of file')) {
      const line = rows[i++], sign = line[0];
      if (line === '\\ No newline at end of file') {
        if (!previous || previous === 'marker') fail();
        if (previous !== '-') noNewline = true;
        previous = 'marker'; continue;
      }
      if (![' ','+','-'].includes(sign)) fail();
      if (sign !== '+') { if (cursor >= source.length || source[cursor++] !== line.slice(1)) fail(); oldUsed++; }
      if (sign !== '-') { output.push(line.slice(1)); newUsed++; noNewline = false; }
      if (oldUsed > oldCount || newUsed > newCount) fail();
      previous = sign;
    }
    if (oldUsed !== oldCount || newUsed !== newCount) fail();
    if (cursor === source.length) finalNewline = !noNewline;
    hunks++;
  }
  if (!hunks) fail();
  for (const line of source.slice(cursor)) output.push(line);
  return output.join(newline) + (output.length && finalNewline ? newline : '');
}

export function parseChanges(content: string): FileChange[] {
  const blocks = [...content.matchAll(/```azure-files\s*\n([\s\S]*?)\n```/g)];
  if (!blocks.length) return [];
  const changes: FileChange[] = [];
  for (const block of blocks) {
    const value = JSON.parse(block[1]);
    if (!Array.isArray(value.files)) throw new Error('File proposal must contain a files array.');
    for (const file of value.files) {
      if (typeof file.path !== 'string' || typeof file.content !== 'string' || !file.path ||
          /(^[\\/]|^[a-z]:|[\x00-\x1f<>"|?*]|:)/i.test(file.path) || file.path.split(/[\\/]/).some((part: string) => !part || part === '..' || part === '.' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part) || /^(\.git|\.codex|\.agents|\.aws)$/i.test(part))) {
        throw new Error('File proposals must use safe workspace-relative paths.');
      }
      if (changes.some(c => c.path.toLowerCase() === file.path.replace(/\\/g, '/').toLowerCase())) throw new Error('Duplicate file proposal.');
      changes.push({path: file.path.replace(/\\/g, '/'), content: file.content});
    }
  }
  return changes;
}

export class AzureClient {
  constructor(private baseUrl: string, private token: string, private log?: (entry: string) => void, private readMethod: 'GET' | 'POST' = 'GET') {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP on localhost.');
    if (url.username || url.password || url.search || url.hash) throw new Error('Use a base URL without credentials, query, or fragment.');
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }
  async request(route: string, body?: unknown, signal?: AbortSignal, method = body === undefined ? 'GET' : 'POST'): Promise<Response> {
    if ((route === '/history/generate' || route === '/history/update') && body && typeof body === 'object' && 'messages' in body && Array.isArray(body.messages)) {
      const messages = route === '/history/update' ? historyMessages(body.messages) : body.messages;
      body = {...body, messages: messages.map((message: Message) => {
        const {createdAt, ...fields} = message;
        return createdAt === undefined ? fields : {...fields, date: fields.date ?? createdAt};
      })};
    }
    const requestId = crypto.randomUUID();
    const report = (entry: string) => this.log?.(`[${new Date().toISOString()}] ${requestId} ${this.token ? entry.split(this.token).join('[REDACTED]') : entry}`);
    report(`${method} ${this.baseUrl + route}\nRequest body: ${body === undefined ? '(none)' : JSON.stringify(body, null, 2)}`);
    let response: Response;
    try {
      response = await fetch(this.baseUrl + route, { method, redirect: 'error', headers: {Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json'}, body: body === undefined ? undefined : JSON.stringify(body), signal: signal ?? AbortSignal.timeout(120000) });
    } catch (error) { report(`Request failed: ${error instanceof Error ? error.message : String(error)}`); throw error; }
    report(`Response: ${response.status} ${response.statusText}; Content-Type: ${response.headers.get('content-type') || '(none)'}`);
    if (!response.ok) {
      const text = await response.text();
      report(`Response body: ${text}`);
      let detail = '';
      try { const value = JSON.parse(text); detail = typeof value.error === 'string' ? value.error : typeof value.message === 'string' ? value.message : ''; } catch {}
      detail = (this.token ? detail.split(this.token).join('[REDACTED]') : detail).slice(0,1000);
      throw new Error(`Azure request failed (${response.status}) for ${method} ${route}. ${detail || (response.status === 401 || response.status === 403 ? 'Check your bearer token and app access.' : 'Check Azure Chat API output for the response body.')}`);
    }
    if (this.log) {
      if (response.body) {
        const decoder = new TextDecoder();
        response = new Response(response.body.pipeThrough(new TransformStream<Uint8Array, Uint8Array>({
          transform(chunk, controller) { const text = decoder.decode(chunk, {stream:true}); if (text) report(`Response body chunk: ${text}`); controller.enqueue(chunk); },
          flush() { const text = decoder.decode(); if (text) report(`Response body chunk: ${text}`); report('Response body complete.'); }
        })), {status:response.status, statusText:response.statusText, headers:response.headers});
      }
    }
    return response;
  }
  async json(route: string, body?: unknown): Promise<any> { return (await this.request(route, body)).json(); }
  async deleteConversation(conversationId: string): Promise<void> {
    await this.request('/history/delete', {conversation_id:conversationId}, undefined, 'DELETE');
  }
  async read(conversationId: string): Promise<Message[]> {
    const data = this.readMethod === 'POST'
      ? await this.json('/history/read', {conversation_id:conversationId})
      : await this.json(`/history/read/${encodeURIComponent(conversationId)}`);
    const messages = Array.isArray(data) ? data : data.messages;
    if (!Array.isArray(messages)) throw new Error('Unexpected message history response.');
    return messages;
  }
  async generate(messages: Message[], conversationId: string | undefined, signal: AbortSignal, onUpdate: (text: string, metadata: any) => void): Promise<{message: Message; metadata: any; tools: Message[]; usage?: TokenUsage}> {
    const response = await this.request('/history/generate', {messages, ...(conversationId ? {conversation_id: conversationId, generated: 'false'} : {})}, signal);
    let usage: TokenUsage | undefined;
    let content = '', metadata: any = {}, id = '', tools: Message[] = [];
    const consume = (value: any) => {
      if (value.error) throw new Error(typeof value.error === 'string' ? value.error : 'Azure returned a generation error.');
      usage = readTokenUsage(value.usage) ?? usage;
      metadata = {...metadata, ...value.history_metadata};
      id = value.id || id;
      const choice = value.choices?.[0];
      const items = choice?.messages ?? (choice?.delta ? [choice.delta] : choice?.message ? [choice.message] : []);
      for (const item of items) {
        if (item.role === 'tool') tools.push({...item, id: item.id || id || crypto.randomUUID(), role:'tool', content: item.content || '', date: item.date || new Date().toISOString()});
        else if (!item.role || item.role === 'assistant') content += item.content || '';
      }
      onUpdate(content, metadata);
    };
    {
      if (!response.body) throw new Error('Empty response stream.');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '';
      // Transport chunks need not coincide with JSON objects or newline boundaries.
      const drain = (done: boolean) => {
        while ((pending = pending.trimStart())) {
          if (pending.startsWith('data:')) { pending = pending.slice(5); continue; }
          if (pending.startsWith('[DONE]')) { pending = pending.slice(6); continue; }
          if (/^(?:[:]|event:|id:|retry:)/.test(pending)) {
            const end = pending.indexOf('\n');
            if (end < 0) { if (done) pending = ''; return; }
            pending = pending.slice(end + 1); continue;
          }
          if (pending[0] !== '{') {
            if (!done && ['data:', '[DONE]', 'event:', 'id:', 'retry:'].some(prefix => prefix.startsWith(pending))) return;
            throw new Error('Unexpected generation response format.');
          }
          let depth = 0, quoted = false, escaped = false, end = -1;
          for (let i = 0; i < pending.length; i++) {
            const char = pending[i];
            if (quoted) { if (escaped) escaped = false; else if (char === '\\') escaped = true; else if (char === '"') quoted = false; }
            else if (char === '"') quoted = true;
            else if (char === '{' || char === '[') depth++;
            else if (char === '}' || char === ']') { if (--depth === 0) { end = i + 1; break; } }
          }
          if (end < 0) { if (done) throw new Error('Incomplete generation response.'); return; }
          consume(JSON.parse(pending.slice(0, end))); pending = pending.slice(end);
        }
      };
      try { while (true) { const chunk = await reader.read(); pending += decoder.decode(chunk.value, {stream: !chunk.done}); drain(chunk.done); if (chunk.done) break; } }
      finally { reader.releaseLock(); }
    }
    if (!content) throw new Error('The backend returned no assistant text.');
    return {message:{id: id || crypto.randomUUID(), role:'assistant', content, date:new Date().toISOString()}, metadata, tools, usage};
  }
}
