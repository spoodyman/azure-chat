const vscode = acquireVsCodeApi();
const element = id => document.getElementById(id);
const markdown = window.createChatMarkdown(window.markdownit, window.hljs);
let state = {};
const send = (type,extra={}) => vscode.postMessage({type,...extra});
let copyId = 0;
const pendingCopies = new Map();
const codeViews = new Map();
const replyCache = new Map();
function copyButton(text, label) {
  const button = document.createElement('button');button.textContent=label;button.title=label;
  button.onclick=()=>{
    const id=++copyId;button.disabled=true;pendingCopies.set(id,{button,label});send('copy',{id,text});
  };
  return button;
}
for (const type of ['configure','new','refresh','pin','selection','stop','retry','delete','create-skill']) element(type).onclick=()=>send(type);

function toggleSkill(id) {
  const selected = new Set(state.selectedSkillIds || []);
  if (selected.has(id)) selected.delete(id); else selected.add(id);
  send('select-skills',{ids:[...selected]});
}
function renderSkills() {
  const skills = state.skills || [];
  const selected = new Set(state.selectedSkillIds || []);
  element('skills-label').textContent=`Skills (${skills.filter(skill=>selected.has(skill.id)).length}/${skills.length})`;
  const query = element('skill-search').value.trim().toLocaleLowerCase();
  element('selected-skills').replaceChildren();
  skills.filter(skill=>selected.has(skill.id)).forEach(skill=>{
    const button=document.createElement('button');button.textContent=`× ${skill.name}`;button.title='Remove skill';button.disabled=state.busy;
    button.onclick=()=>toggleSkill(skill.id);element('selected-skills').append(button);
  });
  const options=element('skill-options');options.replaceChildren();
  skills.filter(skill=>skill.name.toLocaleLowerCase().includes(query)).forEach(skill=>{
    const label=document.createElement('label');label.className='skill-option';
    const checkbox=document.createElement('input');checkbox.type='checkbox';checkbox.checked=selected.has(skill.id);checkbox.disabled=state.busy;
    checkbox.onchange=()=>toggleSkill(skill.id);
    const name=document.createElement('span');name.textContent=skill.name;
    label.append(checkbox,name);options.append(label);
  });
  if (!options.children.length) {
    const empty=document.createElement('p');empty.textContent=skills.length ? 'No matching skills.' : 'Add .md or .json files under the workspace skills folder.';options.append(empty);
  }
  element('skill-hint').textContent=`${selected.size} selected · Used for generation only.`;
  element('create-skill').disabled=!!state.busy;
}
element('skill-search').oninput=renderSkills;
element('skill-picker').open=vscode.getState()?.skillsOpen ?? true;
element('skill-picker').ontoggle=()=>vscode.setState({...vscode.getState(),skillsOpen:element('skill-picker').open});
element('chats').onchange=()=>send(element('chats').value ? 'open' : 'new',{id:element('chats').value});
element('send').onclick=()=>send('send',{text:element('prompt').value});
element('prompt').value=vscode.getState()?.draft || '';
element('prompt').oninput=()=>{vscode.setState({...vscode.getState(),draft:element('prompt').value});send('draft',{text:element('prompt').value});};
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
  if(event.data.type==='sent'){element('prompt').value='';vscode.setState({...vscode.getState(),draft:''});return;}
  if(event.data.type!=='state')return;
  state=event.data;
  if(state.tokens){
    element('context-tokens').textContent=`Chat context: ~${state.tokens.context.toLocaleString()} tokens`;
    element('skills-tokens').textContent=`Skills: ~${state.tokens.skills.toLocaleString()} tokens`;
    element('chatbox-tokens').textContent=`User chatbox: ~${state.tokens.chatbox.toLocaleString()} tokens`;
    element('pinned-tokens').textContent=`Pinned files / selections: ~${state.tokens.pinnedFiles.toLocaleString()} tokens`;
    element('overhead-tokens').textContent=`Message overhead and instructions: ~${state.tokens.overhead.toLocaleString()} tokens`;
    element('message-tokens').textContent=`~${state.tokens.request.toLocaleString()} tokens next request`;
    element('request-tokens').textContent=`Next request context: ~${state.tokens.request.toLocaleString()} tokens`;
    const selected=element('usage-month').value || state.tokens.month;
    element('usage-month').replaceChildren(...[...new Set([state.tokens.month,...Object.keys(state.tokens.months)])].sort().reverse().map(month=>new Option(month,month)));
    element('usage-month').value=selected;renderMonthlyUsage();
  }
  const messages=element('messages'),page=document.scrollingElement || messages,previousTop=page.scrollTop;
  const nearBottom=page.scrollHeight-page.scrollTop-page.clientHeight<80;
  for(const card of messages.querySelectorAll?.('.code-accordion') || []) {
    const scroll=card.querySelector('.code-scroll');
    codeViews.set(card.dataset.codeKey,{open:card.open,top:scroll.scrollTop,left:scroll.scrollLeft});
  }
  while(codeViews.size>500)codeViews.delete(codeViews.keys().next().value);
  messages.replaceChildren();
  let sourceUser='';
  state.messages.forEach((message,index)=>{
    if(message.role==='user')sourceUser=message.content;
    const article=document.createElement('article');article.className=message.role;
    const label=document.createElement('strong');label.textContent=message.role==='user'?'You':message.role==='assistant'?'Assistant':message.role;
    const body=document.createElement('div');body.className='content';
    let reply;
    if(message.role==='assistant'){
      body.classList.add('markdown');
      const key=`${state.conversationId || 'new'}:${index}`;
      const cached=replyCache.get(key);
      reply=cached?.content===message.content && cached?.sourceUser===sourceUser ? cached.reply : window.chatCode.buildReply(markdown,message.content || '…',[{role:'user',content:sourceUser}]);
      replyCache.set(key,{content:message.content,sourceUser,reply});
      while(replyCache.size>64)replyCache.delete(replyCache.keys().next().value);
      body.innerHTML=reply.html;
    }
    else body.textContent=message.content || '…';
    const heading=document.createElement('div');heading.className='message-heading';heading.append(label);
    if(message.role==='assistant' && message.content)heading.append(copyButton(message.content,'Copy reply'));
    article.append(heading,body);
    messages.append(article);
    if(reply)reply.groups.forEach(group=>{
      const key=`${state.conversationId || 'new'}:${index}:${group.path || 'code-'+group.slot}`;
      const card=window.chatCode.createCard(document,group,{key,copyButton,busy:state.busy,
        openCode:(block,path)=>send('open-code',{text:block.code,path:path || '',language:block.language}),
        applyCode:(block,path)=>send('apply-code',{text:block.code,path,kind:block.kind}),
        highlight:(code,language)=>window.hljs.getLanguage(language) ? window.hljs.highlight(code,{language,ignoreIllegals:true}).value : markdown.utils.escapeHtml(code)});
      const saved=codeViews.get(key);if(saved)card.open=saved.open;
      body.querySelector(`[data-code-slot="${group.slot}"]`)?.replaceWith(card);
      if(saved){const scroll=card.querySelector('.code-scroll');scroll.scrollTop=saved.top;scroll.scrollLeft=saved.left;}
    });
    if(message.role==='assistant' && message.content.includes('```azure-files')){const button=document.createElement('button');button.textContent='Review file changes';button.disabled=state.busy;button.onclick=()=>send('changes',{index});article.append(button);}
  });
  page.scrollTop=nearBottom ? page.scrollHeight : previousTop;
  element('chats').replaceChildren(new Option('New chat',''),...state.conversations.map(c=>new Option(c.title,c.id)));
  if(state.conversationId && !state.conversations.some(c=>c.id===state.conversationId))element('chats').add(new Option('Current chat',state.conversationId));
  element('chats').value=state.conversationId || '';
  element('status').textContent=state.status;
  element('attachments').replaceChildren();
  state.attachments.forEach(a=>{const button=document.createElement('button');button.textContent=`× ${a.name}`;button.title='Remove attachment';button.disabled=state.busy;button.onclick=()=>send('remove',{id:a.id});element('attachments').append(button);});
  renderSkills();
  for(const id of ['new','refresh','chats','pin','selection','send','configure'])element(id).disabled=state.busy || (['new','chats','send','configure'].includes(id) && state.pendingSave);
  if(state.needsReopen)element('send').disabled=true;
  element('delete').disabled=state.busy || state.pendingSave || !state.conversationId;
  element('stop').hidden=!state.generating;element('retry').hidden=!state.pendingSave;element('retry').disabled=state.busy;
});
send('ready');
send('draft',{text:element('prompt').value});
