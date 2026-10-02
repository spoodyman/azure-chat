const {test} = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

function createChat(windowOverrides={}, writeText=async()=>{}) {
  let chat;
  const disposable = {dispose() {}};
  const vscode = {
    Uri: {joinPath: (...parts)=>parts.join('/')},
    env: {clipboard: {writeText}},
    window: {
      createOutputChannel: () => disposable,
      onDidChangeActiveTextEditor: () => disposable,
      registerWebviewViewProvider: (_id, provider) => {chat = provider; return disposable;},
      ...windowOverrides
    },
    workspace: {
      getConfiguration: () => ({get: (_key, fallback) => fallback}),
      registerTextDocumentContentProvider: () => disposable
    },
    commands: {registerCommand: () => disposable}
  };
  const originalLoad = Module._load;
  try {
    Module._load = function (name, ...args) {
      return name === 'vscode' ? vscode : originalLoad.call(this, name, ...args);
    };
    delete require.cache[require.resolve('../out/extension')];
    require('../out/extension').activate({subscriptions: []});
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
  assert.equal(generations[0].messages[2].content, 'Next');
  assert.ok(generations[0].messages[2].date);
  assert.deepEqual(saves[0].messages.slice(0, 3), generations[0].messages);
  assert.equal(saves[0].messages[3].id, 'reply');
  assert.ok(saves[0].messages.every(message => message.date));
  assert.ok(chat.pendingSave);
  await chat.save();
  assert.deepEqual(saves[1], saves[0]);
  assert.equal(chat.pendingSave, undefined);
});
