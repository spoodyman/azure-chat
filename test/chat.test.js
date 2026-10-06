const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const {pathToFileURL} = require('node:url');

const uri = fsPath => ({fsPath,scheme:'file',toString:()=>pathToFileURL(fsPath).href});
class FileSystemError extends Error {constructor(code){super(code);this.code=code;}}
const workspaceFs = {
  readDirectory:async value=>(await fs.readdir(value.fsPath,{withFileTypes:true})).map(entry=>[entry.name,entry.isSymbolicLink()?64:entry.isDirectory()?2:1]),
  readFile:async value=>fs.readFile(value.fsPath),
  stat:async value=>{try{return await fs.stat(value.fsPath);}catch(error){if(error.code==='ENOENT')throw new FileSystemError('FileNotFound');throw error;}},
  createDirectory:async value=>fs.mkdir(value.fsPath,{recursive:true})
};

function createChat(windowOverrides={}, writeText=async()=>{}, globalState, workspaceOverrides={}) {
  let chat;
  const disposable = {dispose() {}};
  const vscode = {
    Uri: {file:uri,joinPath: (base,...parts)=>uri(path.join(base.fsPath,...parts)),parse:value=>({toString:()=>value,scheme:value.split(':')[0]})},
    FileSystemError,
    Range: class {constructor(start,end){this.start=start;this.end=end;}},
    FileType: {File:1,Directory:2,SymbolicLink:64},
    Position: class {constructor(line,character){this.line=line;this.character=character;}},
    WorkspaceEdit: class {
      edits=[];
      createFile(uri,options){this.edits.push({type:'create',uri,options});}
      insert(uri,position,content){this.edits.push({type:'insert',uri,position,content});}
      replace(uri,range,content){this.edits.push({type:'replace',uri,range,content});}
    },
    env: {clipboard: {writeText}},
    window: {
      createOutputChannel: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      registerWebviewViewProvider: (_id, provider) => {chat = provider; return disposable;},
      ...windowOverrides
    },
    workspace: {
      isTrusted:true,workspaceFolders:[],textDocuments:[],fs:workspaceFs,
      getConfiguration: () => ({get: (_key, fallback) => fallback}),
      registerTextDocumentContentProvider: () => disposable,
      ...workspaceOverrides
    },
    commands: {registerCommand: () => disposable,executeCommand:async()=>{}}
  };
  const originalLoad = Module._load;
  try {
    Module._load = function (name, ...args) {
      return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    delete require.cache[require.resolve('../out/extension')];
    delete require.cache[require.resolve('../out/skills')];
    require('../out/extension').activate({subscriptions: [], globalState,extensionUri:uri(process.cwd())});
  } finally {Module._load = originalLoad;}
  return chat;
}

test('deletion requires confirmation, retains history on failure and clears it after success',async()=>{
  let choice, fail=false;
  const deletions=[];
  const chat=createChat({showWarningMessage:async()=>choice});
  chat.conversationId='chat-1';chat.conversations=[{id:'chat-1',title:'Delete me'},{id:'chat-2',title:'Keep me'}];
  chat.messages=[{id:'m',role:'user',content:'hello'}];chat.needsReopen=true;
  chat.client=async()=>({deleteConversation:async id=>{deletions.push(id);if(fail)throw new Error('Delete failed');}});
  await chat.deleteChat();assert.deepEqual(deletions,[]);assert.equal(chat.messages.length,1);
  choice='Delete';fail=true;
  await assert.rejects(chat.deleteChat(),/Delete failed/);
  assert.equal(chat.conversationId,'chat-1');assert.equal(chat.conversations.length,2);assert.equal(chat.messages.length,1);
  chat.pendingSave=[...chat.messages];
  await assert.rejects(chat.deleteChat(),/save it before deleting/);assert.equal(deletions.length,1);
  chat.pendingSave=undefined;fail=false;
  await chat.deleteChat();assert.equal(chat.conversationId,undefined);assert.deepEqual(chat.messages,[]);
  assert.deepEqual(chat.conversations,[{id:'chat-2',title:'Keep me'}]);assert.equal(chat.needsReopen,false);
});

test('copy writes exact Markdown or code while generating and reports clipboard failures',async()=>{
  const copied=[],responses=[];let receive,fail=false;
  const chat=createChat({},async text=>{if(fail)throw new Error('Clipboard unavailable');copied.push(text);});
  chat.resolveWebviewView({webview:{cspSource:'local',asWebviewUri:uri=>uri,onDidReceiveMessage:handler=>{receive=handler;},postMessage:message=>{responses.push(message);}},onDidDispose:()=>{}});
  chat.busy=true;
  const text='**Reply**\n\n```js\nconst value = "<hello>";\n```\n';
  await receive({type:'copy',id:1,text});
  assert.deepEqual(copied,[text]);assert.deepEqual(responses,[{type:'copied',id:1}]);
  fail=true;await receive({type:'copy',id:2,text:'const x = 1;\n'});
  assert.deepEqual(responses[1],{type:'copied',id:2,error:true});
});

test('larger code views use read-only preview documents and remain available while generating',async()=>{
  let receive;const opened=[],shown=[];
  const chat=createChat({showTextDocument:async(document,options)=>shown.push({document,options})},undefined,undefined,{openTextDocument:async target=>{opened.push(target);return {uri:target};}});
  chat.resolveWebviewView({webview:{cspSource:'local',asWebviewUri:uri=>uri,onDidReceiveMessage:handler=>{receive=handler;},postMessage:()=>{},html:''},onDidDispose:()=>{}});
  chat.busy=true;const text='const value = "<hello>";\n';
  await receive({type:'open-code',text,path:'src/example.ts',language:'typescript'});
  assert.equal(opened[0].scheme,'azure-chat-preview');
  assert.match(opened[0].toString(),/\/src\/example\.ts\?id=/);
  assert.equal(chat.previews.get(opened[0].toString()),text);
  assert.deepEqual(shown[0].options,{preview:false});
  await chat.openCode('@@ -1 +1 @@\n-old\n+new\n','src/example.ts','diff');
  assert.match(opened[1].toString(),/\/src\/example\.ts\?id=/);
  await assert.rejects(chat.openCode('x'.repeat(5000001)),/5 MB/);
});

test('file cards patch current documents, create titled files, and open real workspace paths',async t=>{
  const fixture=await skillWorkspace(t),existing=await fixture.write('src/example.ts','before\n');
  const documents=new Map(),edits=[],shown=[];let choice='Apply',changedDuringReview=false;
  const document={uri:existing,version:1,text:'before\n',getText(){return this.text;},positionAt:offset=>({line:0,character:offset})};
  documents.set(existing.fsPath,document);
  const chat=createChat({
    showTextDocument:async value=>shown.push(value),
    showInformationMessage:async()=>{if(changedDuringReview)document.version++;return choice;}
  },undefined,undefined,{
    ...fixture.workspace,
    openTextDocument:async target=>{
      if(target.scheme!=='file')return {uri:target};
      const found=documents.get(target.fsPath);if(!found)throw new FileSystemError('FileNotFound');return found;
    },
    applyEdit:async edit=>{
      edits.push(edit.edits);
      for(const action of edit.edits) {
        if(action.type==='create') {await fs.writeFile(action.uri.fsPath,'',{flag:'wx'});documents.set(action.uri.fsPath,{uri:action.uri,text:''});}
        else {const target=documents.get(action.uri.fsPath);target.text=action.content;target.version=(target.version||0)+1;}
      }
      return true;
    }
  });
  await chat.openCode('proposed code','src/example.ts','typescript');
  assert.equal(shown[0].uri.fsPath,existing.fsPath);
  await chat.applyCode('--- a/src/example.ts\n+++ b/src/example.ts\n@@ -1 +1 @@\n-before\n+after\n','src/example.ts','diff');
  assert.equal(document.getText(),'after\n');assert.equal(edits[0][0].type,'replace');
  assert.equal(await fs.readFile(existing.fsPath,'utf8'),'before\n');
  await assert.rejects(chat.applyCode('@@ -1 +1 @@\n-before\n+incorrect\n','src/example.ts','diff'),/does not match/);
  assert.equal(edits.length,1);
  choice=undefined;await chat.applyCode('replacement\n','src/example.ts','replacement');assert.equal(edits.length,1);
  choice='Apply';changedDuringReview=true;
  await assert.rejects(chat.applyCode('replacement\n','src/example.ts','replacement'),/changed during review/);
  changedDuringReview=false;assert.equal(document.getText(),'after\n');
  await chat.openCode('export const value = 1;\n','src/deep/new.ts','typescript');
  assert.match(shown.at(-1).uri.toString(),/^azure-chat-preview:\/src\/deep\/new\.ts\?id=/);
  await chat.applyCode('export const value = 1;\n','src/deep/new.ts','snippet');
  const created=path.join(fixture.directory,'src/deep/new.ts');
  assert.equal(documents.get(created).text,'export const value = 1;\n');assert.equal(shown.at(-1).fsPath,created);
  await assert.rejects(chat.applyCode('overwrite','src/example.ts','snippet'),/already exists/);
  for(const bad of ['code','../outside.ts','.git/config','C:\\outside.ts'])await assert.rejects(chat.applyCode('bad',bad,'replacement'));
});

test('successful history saves clear every attachment and skill; failed saves preserve them for retry',async()=>{
  const chat=createChat();chat.conversationId='chat';chat.pendingSave=[{id:'reply',role:'assistant',content:'Done'}];
  const attachments=[{id:'pinned',name:'file.ts',content:'text',uri:uri(process.cwd())},{id:'selection',name:'file.ts:1-2',content:'selection'}];
  chat.attachments=attachments;chat.selectedSkillIds=['skill'];chat.skillContents=[{name:'skill.md',content:'instructions'}];
  let fail=true;chat.client=async()=>({json:async()=>{if(fail)throw new Error('Save failed');return {};}});
  await assert.rejects(chat.save(),/Save failed/);
  assert.deepEqual(chat.attachments,attachments);assert.deepEqual(chat.selectedSkillIds,['skill']);assert.ok(chat.pendingSave);
  fail=false;await chat.save();
  assert.deepEqual(chat.attachments,[]);assert.deepEqual(chat.selectedSkillIds,[]);assert.deepEqual(chat.skillContents,[]);assert.equal(chat.pendingSave,undefined);
});

test('generation includes formatting while updates preserve only user text and attachments',async()=>{
  const generated=[],saved=[];const chat=createChat();
  chat.attachments=[{id:'selection',name:'src/example.ts:3-5',content:'selected code'}];
  chat.conversationId='chat';chat.client=async()=>({read:async()=>[],generate:async messages=>{generated.push(structuredClone(messages));return {message:{id:'reply',role:'assistant',content:'Done'},tools:[],metadata:{}};},json:async(route,body)=>{if(route.startsWith('/history/list'))return [];saved.push(structuredClone(body));return {};}});
  await chat.send('Update the selected code');
  const user=generated[0].at(-1);
  const entries=JSON.parse(user.content.split('\n\nAttached text (JSON):\n')[1]);
  assert.deepEqual(entries,[{name:'src/example.ts:3-5',content:'selected code',path:'src/example.ts',kind:'selection'}]);
  assert.equal(generated[0].length,1);
  assert.match(user.content,/project-relative file path/);
  assert.ok(user.date);
  const {displayPrompt}=require('../out/codeContext');
  assert.ok(displayPrompt(user.content).startsWith('Update the selected code'));
  assert.equal(displayPrompt('Code response instructions:\nMy own text'),'Code response instructions:\nMy own text');
  assert.equal(saved[0].messages[0].content,displayPrompt(user.content));
  assert.equal(saved[0].messages[0].id,user.id);
  assert.equal(saved[0].messages[0].date,user.date);
});

test('follow-ups reload persisted history and retry saving the complete dated conversation', async () => {
  const chat=createChat();

  const history = [
    {id:'stored-user', role:'user', content:'Hello', date:'2026-09-24T19:35:48.359287+00:00', attachments:null, feedback:'', prompt_fragments:[]},
    {id:'stored-assistant', role:'assistant', content:'Hi', date:'2026-09-24T19:33:30.912312+00:00', attachments:null, feedback:'', prompt_fragments:[]}
  ];
  const reads = [], generations = [], saves = [];
  let failSave = true;
  chat.conversationId = 'existing';
  chat.messages = [{id:'local-user', role:'user', content:'Hello'}, {id:'local-assistant', role:'assistant', content:'Hi'}];
  chat.client = async () => ({
    read: async id => {reads.push(id); return structuredClone(history);},
    generate: async (messages, id) => {
      generations.push({messages:structuredClone(messages), id});
      return {message:{id:'reply', role:'assistant', content:'Reply', date:'2026-10-01T20:33:20.935Z'}, tools:[], metadata:{}};
    },
    json: async (route, body) => {
      if (route.startsWith('/history/list')) return [];
      assert.equal(route, '/history/update');
      saves.push(structuredClone(body));
      if (failSave) {failSave = false; throw new Error('Save failed');}
      return {success:true};
    }
  });
  await chat.send('Next');
  assert.deepEqual(reads, ['existing']);
  assert.deepEqual(generations[0].messages.slice(0, 2), history);
  assert.ok(generations[0].messages.at(-1).content.endsWith('Next'));
  assert.ok(generations[0].messages.at(-1).date);
  assert.equal(generations[0].messages[2].role,'user');
  const {historyMessages}=require('../out/codeContext');
  assert.deepEqual(saves[0].messages.slice(0, 3), historyMessages(generations[0].messages));
  assert.equal(saves[0].messages[2].content,'Next');
  assert.equal(saves[0].messages[3].id, 'reply');
  assert.ok(saves[0].messages.every(message => message.date));
  assert.ok(chat.pendingSave);
  const usageBeforeRetry=structuredClone(chat.usageMonths);
  await chat.save();
  assert.deepEqual(chat.usageMonths,usageBeforeRetry);
  assert.equal(Object.values(chat.usageMonths)[0].requests,1);
  assert.deepEqual(saves[1], saves[0]);
  assert.equal(chat.pendingSave, undefined);
});

test('context includes drafts and attachments; monthly usage persists without storing chat contents',async()=>{
  const stored=new Map();
  const globalState={get:(key,fallback)=>stored.get(key)??fallback,update:async(key,value)=>stored.set(key,structuredClone(value))};
  const chat=createChat({},undefined,globalState);
  chat.messages=[{id:'old',role:'assistant',content:'Previous reply'}];
  chat.draft='Question';
  const before=chat.tokenState();
  chat.attachments=[{id:'file',name:'example.txt',content:'Attached reference text'}];
  const after=chat.tokenState();
  assert.equal(after.context,before.context);
  assert.ok(after.draft>before.draft);assert.ok(after.request>before.request);
  await chat.recordUsage(chat.messages,{id:'reply',role:'assistant',content:'Reply'},{prompt_tokens:100,completion_tokens:20,total_tokens:120});
  await chat.recordUsage(chat.messages,{id:'reply2',role:'assistant',content:'Another reply'});
  const restored=createChat({},undefined,globalState);
  const usage=restored.tokenState().months[after.month];
  assert.equal(usage.requests,2);assert.equal(usage.estimatedRequests,1);assert.ok(usage.total>120);
  assert.ok(!JSON.stringify([...stored.values()]).includes('Previous reply'));
});

async function skillWorkspace(t) {
  const directory=await fs.mkdtemp(path.join(os.tmpdir(),'azure-chat-skills-'));
  t.after(()=>fs.rm(directory,{recursive:true,force:true}));
  async function write(relative,content) {
    const file=path.join(directory,relative);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);return uri(file);
  }
  return {directory,write,workspace:{workspaceFolders:[{name:'Project',uri:uri(directory)}]}};
}

test('token breakdown isolates live skills, chatbox and pinned files and adds up to the request',async t=>{
  const fixture=await skillWorkspace(t);
  const skillUri=await fixture.write('skills/test.md','Follow these instructions.');
  const fileUri=uri(path.join(fixture.directory,'example.txt'));
  let skillText='Live skill instructions.',fileText='Live pinned file content.',proposals=false;
  const chat=createChat({},undefined,undefined,{...fixture.workspace,
    textDocuments:[{uri:skillUri,getText:()=>skillText},{uri:fileUri,getText:()=>fileText}],
    getConfiguration:()=>({get:(key,fallback)=>key==='fileProposalInstructions' ? proposals : fallback})
  });
  const checkTotal=()=>{
    const tokens=chat.tokenState();
    assert.equal(tokens.request,tokens.context+tokens.skills+tokens.chatbox+tokens.pinnedFiles+tokens.overhead);
    assert.ok(tokens.overhead>=0);
    return tokens;
  };
  let tokens=checkTotal();
  for(const key of ['context','skills','chatbox','pinnedFiles','overhead','request'])assert.equal(tokens[key],0);
  await chat.refreshSkills();await chat.selectSkills([chat.skills[0].id]);
  tokens=checkTotal();assert.ok(tokens.skills>0);assert.equal(tokens.chatbox,0);assert.equal(tokens.pinnedFiles,0);
  chat.attachments=[{id:'file',name:'example.txt',content:'Cached content',uri:fileUri},
    {id:'selection',name:'selection.txt:1-2',content:'Selected text'}];
  chat.draft='Question about caf\u00e9 and \ud83d\ude00';
  chat.messages=[{id:'previous',role:'assistant',content:'Previous reply'}];
  const before=checkTotal();
  assert.equal(before.chatbox,require('../out/protocol').estimateTokens(chat.draft));
  assert.ok(before.pinnedFiles>0);
  fileText+=' More pinned content.'.repeat(10);
  const filesChanged=checkTotal();
  assert.ok(filesChanged.pinnedFiles>before.pinnedFiles);
  assert.equal(filesChanged.chatbox,before.chatbox);assert.equal(filesChanged.skills,before.skills);
  skillText+=' More skill instructions.'.repeat(10);
  const skillsChanged=checkTotal();
  assert.ok(skillsChanged.skills>filesChanged.skills);
  assert.equal(skillsChanged.chatbox,filesChanged.chatbox);assert.equal(skillsChanged.pinnedFiles,filesChanged.pinnedFiles);
  proposals=true;
  const withInstructions=checkTotal();
  assert.ok(withInstructions.overhead>skillsChanged.overhead);
  assert.equal(withInstructions.skills,skillsChanged.skills);assert.equal(withInstructions.chatbox,skillsChanged.chatbox);
  assert.equal(withInstructions.pinnedFiles,skillsChanged.pinnedFiles);
  proposals=false;await chat.selectSkills([]);chat.attachments=[];chat.draft='';
  tokens=checkTotal();assert.equal(tokens.skills,0);assert.equal(tokens.pinnedFiles,0);assert.equal(tokens.chatbox,0);
  assert.equal(tokens.request,tokens.context);
});

test('skills discover nested Markdown and JSON, refresh deletions, and isolate multiple workspace roots',async t=>{
  const first=await skillWorkspace(t),second=await skillWorkspace(t);
  await first.write('skills/Test/deep/write-unit-test.md','First');
  await first.write('skills/Component/write-component.JSON','{"instructions":"Second"}');
  await first.write('skills/ignored.txt','Ignore');
  await first.write('other/skills/ignored.md','Ignore');
  await second.write('skills/Test/deep/write-unit-test.md','Other project');
  const chat=createChat({},undefined,undefined,{workspaceFolders:[...first.workspace.workspaceFolders,{name:'Other',uri:uri(second.directory)}]});
  await chat.refreshSkills();
  assert.deepEqual(chat.skills.map(skill=>skill.name),['Other/Test/deep/write-unit-test.md','Project/Component/write-component.JSON','Project/Test/deep/write-unit-test.md']);
  assert.equal(new Set(chat.skills.map(skill=>skill.id)).size,3);
  const selected=chat.skills.find(skill=>skill.name.startsWith('Project/Test'));
  await chat.selectSkills([selected.id,selected.id]);assert.equal(chat.selectedSkillIds.length,1);
  await fs.unlink(selected.uri.fsPath);await chat.refreshSkills();
  assert.deepEqual(chat.selectedSkillIds,[]);assert.deepEqual(chat.skillContents,[]);
  await assert.rejects(chat.selectSkills(['unknown']),/no longer available/);
  const untrusted=createChat({},undefined,undefined,{...first.workspace,isTrusted:false});
  await untrusted.refreshSkills();assert.deepEqual(untrusted.skills,[]);
  const empty=await skillWorkspace(t);const emptyChat=createChat({},undefined,undefined,empty.workspace);
  await emptyChat.refreshSkills();assert.deepEqual(emptyChat.skills,[]);
});

test('selected skills use current edits for generation and stay out of history and save retries',async t=>{
  const fixture=await skillWorkspace(t);
  const markdown=await fixture.write('skills/Test/unit.md','Old instructions');
  await fixture.write('skills/Component/component.json','{"instructions":"Use standalone components"}');
  const documents=[];
  const chat=createChat({},undefined,undefined,{...fixture.workspace,textDocuments:documents});
  await chat.refreshSkills();chat.draft='Write tests';
  const before=chat.tokenState();await chat.selectSkills(chat.skills.map(skill=>skill.id));
  assert.ok(chat.tokenState().request>before.request);
  await fs.writeFile(markdown.fsPath,'Updated disk instructions');
  let edited='UNSAVED: Use a fake service and check failure handling.';
  documents.push({uri:markdown,getText:()=>edited});
  const editedTokens=chat.tokenState().request;edited+=' Also cover asynchronous errors.'.repeat(10);
  assert.ok(chat.tokenState().request>editedTokens);
  chat.conversationId='existing';
  const generations=[],saves=[];let failSave=true;
  const history=[{id:'previous',role:'assistant',content:'Prior reply',date:'2026-10-01'}];
  chat.client=async()=>({
    read:async()=>structuredClone(history),
    generate:async messages=>{generations.push(structuredClone(messages));return {message:{id:'reply',role:'assistant',content:'Done',date:'2026-10-05'},tools:[],metadata:{}};},
    json:async(route,body)=>{if(route.startsWith('/history/list'))return [];saves.push(structuredClone(body));if(failSave){failSave=false;throw new Error('Save failed');}return {};}
  });
  await chat.send('Write tests');
  const generated=generations[0];assert.equal(generated.at(-1).role,'user');assert.ok(generated.at(-1).content.endsWith('Write tests'));
  assert.deepEqual(generated[0],history[0]);assert.equal(generated[1].role,'user');
  assert.ok(generated[1].content.includes(edited));assert.ok(generated[1].content.includes('Use standalone components'));
  assert.equal(generated.length,history.length+1);
  assert.ok(generated[1].id && Number.isFinite(Date.parse(generated[1].date)));
  assert.equal(saves[0].messages.at(-2).content,'Write tests');
  assert.equal(saves[0].messages.at(-2).id,generated.at(-1).id);
  assert.ok(!JSON.stringify(saves[0]).includes('UNSAVED'));
  assert.ok(!JSON.stringify(chat.messages).includes('UNSAVED'));
  assert.ok(!JSON.stringify(saves[0]).includes('Code response instructions'));
  assert.ok(saves[0].messages.every(message=>message.role!=='system'));
  await chat.save();assert.deepEqual(saves[1],saves[0]);
  const usage=Object.values(chat.usageMonths)[0];
  const {contextTokens}=require('../out/protocol');assert.equal(usage.input,contextTokens(generated));
  await chat.selectSkills([]);await chat.send('Follow up');
  assert.ok(generations[1].every(message=>message.role!=='system'));
  assert.ok(!generations[1].at(-1).content.includes('Selected skills (JSON)'));
});

test('skill prompts generate and persist through an HTTP history endpoint that rejects synthetic entries',async t=>{
  const http=require('node:http');
  const {AzureClient}=require('../out/protocol');
  const fixture=await skillWorkspace(t);await fixture.write('skills/test.md','Use a fake service.');
  const chat=createChat({},undefined,undefined,fixture.workspace);
  await chat.refreshSkills();await chat.selectSkills([chat.skills[0].id]);
  const requests=[],saves=[];let history=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):undefined;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/history/generate'){
      requests.push(body);
      if(body.messages.some(message=>message.role==='system' || !message.id || !message.date)){
        res.statusCode=500;res.end('{"error":"Error collecting message history"}');return;
      }
      res.end(JSON.stringify({id:'answer-'+requests.length,history_metadata:{conversation_id:'chat'},choices:[{message:{role:'assistant',content:'Done'}}]}));
    }else if(req.url==='/history/update'){
      saves.push(body);history=structuredClone(body.messages);res.end('{"success":true}');
    }else if(req.url.startsWith('/history/read/'))res.end(JSON.stringify(history));
    else res.end('[]');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  chat.client=async()=>new AzureClient(`http://127.0.0.1:${server.address().port}`,'test-token');
  await chat.send('Write tests');assert.equal(chat.pendingSave,undefined);assert.equal(chat.needsReopen,false);
  assert.equal(saves.length,1);assert.equal(requests[0].messages.length,1);
  assert.match(requests[0].messages[0].content,/Use a fake service/);
  await chat.selectSkills([]);await chat.send('Follow up');
  assert.equal(saves.length,2);assert.equal(requests[1].messages.length,3);
  assert.deepEqual(requests[1].messages.slice(0,2),saves[0].messages);
  const {historyMessages}=require('../out/codeContext');
  assert.deepEqual(saves[1].messages.slice(0,-1),historyMessages(requests[1].messages));
  assert.equal(saves[0].messages[0].content,'Write tests');
  assert.equal(saves[1].messages.at(-2).content,'Follow up');
  assert.ok(!requests[1].messages.at(-1).content.includes('Use a fake service'));
});

test('chat filters only at the update boundary and retries preserve text after the first delimiter',async t=>{
  const http=require('node:http');
  const {AzureClient}=require('../out/protocol');
  const fixture=await skillWorkspace(t);await fixture.write('skills/test.md','Full skill body.');
  const chat=createChat({},undefined,undefined,fixture.workspace);
  await chat.refreshSkills();await chat.selectSkills([chat.skills[0].id]);
  const text='Write tests\r\nUser request:\r\nKeep this literal line.  \n';
  const requests=[],saves=[];
  const server=http.createServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    const body=raw?JSON.parse(raw):undefined;
    res.setHeader('Content-Type','application/json');
    if(req.url==='/history/generate'){
      requests.push(body);
      res.end(JSON.stringify({id:'answer',history_metadata:{conversation_id:'chat'},choices:[{message:{role:'assistant',content:'Done'}}]}));
    }else if(req.url==='/history/update'){
      saves.push(body);
      if(saves.length===1){res.statusCode=500;res.end('{"error":"Save failed"}');}
      else res.end('{"success":true}');
    }else res.end('[]');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  chat.client=async()=>new AzureClient(`http://127.0.0.1:${server.address().port}`,'test-token');
  await chat.send(text);
  assert.ok(requests[0].messages[0].content.includes('Full skill body.'));
  assert.ok(requests[0].messages[0].content.endsWith(text));
  assert.equal(chat.messages[0].content,text);
  const pending=structuredClone(chat.pendingSave);
  assert.equal(pending[0].content,text);
  await chat.save();
  assert.deepEqual(saves[1],saves[0]);
  assert.equal(saves[0].messages[0].content,'Keep this literal line.  \n');
  assert.equal(chat.messages[0].content,text);
  assert.equal(chat.pendingSave,undefined);
});

test('skills enforce the combined attachment budget and reject binary text before generation',async t=>{
  const fixture=await skillWorkspace(t);const file=await fixture.write('skills/skill.md','x'.repeat(20));
  const chat=createChat({},undefined,undefined,{...fixture.workspace,getConfiguration:()=>({get:(key,fallback)=>key==='maxAttachmentBytes'?32:fallback})});
  await chat.refreshSkills();await chat.selectSkills([chat.skills[0].id]);
  chat.attachments=[{id:'attached',name:'file.txt',content:'a'.repeat(20)}];
  let called=false;chat.client=async()=>{called=true;throw new Error('Must not send');};
  await assert.rejects(chat.send('Hello'),/Skills and attachments exceed/);assert.equal(called,false);assert.deepEqual(chat.messages,[]);
  chat.attachments=[];await fs.writeFile(file.fsPath,'x'.repeat(40));
  await assert.rejects(chat.send('Hello'),/byte limit/);assert.equal(called,false);
  await fs.writeFile(file.fsPath,'text\0binary');await assert.rejects(chat.send('Hello'),/must contain text/);
});

test('new skills create nested folders and templates without replacing existing files',async t=>{
  const fixture=await skillWorkspace(t);let input='Test/deep/write-unit-test.md';const opened=[];
  const chat=createChat({showInputBox:async()=>input,showTextDocument:async value=>opened.push(value)},undefined,undefined,{
    ...fixture.workspace,
    applyEdit:async edit=>{
      try {for(const action of edit.edits){if(action.type==='create')await fs.writeFile(action.uri.fsPath,'',{flag:'wx'});else await fs.appendFile(action.uri.fsPath,action.content);}return true;}
      catch(error){if(error.code==='EEXIST')return false;throw error;}
    }
  });
  await chat.createSkill();const file=path.join(fixture.directory,'skills',input);
  assert.match(await fs.readFile(file,'utf8'),/# write-unit-test/);assert.equal(opened[0].fsPath,file);
  assert.equal(chat.skills[0].name,input);
  await fs.writeFile(file,'Keep my instructions');await assert.rejects(chat.createSkill(),/may already exist/);
  assert.equal(await fs.readFile(file,'utf8'),'Keep my instructions');
  input='Component/write-component.json';await chat.createSkill();
  assert.equal(typeof JSON.parse(await fs.readFile(path.join(fixture.directory,'skills',input),'utf8')).instructions,'string');
  for (input of ['../outside.md','/absolute.md','C:\\outside.md','Test/../../outside.md','bad.txt','NUL.md','Test/.git/secret.md']) await assert.rejects(chat.createSkill());
  input=undefined;await chat.createSkill();assert.equal(opened.length,2);
});
