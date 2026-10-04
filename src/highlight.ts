/**
 * Line highlighter copied into the merge webview via Function#toString.
 * Keep this function self-contained: no helpers outside its body.
 */
export function highlightLine(line: string, lang: string): string {
  const sentinel = /^<<<<<<< WMERGE \S+ >>>>>>>$/;
  const esc = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const wrap = (cls: string, text: string) => '<span class="' + cls + '">' + esc(text) + '</span>';
  if (sentinel.test(line)) {
    return wrap('tok-sentinel', line);
  }
  if (!line) {
    return ' ';
  }

  const keywords: Record<string, string> = {
    javascript: 'const|let|var|function|return|if|else|for|while|class|import|export|from|new|this|async|await|try|catch|throw|typeof|switch|case|break|continue|default|extends|static|of|in|null|undefined|true|false',
    python: 'def|class|return|if|elif|else|import|from|for|while|try|except|finally|with|as|yield|lambda|pass|None|True|False|and|or|not|in|is',
    go: 'func|package|import|return|if|else|for|var|const|type|struct|interface|go|defer|range|nil|true|false',
    clike: 'class|public|private|protected|static|void|int|long|bool|return|if|else|for|while|new|struct|namespace|using|true|false|null',
    json: 'true|false|null'
  };
  const kw = keywords[lang];
  let pattern: RegExp | null = null;
  if (lang === 'python') {
    pattern = /(#.*)|('[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*")|\b\d+(?:\.\d+)?\b|\b[A-Za-z_][\w]*\b/g;
  } else if (lang === 'markup') {
    pattern = /(<!--[\s\S]*?-->)|(<\/?[\w:-]+)|('[^']*'|"[^"]*")/g;
  } else if (lang === 'css') {
    pattern = /(\/\*[\s\S]*?\*\/)|('[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*")|\b\d+(?:\.\d+)?(?:px|em|rem|%)?\b|#[0-9a-fA-F]{3,8}\b/g;
  } else if (lang === 'markdown') {
    pattern = /(^#{1,6} .*)|(`[^`]+`)/g;
  } else if (lang === 'json') {
    pattern = /("(?:\\.|[^"\\])*")|\b(?:true|false|null)\b|-?\b\d+(?:\.\d+)?\b/g;
  } else if (kw) {
    pattern = /(\/\/.*|\/\*[\s\S]*?\*\/)|('[^'\\]*(?:\\.[^'\\]*)*'|"[^"\\]*(?:\\.[^"\\]*)*"|`[^`\\]*(?:\\.[^`\\]*)*`)|-?\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b/g;
  }
  if (!pattern) {
    return esc(line);
  }

  let html = '';
  let last = 0;
  for (const match of line.matchAll(pattern)) {
    const text = match[0];
    const index = match.index ?? 0;
    html += esc(line.slice(last, index));
    let cls = '';
    if (lang === 'python' && text.startsWith('#')) {
      cls = 'tok-comment';
    } else if (lang === 'css' && /^#[0-9a-fA-F]{3,8}$/.test(text)) {
      cls = 'tok-number';
    } else if (lang === 'markup' && text.startsWith('<')) {
      cls = 'tok-keyword';
    } else if (lang === 'markdown' && text.startsWith('#')) {
      cls = 'tok-keyword';
    } else if (lang === 'markdown' && text.startsWith('`')) {
      cls = 'tok-string';
    } else if (text.startsWith('//') || text.startsWith('/*') || text.startsWith('<!--') || text.startsWith('#')) {
      cls = 'tok-comment';
    } else if (text.startsWith('"') || text.startsWith("'") || text.startsWith('`')) {
      cls = 'tok-string';
    } else if (/^-?\d/.test(text)) {
      cls = 'tok-number';
    } else if (kw && new RegExp('^(?:' + kw + ')$').test(text)) {
      cls = 'tok-keyword';
    }
    html += cls ? wrap(cls, text) : esc(text);
    last = index + text.length;
  }
  html += esc(line.slice(last));
  return html;
}

export function languageFromFileName(name: string): string {
  const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : '';
  const table: Record<string, string> = {
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    ts: 'javascript',
    tsx: 'javascript',
    py: 'python',
    css: 'css',
    scss: 'css',
    html: 'markup',
    htm: 'markup',
    xml: 'markup',
    vue: 'markup',
    json: 'json',
    go: 'go',
    java: 'clike',
    c: 'clike',
    h: 'clike',
    cpp: 'clike',
    hpp: 'clike',
    cs: 'clike',
    rs: 'clike',
    kt: 'clike',
    md: 'markdown'
  };
  return table[ext] ?? 'plain';
}
