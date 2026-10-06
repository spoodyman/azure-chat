// Generate a browser fixture for the shared IntelliJ/VS Code UI; no Azure connection.
const fs=require('node:fs');
const path=require('node:path');
const root=path.resolve(__dirname,'..');
const body=fs.readFileSync(path.join(root,'intellij/src/main/resources/web/body.html'),'utf8');
const before=Array.from({length:65},(_,index)=>index===40 ? 'export const oldValue = 1;' : `// Existing line ${index+1}`).join('\n')+'\n';
const after=before.replace('export const oldValue = 1;','export const newValue = 2;\nexport const anotherValue = 3;');
const proposal='```azure-files\n'+JSON.stringify({files:[{path:'src/example.ts',content:after},{path:'src/helper.ts',content:'export function helper() {\n  return 42;\n}\n',newFile:true}]})+'\n```';
const state={type:'state',conversationId:'preview',conversations:[{id:'preview',title:'Code accordion preview'}],messages:[
  {id:'user',role:'user',content:'Update the example.\n\nAttached text (JSON):\n'+JSON.stringify([{name:'src/example.ts',path:'src/example.ts',kind:'file',content:before}])},
  {id:'assistant',role:'assistant',content:'Updated the example and added a helper.\n\n'+proposal+'\n\nAn unrelated example:\n\n```python\nprint("hello")\n```'}
],skills:[],selectedSkillIds:[],attachments:[],status:'Preview only',busy:false};
const bootstrap=`const events=[];let saved={skillsOpen:false};window.acquireVsCodeApi=()=>({postMessage:event=>events.push(event),getState:()=>saved,setState:value=>saved=value});`;
const check=`
  let previewState=${JSON.stringify(state).replace(/</g,'\\u003c')};
  const update=()=>window.dispatchEvent(new MessageEvent('message',{data:structuredClone(previewState)}));
  try {
    update();
    let cards=document.querySelectorAll('.code-accordion');
    if(cards.length!==3)throw Error('Expected two files and one code accordion');
    if(cards[0].querySelector('.code-added').textContent!=='+2' || cards[0].querySelector('.code-removed').textContent!=='−1')throw Error('Incorrect change counts');
    if(cards[2].querySelector('.code-path').textContent!=='code')throw Error('Unnamed code label');
    cards[0].open=true;
    if(cards[0].querySelector('.code-scroll').clientHeight<cards[0].querySelector('pre').clientHeight)throw Error('Code is vertically constrained');
    cards[0].querySelector('.code-scroll').scrollLeft=5;
    cards[0].querySelector('.code-actions button:last-child').click();
    if(events.at(-1).type!=='open-code' || events.at(-1).path!=='src/example.ts')throw Error('Open in editor bridge failed');
    update();cards=document.querySelectorAll('.code-accordion');
    if(!cards[0].open)throw Error('Expanded state lost on render');
    cards[0].open=false;update();cards=document.querySelectorAll('.code-accordion');
    if(cards[0].open)throw Error('Collapsed state lost on render');
    previewState.busy=true;previewState.generating=true;update();
    if([...document.querySelectorAll('.code-accordion')].some(card=>!card.open))throw Error('Streaming code did not expand');
    previewState.messages[1].content+=${JSON.stringify('\n\nMore streamed content.\n\n```javascript\nconsole.log("streaming");\n```')};
    previewState.conversationId='streamed-conversation';update();
    cards=document.querySelectorAll('.code-accordion');
    if(cards.length!==4 || [...cards].some(card=>!card.open))throw Error('New streamed code did not expand after conversation ID changed');
    previewState.generating=false;update();
    if([...document.querySelectorAll('.code-accordion')].some(card=>card.open))throw Error('Code did not collapse when generation finished');
    previewState.busy=false;update();
    if([...document.querySelectorAll('.code-accordion')].some(card=>card.open))throw Error('Finished code reopened on idle update');
    cards=document.querySelectorAll('.code-accordion');cards[0].open=true;update();
    cards=document.querySelectorAll('.code-accordion');
    if(!cards[0].open || cards[1].open)throw Error('Manual expansion after generation did not persist');
    cards[0].open=true;cards[2].open=true;
    const messages=document.getElementById('messages');document.scrollingElement.scrollTop=Math.max(0,messages.querySelector('article.assistant').offsetTop-30);
    document.body.dataset.uiTest='passed';
  } catch(error) {document.body.dataset.uiTest='failed';document.body.dataset.uiError=error.message;}
`;
const html='<!DOCTYPE html><html><head><meta charset="UTF-8"><link rel="stylesheet" href="../media/chat.css"><style>body{margin:0;background:#202124;--vscode-font-family:system-ui;--vscode-foreground:#eee;--vscode-input-foreground:#eee;--vscode-input-background:#292a2d;--vscode-panel-border:#444;--vscode-descriptionForeground:#bbb;--vscode-button-background:#3574f0;--vscode-button-foreground:#fff;--vscode-textCodeBlock-background:#17181a;--vscode-editor-font-family:monospace;--vscode-editor-font-size:13px;--vscode-editor-foreground:#ddd;--vscode-list-hoverBackground:#333}</style></head><body>'+body+'<script>'+bootstrap+'</script>'+['markdown-it.min.js','highlight.min.js','render-markdown.js','code-cards.js','chat.js'].map(name=>'<script src="../media/'+name+'"></script>').join('')+'<script>'+check+'</script></body></html>';
fs.mkdirSync(path.join(root,'out'),{recursive:true});
fs.writeFileSync(path.join(root,'out/code-accordions-preview.html'),html);
console.log(path.join(root,'out/code-accordions-preview.html'));
