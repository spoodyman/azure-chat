(function(root) {
  const extensionLanguages={ts:'typescript',tsx:'tsx',js:'javascript',jsx:'jsx',java:'java',kt:'kotlin',kts:'kotlin',py:'python',cs:'csharp',cpp:'cpp',c:'c',h:'c',go:'go',rs:'rust',rb:'ruby',php:'php',json:'json',xml:'xml',html:'html',css:'css',scss:'scss',md:'markdown',yaml:'yaml',yml:'yaml',sh:'bash',ps1:'powershell',sql:'sql',vue:'xml',svelte:'xml'};
  function relativePath(value) {
    if(typeof value!=='string')return null;
    const path=value.replace(/\\/g,'/');
    if(!path || path.startsWith('/') || /[\x00-\x1f<>"|?*:]/.test(path) || path.split('/').some(part=>!part || part==='.' || part==='..' || /[. ]$/.test(part)))return null;
    return path;
  }
  const languageFor=path=>extensionLanguages[path?.split('.').pop()?.toLowerCase()] || 'text';
  function lines(text) {const value=text.replace(/\r\n?/g,'\n');return value ? value.replace(/\n$/,'').split('\n') : [];}
  // Myers edit distance, bounded so a large unrelated replacement cannot freeze Chromium.
  function lineChanges(before,after) {
    let a=lines(before),b=lines(after),start=0;
    while(start<a.length && start<b.length && a[start]===b[start])start++;
    a=a.slice(start);b=b.slice(start);
    while(a.length && b.length && a[a.length-1]===b[b.length-1]){a.pop();b.pop();}
    if(!a.length || !b.length)return {added:b.length,removed:a.length};
    // No shared lines: the exact result is a complete replacement, without running Myers.
    const unique=new Set(a);
    if(!b.some(line=>unique.has(line)))return {added:b.length,removed:a.length};
    const frontier=new Map([[1,0]]);let work=0;
    for(let distance=0;distance<=a.length+b.length;distance++) {
      for(let diagonal=-distance;diagonal<=distance;diagonal+=2) {
        if(++work>250000)return null;
        const left=frontier.get(diagonal-1) ?? -Infinity,right=frontier.get(diagonal+1) ?? -Infinity;
        let x=diagonal===-distance || diagonal!==distance && left<right ? right : left+1;
        let y=x-diagonal;
        while(x<a.length && y<b.length && a[x]===b[y]){x++;y++;if(++work>250000)return null;}
        frontier.set(diagonal,x);
        if(x>=a.length && y>=b.length)return {added:(distance+b.length-a.length)/2,removed:(distance+a.length-b.length)/2};
      }
    }
    return null;
  }
  function attachedOriginals(messages) {
    const user=[...messages].reverse().find(message=>message.role==='user');
    const originals=new Map();if(!user)return originals;
    const marker='\n\nAttached text (JSON):\n',start=user.content.lastIndexOf(marker);
    if(start<0)return originals;
    try {
      const entries=JSON.parse(user.content.slice(start+marker.length));
      if(!Array.isArray(entries))return originals;
      for(const entry of entries) {
        const path=relativePath(entry.path || entry.name);
        if(path && typeof entry.content==='string' && entry.kind!=='selection' && !/:\d+-\d+$/.test(entry.name || '')) {
          // Ambiguous copies of the same name cannot establish an original.
          originals.set(path,originals.has(path) ? null : entry.content);
        }
      }
    } catch {}
    return originals;
  }
  function fenceInfo(info) {
    const pathMatch=info.match(/(?:^|\s)(?:file|path)=(?:"([^"]+)"|'([^']+)'|(\S+))/);
    let language=info.trim().split(/\s+/)[0] || 'text';
    let path=relativePath(pathMatch?.[1] ?? pathMatch?.[2] ?? pathMatch?.[3]);
    if(!pathMatch && /[/\\]|\.[a-z0-9]+$/i.test(language)){path=relativePath(language);language=languageFor(path);}
    if(/^(file|path)=/.test(language))language=languageFor(path);
    return {path,language,complete:/(?:^|\s)complete=true(?:\s|$)/.test(info),newFile:/(?:^|\s)new=true(?:\s|$)/.test(info)};
  }
  function diffFiles(code,fallbackPath) {
    const result=[];let current=null,inHunk=false,oldRemaining=0,newRemaining=0;
    const rows=code.replace(/\r\n?/g,'\n').split('\n');
    function begin(path,header='') {current={path,language:'diff',code:header,stats:{added:0,removed:0},kind:'diff'};result.push(current);inHunk=false;}
    for(let i=0;i<rows.length;i++) {
      const row=rows[i];
      if(!inHunk && row.startsWith('diff --git ')) {
        const match=row.match(/^diff --git a\/(.*?) b\/(.*)$/);begin(relativePath(match?.[2] || '') || fallbackPath);current.code+=row+'\n';continue;
      }
      if(!inHunk && row.startsWith('--- ') && rows[i+1]?.startsWith('+++ ')) {
        const old=row.slice(4).split('\t')[0],next=rows[i+1].slice(4).split('\t')[0];
        const path=relativePath((next==='/dev/null' ? old : next).replace(/^[ab]\//,'')) || fallbackPath;
        if(!current || current.hasHeaders)begin(path);else current.path=path;
        current.hasHeaders=true;current.code+=row+'\n'+rows[++i]+'\n';continue;
      }
      const hunk=row.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if(hunk) {
        if(!current)begin(fallbackPath);
        current.hasHunks=true;oldRemaining=hunk[2]===undefined ? 1 : Number(hunk[2]);newRemaining=hunk[4]===undefined ? 1 : Number(hunk[4]);inHunk=oldRemaining>0 || newRemaining>0;
      } else if(inHunk) {
        if(row.startsWith('+')){current.stats.added++;newRemaining--;}
        else if(row.startsWith('-')){current.stats.removed++;oldRemaining--;}
        else if(row.startsWith(' ')){oldRemaining--;newRemaining--;}
        else if(!row.startsWith('\\ No newline'))current.invalid=true;
        if(oldRemaining<0 || newRemaining<0)current.invalid=true;
        if(oldRemaining<=0 && newRemaining<=0)inHunk=false;
      }
      if(current)current.code+=row+(i<rows.length-1?'\n':'');
    }
    if(inHunk && current)current.invalid=true;
    for(const file of result)if(!file.hasHunks || file.invalid)file.stats=null;
    return result.length ? result : [{path:fallbackPath,language:'diff',code,kind:'diff',stats:null}];
  }
  function entriesFor(token,originals) {
    if(token.type==='code_block')return [{path:null,language:'text',code:token.content,stats:null,kind:'snippet'}];
    const info=fenceInfo(token.info || '');
    if(info.language==='azure-files') {
      try {
        const value=JSON.parse(token.content);
        if(!Array.isArray(value.files) || !value.files.length)throw new Error();
        const seen=new Set();
        return value.files.map(file=>{
          const path=relativePath(file.path);
          if(!path || typeof file.content!=='string' || seen.has(path.toLowerCase()))throw new Error();
          seen.add(path.toLowerCase());
          const original=originals.get(path);
          return {path,language:languageFor(path),code:file.content,kind:'replacement',stats:typeof original==='string' ? lineChanges(original,file.content) : file.newFile===true ? lineChanges('',file.content) : null};
        });
      } catch {return [{path:null,language:'json',code:token.content,kind:'snippet',stats:null}];}
    }
    if(['diff','patch'].includes(info.language))return diffFiles(token.content,info.path);
    const original=originals.get(info.path);
    const stats=info.path && info.complete ? typeof original==='string' ? lineChanges(original,token.content) : info.newFile ? lineChanges('',token.content) : null : null;
    return [{...info,code:token.content,kind:info.complete?'replacement':'snippet',stats}];
  }
  function buildReply(markdown,content,messages=[]) {
    const originals=attachedOriginals(messages),tokens=markdown.parse(content,{}),groups=[],byPath=new Map();
    for(const token of tokens) {
      if(!['fence','code_block'].includes(token.type))continue;
      const slots=[];
      for(const entry of entriesFor(token,originals)) {
        let group=entry.path ? byPath.get(entry.path) : null;
        if(!group) {
          group={path:entry.path,blocks:[],slot:groups.length};groups.push(group);slots.push(group.slot);
          if(entry.path)byPath.set(entry.path,group);
        }
        group.blocks.push(entry);
      }
      token.type='chat_code';token.meta={slots};
    }
    // The renderer only inserts numeric placeholders. Paths and code become DOM text later.
    markdown.renderer.rules.chat_code=(tokens,index)=>tokens[index].meta.slots.map(slot=>`<div data-code-slot="${slot}"></div>`).join('');
    for(const group of groups) {
      const repeatedReplacement=group.blocks.length>1 && group.blocks.some(block=>block.kind==='replacement');
      group.stats=!repeatedReplacement && group.blocks.every(block=>block.stats) ? group.blocks.reduce((sum,block)=>({added:sum.added+block.stats.added,removed:sum.removed+block.stats.removed}),{added:0,removed:0}) : null;
    }
    return {html:markdown.renderer.render(tokens,markdown.options,{}),groups};
  }
  function createCard(document,group,{copyButton,openCode,highlight,key}) {
    const card=document.createElement('details');card.className='code-accordion';card.dataset.codeKey=key;
    const summary=document.createElement('summary');
    const title=document.createElement('span');title.className='code-path';title.textContent=group.path || 'code';summary.append(title);
    if(group.path) {
      const counts=document.createElement('span');counts.className='code-counts';
      const added=document.createElement('span');added.className='code-added';added.textContent=`+${group.stats?.added ?? '?'}`;
      const removed=document.createElement('span');removed.className='code-removed';removed.textContent=`−${group.stats?.removed ?? '?'}`;
      counts.title=group.stats ? 'Added and removed lines compared with attached full-file context, or counted from a unified diff.' : 'Line counts unavailable: provide the original full file and complete replacement, or a unified diff.';
      counts.append(added,removed);summary.append(counts);
    }
    card.append(summary);
    const scroll=document.createElement('div');scroll.className='code-scroll';
    group.blocks.forEach((block,index)=>{
      const section=document.createElement('section');section.className='code-block';
      const toolbar=document.createElement('div');toolbar.className='code-toolbar';
      const language=document.createElement('span');language.textContent=block.language;
      const actions=document.createElement('span');actions.className='code-actions';
      const open=document.createElement('button');open.textContent='Open in editor';open.title='Open this code in a larger, read-only editor';open.onclick=()=>openCode(block,group.path,index);
      actions.append(copyButton(block.code,'Copy code'),open);toolbar.append(language,actions);
      const pre=document.createElement('pre'),code=document.createElement('code');code.className='language-'+block.language;
      // highlight() uses the bundled highlighter, which escapes code and never enables raw HTML.
      code.innerHTML=highlight(block.code,block.language);pre.append(code);section.append(toolbar,pre);scroll.append(section);
    });
    card.append(scroll);return card;
  }
  const api={relativePath,languageFor,lineChanges,attachedOriginals,fenceInfo,diffFiles,buildReply,createCard};
  if(typeof module==='object' && module.exports)module.exports=api;else root.chatCode=api;
})(globalThis);
