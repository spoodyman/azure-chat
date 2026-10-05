const vscode = acquireVsCodeApi();
const element = id => document.getElementById(id);
const markdown = window.createChatMarkdown(window.markdownit, window.hljs);
let state = {};
const send = (type,extra={}) => vscode.postMessage({type,...extra});
let copyId = 0;
const pendingCopies = new Map();
function copyButton(text, label) {
  const button = document.createElement('button');button.textContent=label;button.title=label;
  button.onclick=()=>{
    const id=++copyId;button.disabled=true;pendingCopies.set(id,{button,label});send('copy',{id,text});
  };
  return button;
}
for (const type of ['configure','new','refresh','pin','selection','stop','retry','delete']) element(type).onclick=()=>send(type);
element('chats').onchange=()=>send(element('chats').value ? 'open' : 'new',{id:element('chats').value});
element('send').onclick=()=>send('send',{text:element('prompt').value});
element('prompt').value=vscode.getState()?.draft || '';
element('prompt').oninput=()=>{vscode.setState({draft:element('prompt').value});send('draft',{text:element('prompt').value});};
function renderMonthlyUsage(){
  const usage=state.tokens?.months[element('usage-month').value];
  element('monthly-tokens').textContent=usage ? `${usage.total.toLocaleString()} tokens (${usage.input.toLocaleString()} input, ${usage.output.toLocaleString()} output), ${usage.requests} requests; ${usage.estimatedRequests} estimated.` : '0 tokens; no recorded requests.';
}
element('usage-month').onchange=renderMonthlyUsage;
element('prompt').onkeydown=event=>{if(event.key==='Enter' && !event.shiftKey && !event.isComposing){event.preventDefault();if(!state.busy && !element('send').disabled)element('send').click();}};
window.addEventListener('message',event=>{
  if(event.data.type==='copied'){
    const pending=pendingCopies.get(event.data.id);if(!pending)return;
    pendingCopies.delete(event.data.id);pending.button.disabled=false;
    pending.button.textContent=event.data.error?'Copy failed':'Copied!';
    setTimeout(()=>{pending.button.textContent=pending.label;},2000);return;
  }
  if(event.data.type==='sent'){element('prompt').value='';vscode.setState({draft:''});return;}
  if(event.data.type!=='state')return;
  state=event.data;
  if(state.tokens){
    element('context-tokens').textContent=`Chat context: ~${state.tokens.context.toLocaleString()} tokens`;
    element('draft-tokens').textContent=`Draft with attachments: ~${state.tokens.draft.toLocaleString()} tokens`;
    element('message-tokens').textContent=`~${state.tokens.request.toLocaleString()} tokens next request`;
    element('request-tokens').textContent=`Next request context: ~${state.tokens.request.toLocaleString()} tokens`;
    const selected=element('usage-month').value || state.tokens.month;
    element('usage-month').replaceChildren(...[...new Set([state.tokens.month,...Object.keys(state.tokens.months)])].sort().reverse().map(month=>new Option(month,month)));
    element('usage-month').value=selected;renderMonthlyUsage();
  }
  const messages=element('messages');const nearBottom=messages.scrollHeight-messages.scrollTop-messages.clientHeight<80;
  messages.replaceChildren();
  state.messages.forEach((message,index)=>{
    const article=document.createElement('article');article.className=message.role;
    const label=document.createElement('strong');label.textContent=message.role==='user'?'You':message.role==='assistant'?'Assistant':message.role;
    const body=document.createElement('div');body.className='content';
    if(message.role==='assistant'){body.classList.add('markdown');body.innerHTML=markdown.render(message.content || '…');}
    else body.textContent=message.content || '…';
    const heading=document.createElement('div');heading.className='message-heading';heading.append(label);
    if(message.role==='assistant' && message.content)heading.append(copyButton(message.content,'Copy reply'));
    article.append(heading,body);
    if(message.role==='assistant')body.querySelectorAll('pre > code').forEach(code=>{
      const wrapper=document.createElement('div');wrapper.className='code-block';
      const toolbar=document.createElement('div');toolbar.className='code-toolbar';
      const language=document.createElement('span');language.textContent=[...code.classList].find(name=>name.startsWith('language-'))?.slice(9) || 'text';
      toolbar.append(language,copyButton(code.textContent,'Copy code'));
      const pre=code.parentElement;pre.replaceWith(wrapper);wrapper.append(toolbar,pre);
    });
    if(message.role==='assistant' && message.content.includes('```azure-files')){const button=document.createElement('button');button.textContent='Review file changes';button.disabled=state.busy;button.onclick=()=>send('changes',{index});article.append(button);}
    messages.append(article);
  });
  if(nearBottom)messages.scrollTop=messages.scrollHeight;
  element('chats').replaceChildren(new Option('New chat',''),...state.conversations.map(c=>new Option(c.title,c.id)));
  if(state.conversationId && !state.conversations.some(c=>c.id===state.conversationId))element('chats').add(new Option('Current chat',state.conversationId));
  element('chats').value=state.conversationId || '';
  element('status').textContent=state.status;
  element('attachments').replaceChildren();
  state.attachments.forEach(a=>{const button=document.createElement('button');button.textContent=`× ${a.name}`;button.title='Remove attachment';button.disabled=state.busy;button.onclick=()=>send('remove',{id:a.id});element('attachments').append(button);});
  for(const id of ['new','refresh','chats','pin','selection','send','configure'])element(id).disabled=state.busy || (['new','chats','send','configure'].includes(id) && state.pendingSave);
  if(state.needsReopen)element('send').disabled=true;
  element('delete').disabled=state.busy || state.pendingSave || !state.conversationId;
  element('stop').hidden=!state.generating;element('retry').hidden=!state.pendingSave;element('retry').disabled=state.busy;
});
send('ready');
send('draft',{text:element('prompt').value});
