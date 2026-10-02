const {test}=require('node:test');
const assert=require('node:assert/strict');
const createMarkdown=require('../media/render-markdown');
const markdown=createMarkdown(require('../media/markdown-it.min'),require('../media/highlight.min'));

test('Markdown code highlights common languages while preserving code text',()=>{
  for(const [language,code] of [['js','const answer = "<hello>";'],['python','def greet():\n    return "hi"'],['json','{"answer": 42}'],['azure-files','{"files": []}']]){
    const html=markdown.render('```'+language+'\n'+code+'\n```');
    assert.match(html,/class="hljs-/);
    const unstyled=html.replace(/<span[^>]*>/g,'').replace(/<\/span>/g,'');
    assert.ok(unstyled.includes(markdown.utils.escapeHtml(code)));
  }
});
test('unknown languages, unlabeled code and HTML stay escaped',()=>{
  for(const language of ['unknown-language','']){
    const html=markdown.render('```'+language+'\n<script>alert("x")</script>\n```');
    assert.ok(!html.includes('<script>'));assert.match(html,/&lt;script&gt;/);
  }
  const html=markdown.render('<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n\n![image](https://example.com/image.png)');
  assert.ok(!html.includes('<script>'));assert.ok(!html.includes('href="javascript:'));assert.ok(!html.includes('<img'));
});
