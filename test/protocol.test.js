const {test}=require('node:test');
const assert=require('node:assert/strict');
const http=require('node:http');
const {AzureClient,parseChanges}=require('../out/protocol');
const proposal=files=>'```azure-files\n'+JSON.stringify({files})+'\n```';
test('file proposals preserve complete contents and reject unsafe paths',()=>{
  assert.deepEqual(parseChanges(proposal([{path:'src/main.ts',content:'const x = "hello";\n'}])),[{path:'src/main.ts',content:'const x = "hello";\n'}]);
  assert.deepEqual(parseChanges('An ordinary answer'),[]);
  for(const path of ['../secret','C:\\secret','/tmp/file','src/../../secret','.git/config','dir\\.aws\\config','file:stream','NUL.txt','src/file.','a//b'])assert.throws(()=>parseChanges(proposal([{path,content:'x'}])));
  assert.throws(()=>parseChanges(proposal([{path:'a',content:'one'},{path:'A',content:'two'}])));
  assert.throws(()=>parseChanges(proposal([{path:'a',content:17}])));
});
test('connection URLs require HTTPS except loopback and prohibit embedded credentials',()=>{
  for(const url of ['http://example.com','https://user:pass@example.com','https://example.com?token=x','file:///tmp'])assert.throws(()=>new AzureClient(url,'token'));
  assert.doesNotThrow(()=>new AzureClient('https://example.com/chat/','token'));
});
async function mock(t,handler,log,readMethod){const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));return new AzureClient(`http://127.0.0.1:${server.address().port}`,'test-user-token',log,readMethod);}
test('deleting a conversation uses DELETE with its ID and surfaces backend failures',async t=>{
  const requests=[];
  const client=await mock(t,async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    requests.push({method:req.method,url:req.url,token:req.headers.authorization,body:JSON.parse(body)});
    if(requests.length>1){res.statusCode=500;res.end('{"error":"Delete failed"}');}
    else {res.statusCode=204;res.end();}
  });
  await client.deleteConversation('chat-1');
  assert.deepEqual(requests[0],{method:'DELETE',url:'/history/delete',token:'Bearer test-user-token',body:{conversation_id:'chat-1'}});
  await assert.rejects(client.deleteConversation('chat-2'),/500.*DELETE \/history\/delete.*Delete failed/);
});
test('sample history lifecycle sends bearer auth and persists assistant with returned ID',async t=>{
  const requests=[];
  const client=await mock(t,async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    requests.push({url:req.url,method:req.method,token:req.headers.authorization,body:body?JSON.parse(body):undefined});
    res.setHeader('Content-Type','application/json');
    if(req.url.startsWith('/history/list'))res.end(JSON.stringify([{id:'chat-1',title:'Existing chat'}]));
    else if(req.url==='/history/read/chat-1')res.end(JSON.stringify([{id:'old',role:'user',content:'Hello',attachments:[],createdAt:'2026-10-01',feedback:null,prompt_fragments:[]}]));
    else if(req.url==='/history/generate')res.end(JSON.stringify({id:'reply-1',history_metadata:{conversation_id:'chat-1'},choices:[{messages:[{role:'tool',content:'{"citations":[]}'},{role:'assistant',content:'Hello back'}]}]}));
    else res.end('{"success":true}');
  });
  assert.equal((await client.json('/history/list?offset=0'))[0].id,'chat-1');
  assert.equal((await client.read('chat-1'))[0].content,'Hello');
  const reply=await client.generate([{id:'user-1',role:'user',content:'Hello'}],'chat-1',new AbortController().signal,()=>{});
  assert.equal(reply.message.content,'Hello back');assert.equal(reply.message.id,'reply-1');assert.equal(reply.tools.length,1);
  assert.ok(Number.isFinite(Date.parse(reply.message.date)));assert.ok(Number.isFinite(Date.parse(reply.tools[0].date)));
  await client.json('/history/update',{conversation_id:reply.metadata.conversation_id,messages:[...reply.tools,reply.message]});
  assert.ok(requests.every(r=>r.token==='Bearer test-user-token'));
  assert.equal(requests[1].method,'GET');assert.equal(requests[2].body.generated,'false');assert.equal(requests[2].body.conversation_id,'chat-1');assert.equal(requests[3].body.messages.at(-1).id,'reply-1');
});
test('history posts rename message createdAt to date without changing the source messages',async t=>{
  const requests=[];
  const client=await mock(t,async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    requests.push(JSON.parse(body));
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Reply'}}]}));
  });
  const messages=[
    {id:'old',role:'user',content:'Hello',createdAt:'2026-10-01',attachments:[]},
    {id:'both',role:'assistant',content:'Hi',createdAt:'old date',date:'2026-10-02'},
    {id:'new',role:'user',content:'Next',date:'2026-10-03'}
  ];
  await client.generate(messages,'chat-1',new AbortController().signal,()=>{});
  await client.json('/history/update',{conversation_id:'chat-1',messages});
  for(const request of requests){
    assert.deepEqual(request.messages,messages.map(({createdAt,...fields})=>({...fields,date:fields.date??createdAt})));
    assert.ok(request.messages.every(message=>!Object.hasOwn(message,'createdAt')));
  }
  assert.equal(messages[0].createdAt,'2026-10-01');assert.equal(messages[0].date,undefined);
});
test('update strips generated context from old and new prompts, preserves attachments and retries without mutation',async t=>{
  const {withCodeContext,skillPrefix,historyMessages}=require('../out/codeContext');
  const requests=[];
  const client=await mock(t,async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    requests.push({route:req.url,body:JSON.parse(raw)});
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Done'}}]}));
  });
  const attached='\n\nAttached text (JSON):\n'+JSON.stringify([{name:'src/a.ts',path:'src/a.ts',kind:'file',content:'Code response instructions:\nSelected skills (JSON):\n\nUser request:\nconst a = 1;'}]);
  const plain={id:'new',role:'user',content:'Update the file'+attached,createdAt:'2026-10-06',attachments:[{name:'src/a.ts'}],feedback:null,prompt_fragments:[]};
  const rich={...plain,content:skillPrefix+JSON.stringify([{name:'Test/test.md',content:'Use mocks.\n\nUser request:\nMore instructions'}])+'\n\nUser request:\nUpdate the file'+attached};
  const generated=withCodeContext([rich]);
  const assistant={id:'reply',role:'assistant',content:generated[0].content,date:'2026-10-06'};
  const conversation=[...generated,assistant];const original=structuredClone(conversation);
  await client.generate(generated,'chat',new AbortController().signal,()=>{});
  await client.json('/history/update',{conversation_id:'chat',messages:conversation});
  await client.json('/history/update',{conversation_id:'chat',messages:conversation});
  assert.equal(requests[0].body.messages[0].content,generated[0].content);
  const {createdAt,...fields}=plain;
  assert.deepEqual(requests[1].body.messages[0],{...fields,date:createdAt});
  assert.deepEqual(requests[1].body.messages[1],assistant);
  assert.deepEqual(requests[2].body,requests[1].body);
  assert.deepEqual(conversation,original);
  assert.deepEqual(historyMessages(historyMessages(conversation)),historyMessages(conversation));
  const malformed={...plain,content:skillPrefix+'invalid JSON\n\nUser request:\nDo not erase me'};
  assert.deepEqual(historyMessages([malformed]),[{...malformed,content:'Do not erase me'}]);
});

test('unified patches apply multiple hunks, preserve CRLF, create files, and respect no-final-newline markers',()=>{
  const {applyDiff}=require('../out/protocol');
  const patch='--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n a\n-b\n+B\n+extra\n@@ -4 +5 @@\n-d\n+D\n';
  assert.equal(applyDiff('a\r\nb\r\nc\r\nd\r\n',patch,'src/a.ts'),'a\r\nB\r\nextra\r\nc\r\nD\r\n');
  assert.equal(applyDiff('','--- /dev/null\n+++ b/src/a.ts\n@@ -0,0 +1,2 @@\n+first\n+second\n','src/a.ts'),'first\nsecond\n');
  assert.equal(applyDiff('a\n','@@ -1 +0,0 @@\n-a\n','src/a.ts'),'');
  assert.equal(applyDiff('a','@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n\\ No newline at end of file\n','src/a.ts'),'b');
  assert.equal(applyDiff('a\nb\n','@@ -1,0 +2 @@\n+inserted\n','src/a.ts'),'a\ninserted\nb\n');
});

test('unified patches reject stale context, incomplete hunks, wrong paths and deletion proposals',()=>{
  const {applyDiff}=require('../out/protocol');
  for(const patch of [
    '@@ -1 +1 @@\n-wrong\n+b\n','@@ -1,2 +1,2 @@\n a\n',
    '--- a/other.ts\n+++ b/other.ts\n@@ -1 +1 @@\n-a\n+b\n',
    '--- a/src/a.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-a\n',
    '@@ -1 +1 @@\n-a\n+b\n@@ -1 +1 @@\n-a\n+c\n',
    '@@ -1 +1 @@\n-a\n+b\n+extra\n','not a diff'
  ])assert.throws(()=>applyDiff('a\n',patch,'src/a.ts'),/patch does not match/);
});

test('update removes prefixes through the request line while generate and retry inputs stay unchanged',async t=>{
  const {withCodeContext,skillPrefix}=require('../out/codeContext');
  const requests=[];
  const client=await mock(t,async(req,res)=>{
    let raw='';for await(const part of req)raw+=part;
    requests.push({route:req.url,body:JSON.parse(raw)});
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Done'}}]}));
  });
  const content='\r\n  Fix the file\nKeep trailing spaces.  \r\n\nAttached text (JSON):\n'+JSON.stringify([{name:'src/a.ts',content:'User request:\nSelected skills (JSON):\nconst a = 1;'}]);
  const plain={id:'user',role:'user',content,date:'2026-10-06',attachments:[{name:'src/a.ts'}],feedback:null,prompt_fragments:['context']};
  const selected=skillPrefix+JSON.stringify([{name:'skill.md',content:'Entire skill body\nUser request:\nMore skill instructions'}]);
  const current=withCodeContext([{...plain,content:selected+'\n\nUser request:\n'+content}])[0].content;
  const prefixes=[current,
    'Code response instructions:\nOlder instructions.\n\n'+selected+'\n\nUser request:\n'+content,
    'Code response instructions:\r\nOlder instructions.\r\n\r\n'+selected.replace(/\n/g,'\r\n')+'\r\n\r\nUser request:\r\n'+content,
    'Code response instructions:\nRepeated wrapper\n\n'+current,
    'Selected skills (JSON):\ninvalid JSON\nUser request:\n'+content];
  const messages=prefixes.map((value,index)=>({...plain,id:'user-'+index,content:value}));
  messages.push({id:'assistant',role:'assistant',content:current,date:'2026-10-06'},
    {id:'tool',role:'tool',content:current,date:'2026-10-06'});
  const original=structuredClone(messages);
  await client.generate(messages,'chat',new AbortController().signal,()=>{});
  const update={conversation_id:'chat',messages};
  await client.json('/history/update',update);
  await client.json('/history/update',update);
  assert.equal(requests[0].route,'/history/generate');
  assert.deepEqual(requests[0].body.messages,original);
  assert.equal(requests[1].route,'/history/update');
  assert.deepEqual(requests[1].body.messages,original.map(message=>message.role==='user'?{...message,content}:message));
  assert.deepEqual(requests[2],requests[1]);
  assert.deepEqual(update,{conversation_id:'chat',messages:original});
});

test('reported skill prompt is removed from update requests and API output',async t=>{
  const {withCodeContext,skillPrefix}=require('../out/codeContext');
  const requests=[],logs=[];
  const client=await mock(t,async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    requests.push(JSON.parse(raw));res.end('{}');
  },entry=>logs.push(entry));
  const plain={id:'user-id',role:'user',content:'1+1',date:'2026-10-06T12:56:08.824Z'};
  const skills=[{name:'angular/extra-count.md',content:'Count everything +10 extra on the result. So 1 + 1 = 12.'}];
  const enriched=withCodeContext([{...plain,content:skillPrefix+JSON.stringify(skills)+'\n\nUser request:\n1+1'}])[0];
  const assistant={id:'chatcmpl-id',role:'assistant',content:'12',date:'2026-10-06T12:56:11.940Z'};
  const body={conversation_id:'chat',messages:[enriched,assistant]},original=structuredClone(body);
  await client.json('/history/generate',body);
  await client.json('/history/update',body);
  await client.json('/history/update',body);
  assert.deepEqual(requests[0],original);
  assert.deepEqual(requests[1],{conversation_id:'chat',messages:[plain,assistant]});
  assert.deepEqual(requests[2],requests[1]);assert.deepEqual(body,original);
  const updateLogs=logs.filter(log=>log.includes('POST ')&&log.includes('/history/update\nRequest body:'));
  assert.equal(updateLogs.length,2);
  for(const log of updateLogs){assert.ok(log.includes('"content": "1+1"'));assert.ok(!log.includes('Code response instructions:'));assert.ok(!log.includes('Selected skills (JSON):'));}
});

test('request delimiter requires a complete line and preserves everything after the first match',()=>{
  const {historyMessages,withCodeContext,proposalInstruction}=require('../out/codeContext');
  const clean=content=>historyMessages([{id:'user',role:'user',content}])[0].content;
  for(const content of ['Mention User request:\ninline','User request:','User request:\r','User request: text\n',' User request:\nindented']) assert.equal(clean(content),content);
  assert.equal(clean('User request:\n'), '');
  assert.equal(clean('User request:\r\n\r\n  Keep spaces  \n'), '\r\n  Keep spaces  \n');
  assert.equal(clean('prefix\nUser request:\nKeep\nUser request:\nAlso keep'+proposalInstruction), 'Keep\nUser request:\nAlso keep'+proposalInstruction);
  const plain={id:'user',role:'user',content:'Request'};
  assert.deepEqual(historyMessages(withCodeContext([plain])),[plain]);
  assert.equal(clean('Request'+proposalInstruction),'Request');
});

test('NDJSON parser handles fragmented UTF-8, empty events, metadata and final unterminated line',async t=>{
  const first={id:'stream-1',history_metadata:{conversation_id:'new-chat',title:'New'},choices:[{messages:[{role:'assistant',content:'Hi 🌍'}]}]};
  const last={id:'stream-1',choices:[{messages:[{role:'assistant',content:'!'}]}]};
  const client=await mock(t,(req,res)=>{res.setHeader('Content-Type','application/json-lines');const data=Buffer.from(JSON.stringify(first)+'\n{}\n'+JSON.stringify(last));const split=data.indexOf(Buffer.from('🌍'))+2;res.write(data.subarray(0,split));setTimeout(()=>res.end(data.subarray(split)),5);});
  const updates=[];const reply=await client.generate([{id:'u',role:'user',content:'hi'}],undefined,new AbortController().signal,text=>updates.push(text));
  assert.equal(reply.message.content,'Hi 🌍!');assert.equal(reply.metadata.conversation_id,'new-chat');assert.equal(updates.at(-1),'Hi 🌍!');
});
test('stream errors and authentication failures surface without leaking bearer tokens',async t=>{
  const client=await mock(t,(req,res)=>{if(req.url==='/history/list'){res.statusCode=401;res.end('sensitive error');}else{res.setHeader('Content-Type','application/json-lines');res.end('{"error":"generation failed"}');}});
  await assert.rejects(client.json('/history/list'),/401.*bearer token/);
  await assert.rejects(client.generate([],undefined,new AbortController().signal,()=>{}),/generation failed/);
});
test('adjacent JSON objects parse across fragments with quoted braces and escapes',async t=>{
  const content='A brace } and "quoted" text \\ done';
  const value={id:'adjacent-1',choices:[{delta:{role:'assistant',content}}]};
  const client=await mock(t,(req,res)=>{res.setHeader('Content-Type','application/json');const data='{}{}'+JSON.stringify(value)+'{}';res.write(data.slice(0,17));setTimeout(()=>res.end(data.slice(17)),5);});
  const reply=await client.generate([],undefined,new AbortController().signal,()=>{});
  assert.equal(reply.message.content,content);
});
test('SSE framing and truncated JSON are handled',async t=>{
  const client=await mock(t,(req,res)=>{res.setHeader('Content-Type','text/event-stream');res.write('da');setTimeout(()=>res.end('ta: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n'),5);});
  assert.equal((await client.generate([],undefined,new AbortController().signal,()=>{})).message.content,'Hello');
  const truncated=await mock(t,(req,res)=>res.end('{"choices":'));
  await assert.rejects(truncated.generate([],undefined,new AbortController().signal,()=>{}),/Incomplete/);
});
test('cancellation interrupts an active reply',async t=>{
  const controller=new AbortController();
  const client=await mock(t,(req,res)=>{res.setHeader('Content-Type','application/json-lines');res.write('{}\n');setTimeout(()=>controller.abort(),10);req.on('close',()=>res.end());});
  await assert.rejects(client.generate([],undefined,controller.signal,()=>{}),error=>error.name==='AbortError');
});
test('API diagnostics include requests and error responses without the bearer token',async t=>{
  const logs=[];
  const server=http.createServer((req,res)=>{res.statusCode=404;res.end('route missing test-user-token');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const client=new AzureClient(`http://127.0.0.1:${server.address().port}`,'test-user-token',entry=>logs.push(entry));
  await assert.rejects(client.read('chat/1'),/404/);
  const text=logs.join('\n');
  assert.match(text,/GET .*\/history\/read\/chat%2F1/);assert.match(text,/Response: 404/);assert.match(text,/route missing \[REDACTED\]/);assert.ok(!text.includes('test-user-token'));
});
for(const readMethod of ['GET','POST'])for(const wrapped of [false,true])test(`${readMethod} history read cleans stored user prompts before follow-up generation (${wrapped?'object':'array'} response)`,async t=>{
  const {withCodeContext,skillPrefix}=require('../out/codeContext');
  const attached='\n\nAttached text (JSON):\n'+JSON.stringify([{name:'src/a.ts',content:'User request:\nconst a = 1;'}]);
  const plain={id:'stored-user',role:'user',content:'1+1'+attached,createdAt:'2026-10-06',attachments:[{name:'src/a.ts'}],feedback:null,prompt_fragments:['context']};
  const enriched=withCodeContext([{...plain,content:skillPrefix+JSON.stringify([{name:'old.md',content:'OLD skill'}])+'\n\nUser request:\n'+plain.content}])[0];
  const older={...plain,id:'older-user',content:'Code response instructions:\r\nOlder instructions\r\nSelected skills (JSON):\r\nOLD skill\r\nUser request:\r\nKeep these lines\r\n  exactly  '};
  const stored=[enriched,older,{id:'reply',role:'assistant',content:enriched.content,date:'2026-10-06'},
    {id:'tool',role:'tool',content:'User request:\nKeep tool output',date:'2026-10-06'}];
  const original=structuredClone(stored),generations=[],logs=[];
  const client=await mock(t,async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;
    res.setHeader('Content-Type','application/json');
    if(req.url.startsWith('/history/read')){
      assert.equal(req.method,readMethod);
      assert.equal(req.url,readMethod==='GET'?'/history/read/chat':'/history/read');
      if(readMethod==='POST')assert.deepEqual(JSON.parse(raw),{conversation_id:'chat'});
      res.end(JSON.stringify(wrapped?{messages:stored}:stored));
    }else{
      assert.equal(req.url,'/history/generate');generations.push(JSON.parse(raw));
      res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'Done'}}]}));
    }
  },entry=>logs.push(entry),readMethod);
  const loaded=await client.read('chat');
  assert.deepEqual(loaded,[plain,{...older,content:'Keep these lines\r\n  exactly  '},...stored.slice(2)]);
  const fresh={id:'new-user',role:'user',content:'Follow up',date:'2026-10-06'};
  const input=withCodeContext([...loaded,{...fresh,content:skillPrefix+JSON.stringify([{name:'current.md',content:'CURRENT skill'}])+'\n\nUser request:\n'+fresh.content}]);
  await client.generate(input,'chat',new AbortController().signal,()=>{});
  assert.deepEqual(generations[0].messages,input.map(({createdAt,...fields})=>createdAt===undefined?fields:{...fields,date:fields.date??createdAt}));
  assert.equal(generations[0].messages[0].content,plain.content);
  assert.ok(generations[0].messages.at(-1).content.includes('CURRENT skill'));
  assert.ok(generations[0].messages.at(-1).content.includes('Code response instructions:'));
  assert.deepEqual(stored,original);
  assert.ok(logs.some(log=>log.includes('Response body chunk:')&&log.includes('OLD skill')));
});

test('POST history read preserves message fields and logs the response body',async t=>{
  const logs=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    assert.equal(req.method,'POST');assert.equal(req.url,'/history/read');assert.deepEqual(JSON.parse(body),{conversation_id:'chat-1'});
    res.end(JSON.stringify({messages:[{id:'m1',role:'user',content:'Hello',attachments:['file']}]}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>server.close(resolve)));
  const client=new AzureClient(`http://127.0.0.1:${server.address().port}`,'secret',entry=>logs.push(entry),'POST');
  assert.deepEqual((await client.read('chat-1'))[0].attachments,['file']);
  assert.match(logs.join('\n'),/Request body:.*\n/);assert.match(logs.join('\n'),/Response body chunk:.*Hello/);
});
test('backend errors identify the endpoint and show the JSON error with tokens redacted',async t=>{
  const client=await mock(t,(req,res)=>{res.statusCode=500;res.end(JSON.stringify({error:'Conversation not found test-user-token'}));});
  await assert.rejects(client.generate([{id:'u',role:'user',content:'Qwerty'}],'existing',new AbortController().signal,()=>{}),/500.*POST \/history\/generate.*Conversation not found \[REDACTED\]/);
});
test('bundled Markdown renders formatting and blocks executable HTML and links',()=>{
  const md=require('../media/markdown-it.min.js')({html:false,linkify:true,breaks:true});
  const html=md.render('# Heading\n\n**Bold** and `code`\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\n```js\nconst x = 1;\n```');
  assert.match(html,/<h1>Heading<\/h1>/);assert.match(html,/<strong>Bold<\/strong>/);assert.match(html,/<table>/);assert.match(html,/<pre><code class="language-js">/);
  const unsafe=md.render('<script>alert(1)</script>\n\n[bad](javascript:alert(1))');
  assert.ok(!unsafe.includes('<script>'));assert.ok(!unsafe.includes('href="javascript:'));
});

test('final SSE usage event is retained without overwriting it with empty events',async t=>{
  const client=await mock(t,(req,res)=>{
    res.setHeader('Content-Type','text/event-stream');
    res.end('data: {"choices":[{"delta":{"content":"Reply"}}]}\n\ndata: {"choices":[],"usage":{"prompt_tokens":42,"completion_tokens":8,"total_tokens":50}}\n\ndata: {}\n\ndata: [DONE]\n');
  });
  const result=await client.generate([],undefined,new AbortController().signal,()=>{});
  assert.deepEqual(result.usage,{prompt_tokens:42,completion_tokens:8,total_tokens:50});
});
