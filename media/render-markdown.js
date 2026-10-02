(function (root) {
  function createChatMarkdown(markdownit, hljs) {
    const markdown = markdownit({html:false,linkify:true,breaks:true,highlight:(code, language) => {
      const name = language.toLowerCase();
      if (name === 'azure-files') return hljs.highlight(code, {language:'json',ignoreIllegals:true}).value;
      if (name && hljs.getLanguage(name)) return hljs.highlight(code, {language:name,ignoreIllegals:true}).value;
      // Unknown and unlabeled blocks remain escaped plain text.
      return '';
    }});
    markdown.renderer.rules.image = (tokens,index) => markdown.utils.escapeHtml(tokens[index].content);
    return markdown;
  }
  if (typeof module === 'object' && module.exports) module.exports = createChatMarkdown;
  else root.createChatMarkdown = createChatMarkdown;
})(globalThis);
