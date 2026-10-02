export interface Message { id: string; role: string; content: string; date?: string; createdAt?: string; attachments?: unknown; feedback?: unknown; prompt_fragments?: unknown; }
export interface Conversation { id: string; title: string; createdAt?: string; updatedAt?: string; }
export interface FileChange { path: string; content: string; }

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
      body = {...body, messages: body.messages.map((message: Message) => {
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
  async generate(messages: Message[], conversationId: string | undefined, signal: AbortSignal, onUpdate: (text: string, metadata: any) => void): Promise<{message: Message; metadata: any; tools: Message[]}> {
    const response = await this.request('/history/generate', {messages, ...(conversationId ? {conversation_id: conversationId, generated: 'false'} : {})}, signal);
    let content = '', metadata: any = {}, id = '', tools: Message[] = [];
    const consume = (value: any) => {
      if (value.error) throw new Error(typeof value.error === 'string' ? value.error : 'Azure returned a generation error.');
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
    return {message:{id: id || crypto.randomUUID(), role:'assistant', content, date:new Date().toISOString()}, metadata, tools};
  }
}
