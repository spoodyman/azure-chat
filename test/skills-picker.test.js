const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');

function picker(initialState={}) {
  class Element {
    children=[];value='';textContent='';disabled=false;
    append(...children){this.children.push(...children);}
    replaceChildren(...children){this.children=children;}
    add(child){this.append(child);}
  }
  const elements=new Map(),sent=[];let receive,saved=structuredClone(initialState);
  const element=id=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id);};
  vm.runInNewContext(fs.readFileSync(require.resolve('../media/chat.js'),'utf8'),{
    acquireVsCodeApi:()=>({postMessage:event=>sent.push(structuredClone(event)),getState:()=>saved,setState:value=>{saved=structuredClone(value);}}),
    document:{getElementById:element,createElement:()=>new Element()},
    window:{createChatMarkdown:()=>({}),addEventListener:(_type,handler)=>{receive=handler;}},
    Option:class extends Element {constructor(text,value){super();this.textContent=text;this.value=value;}},
    setTimeout
  });
  const state={type:'state',messages:[],conversations:[],attachments:[],skills:[
    {id:'unit',name:'Test/write-component-unit-test.md'},
    {id:'service',name:'Test/write-service-unit-test.json'},
    {id:'component',name:'Component/write-component.md'}
  ],selectedSkillIds:[],busy:false};
  const update=changes=>{Object.assign(state,changes);receive({data:structuredClone(state)});};
  update({});return {element,sent,update,saved:()=>saved,receive};
}

test('skill picker searches paths, selects multiple skills and preserves selections across filters',()=>{
  const {element,sent,update}=picker();
  assert.equal(element('skills-label').textContent,'Skills (0/3)');
  assert.equal(element('skill-options').children.length,3);
  element('skill-search').value='TEST/';element('skill-search').oninput();
  assert.equal(element('skill-options').children.length,2);
  assert.equal(element('skills-label').textContent,'Skills (0/3)');
  element('skill-options').children[0].children[0].onchange();
  assert.deepEqual(sent.at(-1).ids,['unit']);assert.equal(sent.at(-1).type,'select-skills');
  update({selectedSkillIds:['unit']});
  element('skill-search').value='Component/write';element('skill-search').oninput();
  assert.equal(element('selected-skills').children.length,1);
  assert.equal(element('skill-options').children.length,1);
  element('skill-options').children[0].children[0].onchange();
  assert.deepEqual(sent.at(-1).ids,['unit','component']);
  update({selectedSkillIds:['unit','component']});
  assert.equal(element('selected-skills').children.length,2);
  assert.equal(element('skills-label').textContent,'Skills (2/3)');
  assert.match(element('skill-hint').textContent,/2 selected/);
  element('selected-skills').children[0].onclick();assert.deepEqual(sent.at(-1).ids,['component']);
  element('skill-search').value='no matches';element('skill-search').oninput();
  assert.equal(element('skill-options').children[0].textContent,'No matching skills.');
  assert.equal(element('selected-skills').children.length,2);
  element('create-skill').onclick();assert.equal(sent.at(-1).type,'create-skill');
});

test('skill picker displays empty guidance and disables selection during requests',()=>{
  const {element,update}=picker();
  update({busy:true,selectedSkillIds:['unit']});
  assert.equal(element('create-skill').disabled,true);
  assert.equal(element('selected-skills').children[0].disabled,true);
  assert.ok(element('skill-options').children.every(label=>label.children[0].disabled));
  update({busy:false,skills:[],selectedSkillIds:[]});
  assert.equal(element('skills-label').textContent,'Skills (0/0)');
  assert.match(element('skill-options').children[0].textContent,/workspace skills folder/);
  assert.equal(element('create-skill').disabled,false);
});

test('skills stay collapsed across updates, draft edits, sending and webview restoration',()=>{
  const {element,update,saved,receive}=picker({draft:'Existing question'});
  assert.equal(element('skill-picker').open,true);
  element('skill-picker').open=false;element('skill-picker').ontoggle();
  update({selectedSkillIds:['unit','component']});
  assert.equal(element('skill-picker').open,false);
  assert.equal(element('skills-label').textContent,'Skills (2/3)');
  assert.equal(saved().draft,'Existing question');
  element('prompt').value='New question';element('prompt').oninput();
  assert.deepEqual(saved(),{draft:'New question',skillsOpen:false});
  receive({data:{type:'sent'}});
  assert.deepEqual(saved(),{draft:'',skillsOpen:false});
  const restored=picker(saved());
  assert.equal(restored.element('skill-picker').open,false);
});

test('token usage shows separate skills, chatbox and pinned file estimates',()=>{
  const {element,update}=picker();
  update({tokens:{context:10,skills:20,chatbox:30,pinnedFiles:40,overhead:5,request:105,month:'2026-10',months:{}}});
  assert.equal(element('skills-tokens').textContent,'Skills: ~20 tokens');
  assert.equal(element('chatbox-tokens').textContent,'User chatbox: ~30 tokens');
  assert.equal(element('pinned-tokens').textContent,'Pinned files / selections: ~40 tokens');
  assert.equal(element('overhead-tokens').textContent,'Message overhead and instructions: ~5 tokens');
  assert.equal(element('request-tokens').textContent,'Next request context: ~105 tokens');
});
