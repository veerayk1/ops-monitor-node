/**
 * Local README preview server.
 *
 * Serves the project README as a self-contained HTML page that renders:
 *   • Markdown via marked (CDN)
 *   • Mermaid diagrams via mermaid.js (CDN)
 *   • Output sanitized through DOMPurify before insertion
 *   • The embedded D2 SVG architecture diagram
 *
 * Useful when you want to preview the README without pushing to GitHub.
 *
 * Run:  node scripts/readme-preview.cjs
 * Then: open http://127.0.0.1:8002
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');

const PORT = 8002;
const ROOT = path.resolve(__dirname, '..');
const README = path.join(ROOT, 'README.md');
const README_VISION = path.join(ROOT, 'README-VISION.md');

function safeRead(p) {
  try { return fs.readFileSync(p, 'utf-8'); } catch { return null; }
}

function safeStat(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// Note on safety: the README content rendered by this preview is trusted
// (it's a local file in the repo, not user-submitted input). Even so, we
// sanitize via DOMPurify in the browser before insertion — defense in depth.
const HTML_SHELL = (which) => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>README Preview · Argus AI</title>
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown-dark.min.css" />
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/highlight.js@11.9.0/styles/github-dark.min.css" />
  <style>
    :root { color-scheme: dark; }
    html, body { background: #0d1117; margin: 0; padding: 0; }
    .topbar {
      position: sticky; top: 0; z-index: 10;
      background: rgba(13,17,23,0.92);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid #30363d;
      padding: 12px 24px;
      display: flex; gap: 14px; align-items: center;
      font: 13px -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    }
    .topbar a {
      color: #58a6ff;
      text-decoration: none;
      padding: 4px 10px;
      border-radius: 6px;
      transition: background 140ms;
    }
    .topbar a:hover { background: #21262d; }
    .topbar a.active { background: #1f6feb; color: #fff; }
    .topbar .label { color: #8b949e; }
    .topbar .spacer { flex: 1; }
    .topbar code {
      background: #161b22; padding: 3px 8px; border-radius: 6px;
      color: #c9d1d9; font-size: 12px;
    }
    .markdown-body {
      box-sizing: border-box;
      min-width: 200px;
      max-width: 980px;
      margin: 0 auto;
      padding: 36px 48px 80px;
    }
    .markdown-body img { background: transparent; }
    .markdown-body pre { background: #161b22; }
    .mermaid { background: #161b22; padding: 16px; border-radius: 8px; margin: 20px 0; text-align: center; }
    .mermaid svg { max-width: 100%; height: auto; }
    @media (max-width: 768px) { .markdown-body { padding: 16px; } }
  </style>
</head>
<body>
  <div class="topbar">
    <span class="label">README preview</span>
    <a href="/" class="${which === 'main' ? 'active' : ''}">README.md</a>
    <a href="/vision" class="${which === 'vision' ? 'active' : ''}">README-VISION.md</a>
    <span class="spacer"></span>
    <span class="label">Live on:</span>
    <code>http://127.0.0.1:${PORT}</code>
  </div>
  <article id="content" class="markdown-body"><em style="color:#8b949e">Loading…</em></article>

  <script src="https://cdn.jsdelivr.net/npm/marked@12.0.2/marked.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/dompurify@3.1.6/dist/purify.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/mermaid@10.9.1/dist/mermaid.min.js"></script>
  <script>
    // Use base theme with explicit overrides for contrast on our dark page bg.
    // 'dark' built-in theme uses near-black on near-black which is invisible
    // against the github-markdown-dark background.
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: 'loose',
      theme: 'base',
      themeVariables: {
        background: '#0d1117',
        primaryColor: '#1f6feb',
        primaryTextColor: '#f0f6fc',
        primaryBorderColor: '#58a6ff',
        lineColor: '#8b949e',
        secondaryColor: '#21262d',
        tertiaryColor: '#161b22',
        textColor: '#c9d1d9',
        clusterBkg: '#161b22',
        clusterBorder: '#30363d',
        edgeLabelBackground: '#0d1117',
        actorBkg: '#1f6feb',
        actorBorder: '#58a6ff',
        actorTextColor: '#f0f6fc',
        actorLineColor: '#8b949e',
        signalColor: '#c9d1d9',
        signalTextColor: '#c9d1d9',
        labelBoxBkgColor: '#161b22',
        labelBoxBorderColor: '#30363d',
        labelTextColor: '#f0f6fc',
        noteBkgColor: '#21262d',
        noteTextColor: '#f0f6fc',
        noteBorderColor: '#30363d',
      },
    });

    fetch('/raw/${which}').then(r => r.text()).then(md => {
      // marked v12 uses a "walkTokens" hook with a token object that has
      // { type: 'code', lang, text }. We swap mermaid code blocks for
      // <div class="mermaid">...</div> by mutating the token before render.
      marked.use({
        walkTokens(token) {
          if (token.type === 'code' && token.lang === 'mermaid') {
            const text = String(token.text);
            // Convert this token to an HTML block so marked emits the raw div as-is.
            token.type = 'html';
            token.raw = token.text;
            token.text = '<div class="mermaid">' + text.replace(/</g,'&lt;').replace(/>/g,'&gt;') + '</div>';
            token.block = true;
            token.pre = false;
          }
        },
      });
      marked.setOptions({ gfm: true, breaks: false });
      const raw = marked.parse(md);

      // Sanitize before insertion. Keep mermaid divs intact (their class
      // is preserved by DOMPurify; the raw mermaid text is safe content,
      // and mermaid.js parses it via its own DOM walker after).
      const clean = DOMPurify.sanitize(raw, {
        ADD_TAGS: ['svg', 'path', 'rect', 'circle', 'g', 'text', 'foreignObject', 'use', 'defs', 'marker', 'polyline', 'line', 'polygon', 'tspan', 'title'],
        ADD_ATTR: ['target', 'rel', 'class', 'id', 'd', 'x', 'y', 'cx', 'cy', 'r', 'width', 'height', 'viewBox', 'fill', 'stroke', 'transform', 'aria-hidden', 'preserveAspectRatio', 'xmlns']
      });

      const node = document.getElementById('content');
      node.textContent = ''; // clear
      // Use DOMPurify's safe DOM construction: parse the cleaned HTML
      // into a template fragment, then append. This avoids assigning
      // a string back to innerHTML.
      const tpl = document.createElement('template');
      tpl.innerHTML = clean; // tpl.innerHTML is sandboxed (no script execution)
      node.appendChild(tpl.content);

      mermaid.run({ nodes: document.querySelectorAll('.mermaid') });

      // Rewrite relative SVG/image links so /docs/architecture.svg resolves
      document.querySelectorAll('#content img').forEach(img => {
        const src = img.getAttribute('src') || '';
        if (src && !src.startsWith('http') && !src.startsWith('/')) {
          img.setAttribute('src', '/' + src);
        }
      });
    }).catch(err => {
      const node = document.getElementById('content');
      node.textContent = '';
      const p = document.createElement('p');
      p.style.color = '#f85149';
      p.textContent = 'Failed to load README: ' + err.message;
      node.appendChild(p);
    });
  </script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const rawUrl = req.url || '/';
  const url = rawUrl.split('?')[0];
  console.log(`${req.method} ${rawUrl}`);

  if (url === '/' || url === '/index.html') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_SHELL('main'));
  }
  if (url === '/vision') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML_SHELL('vision'));
  }
  if (url === '/raw/main') {
    const md = safeRead(README) || '# README missing';
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  }
  if (url === '/raw/vision') {
    const md = safeRead(README_VISION) || '# README-VISION missing';
    res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8' });
    return res.end(md);
  }
  // Serve any relative file referenced from the README — constrained to repo root
  if (url.startsWith('/')) {
    const cleaned = url.split('?')[0].replace(/^\/+/, '');
    const target = path.resolve(ROOT, cleaned);
    if (!target.startsWith(ROOT)) {
      res.writeHead(403); return res.end('Forbidden');
    }
    const stat = safeStat(target);
    if (stat && stat.isFile()) {
      const ext = path.extname(target).toLowerCase();
      const type = ext === '.svg' ? 'image/svg+xml'
        : ext === '.png' ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
        : ext === '.css' ? 'text/css'
        : ext === '.js' ? 'application/javascript'
        : ext === '.md' ? 'text/markdown'
        : 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': type });
      return res.end(fs.readFileSync(target));
    }
  }
  res.writeHead(404, { 'Content-Type': 'text/plain' });
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`README preview on http://127.0.0.1:${PORT}`);
});
