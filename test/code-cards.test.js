const {test}=require('node:test');
const assert=require('node:assert/strict');
const code=require('../media/code-cards');
const createMarkdown=require('../media/render-markdown');
const hljs=require('../media/highlight.min');
const markdown=()=>createMarkdown(require('../media/markdown-it.min'),hljs);
const fence=(info,text)=>'```'+info+'\n'+text+'\n```';
const user=entries=>({role:'user',content:'Please update\n\nAttached text (JSON):\n'+JSON.stringify(entries)});
const proposal=files=>fence('azure-files',JSON.stringify({files}));

test('full-file proposals become one accordion per relative path with exact line changes',()=>{
  const reply=code.buildReply(markdown(),'Before\n\n'+proposal([
    {path:'src\\first.ts',content:'same\nnew\nlast\n'},
    {path:'src/new.py',content:'one\ntwo\n',newFile:true}
  ])+'\n\nAfter',[user([{name:'src/first.ts',content:'same\nold\nlast\n'}])]);
  assert.equal(reply.groups.length,2);
  assert.equal(reply.groups[0].path,'src/first.ts');
  assert.deepEqual(reply.groups[0].stats,{added:1,removed:1});
  assert.deepEqual(reply.groups[1].stats,{added:2,removed:0});
  assert.equal(reply.groups[0].blocks[0].language,'typescript');
  assert.equal(reply.groups[0].blocks[0].code,'same\nnew\nlast\n');
  assert.match(reply.html,/<p>Before<\/p>/);assert.match(reply.html,/<p>After<\/p>/);
  assert.equal((reply.html.match(/data-code-slot=/g)||[]).length,2);
  assert.ok(!reply.html.includes('"files"'));
});

test('named snippets group by file and unrelated fences and indented code remain code accordions',()=>{
  const reply=code.buildReply(markdown(),[
    fence('java file="src/Example.java"','class Example {}'),
    fence('java path="src/Example.java"','void run() {}'),
    fence('python','print("hello")'),
    '    unnamed indented code\n',
    fence('src/helper.ts','export const helper = 1;')
  ].join('\n\n'));
  assert.equal(reply.groups.length,4);assert.equal(reply.groups[0].blocks.length,2);
  assert.equal(reply.groups[0].path,'src/Example.java');assert.equal(reply.groups[0].stats,null);
  assert.equal(reply.groups[1].path,null);assert.equal(reply.groups[2].path,null);
  assert.equal(reply.groups[3].path,'src/helper.ts');assert.equal(reply.groups[3].blocks[0].language,'typescript');
});

test('snippet and missing-original counts stay unknown, selections are never whole-file baselines',()=>{
  const original=user([{name:'src/a.ts:1-2',path:'src/a.ts',kind:'selection',content:'old\n'}]);
  for(const info of ['ts file="src/a.ts"','ts file="src/a.ts" complete=true']) {
    const reply=code.buildReply(markdown(),fence(info,'new\n'),[original]);
    assert.equal(reply.groups[0].stats,null);
  }
  assert.equal(code.buildReply(markdown(),proposal([{path:'src/a.ts',content:'new\n'}]),[original]).groups[0].stats,null);
  assert.equal(code.buildReply(markdown(),proposal([{path:'src/a.ts',content:'new\n'}])).groups[0].stats,null);
  assert.deepEqual(code.buildReply(markdown(),fence('ts file="src/a.ts" complete=true new=true','one\ntwo')).groups[0].stats,{added:2,removed:0});
});

test('counts use the nearest user attachment snapshot and survive chat history reloads',()=>{
  const messages=[user([{name:'src/a.ts',content:'outdated\n'}]),{role:'assistant',content:'Earlier reply'},user([{name:'src/a.ts',path:'src/a.ts',kind:'file',content:'same\nold\n'}])];
  const reply=proposal([{path:'src/a.ts',content:'same\nnew\n'}]);
  assert.deepEqual(code.buildReply(markdown(),reply,structuredClone(messages)).groups[0].stats,{added:1,removed:1});
  messages.push({role:'user',content:'Next question without a file'});
  assert.equal(code.buildReply(markdown(),reply,messages).groups[0].stats,null);
  const ambiguous=user([{name:'a.ts',content:'one'},{name:'a.ts',content:'two'}]);
  assert.equal(code.attachedOriginals([ambiguous]).get('a.ts'),null);
});

test('multi-file unified diffs count hunk lines and exclude headers, including code beginning with ---',()=>{
  const patch='diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1,2 +1,3 @@\n same\n-old\n+new\n+extra\ndiff --git a/b.txt b/b.txt\n--- a/b.txt\n+++ b/b.txt\n@@ -1 +1 @@\n---- old text\n++++ new text\n';
  const reply=code.buildReply(markdown(),fence('diff',patch));
  assert.equal(reply.groups.length,2);assert.equal(reply.groups[0].path,'src/a.ts');
  assert.deepEqual(reply.groups[0].stats,{added:2,removed:1});
  assert.deepEqual(reply.groups[1].stats,{added:1,removed:1});
  assert.ok(reply.groups[0].blocks[0].code.startsWith('diff --git'));
  assert.ok(!reply.groups[0].blocks[0].code.includes('a/b.txt'));
  const deletion=code.buildReply(markdown(),fence('diff','--- a/old.txt\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-one\n-two\n'));
  assert.deepEqual(deletion.groups[0].stats,{added:0,removed:2});assert.equal(deletion.groups[0].path,'old.txt');
});

test('fragmented diff and JSON streaming stay readable without claiming incomplete line counts',()=>{
  const partial=code.buildReply(markdown(),'```diff file="a.ts"\n@@ -1,3 +1,3 @@\n old\n-removed\n+added\n');
  assert.equal(partial.groups[0].path,'a.ts');assert.equal(partial.groups[0].stats,null);
  const json=code.buildReply(markdown(),'```azure-files\n{"files":[{"path":"a.ts","content":"partial');
  assert.equal(json.groups[0].path,null);assert.equal(json.groups[0].blocks[0].language,'json');
});

test('unsafe metadata, malicious code, and malformed proposals cannot inject HTML',()=>{
  for(const path of ['../outside.ts','/tmp/a.ts','C:\\a.ts','a\nb\nc']) {
    const reply=code.buildReply(markdown(),proposal([{path,content:'<script>bad()</script>'}]));
    assert.equal(reply.groups[0].path,null);assert.ok(!reply.html.includes('<script>'));
  }
  const reply=code.buildReply(markdown(),fence('js file="src/safe.ts"','</code><script>bad()</script>')+'\n\n[bad](javascript:alert(1))');
  assert.ok(!reply.html.includes('<script>'));assert.ok(!reply.html.includes('href="javascript:'));
  assert.equal(reply.groups[0].blocks[0].code,'</code><script>bad()</script>\n');
  const duplicate=proposal([{path:'a.ts',content:'one'},{path:'A.ts',content:'two'}]);
  assert.equal(code.buildReply(markdown(),duplicate).groups[0].path,null);
});

test('line counts match an independent LCS oracle across edits and repeated lines',()=>{
  function oracle(a,b) {
    const table=Array.from({length:a.length+1},()=>Array(b.length+1).fill(0));
    for(let i=1;i<=a.length;i++)for(let j=1;j<=b.length;j++)table[i][j]=a[i-1]===b[j-1] ? table[i-1][j-1]+1 : Math.max(table[i-1][j],table[i][j-1]);
    return {added:b.length-table[a.length][b.length],removed:a.length-table[a.length][b.length]};
  }
  let seed=42;
  const next=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed;};
  for(let run=0;run<150;run++) {
    const a=Array.from({length:next()%16},()=>String(next()%4)),b=Array.from({length:next()%16},()=>String(next()%4));
    assert.deepEqual(code.lineChanges(a.length ? a.join('\n')+'\n' : '',b.length ? b.join('\n')+'\n' : ''),oracle(a,b));
  }
  assert.deepEqual(code.lineChanges('a\r\nb\r\n','a\nb\n'),{added:0,removed:0});
  assert.deepEqual(code.lineChanges('a\nb\n',''),{added:0,removed:2});
  assert.equal(code.lineChanges(Array(1500).fill('a').concat('same').join('\n'),Array(1500).fill('b').concat('same','b').join('\n')),null);
});

test('cards expose scrollable code, exact copy, and larger-editor actions per block',()=>{
  class Element {
    constructor(tag){this.tag=tag;this.children=[];this.dataset={};}
    append(...children){this.children.push(...children);}
  }
  const document={createElement:tag=>new Element(tag)},copied=[],opened=[];
  const group=code.buildReply(markdown(),proposal([{path:'src/a.ts',content:'const a = "<hi>";\n',newFile:true}])).groups[0];
  const card=code.createCard(document,group,{key:'conversation:1:src/a.ts',
    copyButton:(text,label)=>{const button=new Element('button');button.textContent=label;button.onclick=()=>copied.push(text);return button;},
    openCode:(block,path)=>opened.push({text:block.code,path,language:block.language}),
    highlight:(text,language)=>hljs.highlight(text,{language,ignoreIllegals:true}).value});
  assert.equal(card.tag,'details');assert.equal(card.dataset.codeKey,'conversation:1:src/a.ts');
  assert.equal(card.children[0].tag,'summary');assert.equal(card.children[0].children[0].textContent,'src/a.ts');
  assert.equal(card.children[0].children[1].children[0].textContent,'+1');
  const scroll=card.children[1];assert.equal(scroll.className,'code-scroll');
  const section=scroll.children[0],actions=section.children[0].children[1];
  actions.children[0].onclick();actions.children[1].onclick();
  assert.deepEqual(copied,['const a = "<hi>";\n']);
  assert.deepEqual(opened,[{text:'const a = "<hi>";\n',path:'src/a.ts',language:'typescript'}]);
  assert.ok(section.children[1].children[0].innerHTML.includes('&lt;hi&gt;'));
});
