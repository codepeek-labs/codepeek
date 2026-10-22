'use strict';

// Minimal Markdown for Claude replies. Output is built with createElement/textContent only, never innerHTML,
// so raw HTML in a reply is shown as text. Images are reduced to their alt text; links must be http(s).
(function (root) {
  const MAX_DEPTH = 4;
  const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
  const HEADING = /^ {0,3}(#{1,6})(?:\s+(.*?))?\s*#*\s*$/;
  const HR = /^ {0,3}([-*_])(?:\s*\1){2,}\s*$/;
  const QUOTE = /^ {0,3}>\s?(.*)$/;
  const ITEM = /^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/;
  const TABLE_SEP = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

  function indentOf(line) {
    let n = 0;
    for (const ch of line) { if (ch === ' ') n += 1; else if (ch === '\t') n += 4; else break; }
    return n;
  }

  function stripIndent(line, n) {
    let i = 0, w = 0;
    while (i < line.length && w < n && (line[i] === ' ' || line[i] === '\t')) { w += line[i] === '\t' ? 4 : 1; i++; }
    return line.slice(i);
  }

  function splitRow(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
    const cells = [];
    let cur = '';
    for (let i = 0; i < s.length; i++) {
      if (s[i] === '\\' && s[i + 1] === '|') { cur += '|'; i++; } else if (s[i] === '|') { cells.push(cur.trim()); cur = ''; } else cur += s[i];
    }
    cells.push(cur.trim());
    return cells;
  }

  function startsBlock(line, next) {
    return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line) || ITEM.test(line)
      || (line.includes('|') && next !== undefined && TABLE_SEP.test(next) && next.includes('-'));
  }

  function parseBlocks(lines, depth) {
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = FENCE.exec(line))) {
        const fence = m[1];
        const body = [];
        i++;
        while (i < lines.length && !(lines[i].trim().startsWith(fence[0].repeat(fence.length)) && !lines[i].trim().replace(/[`~]/g, ''))) body.push(lines[i++]);
        i++;
        out.push({ t: 'code', lang: m[2] || '', v: body.join('\n') });
        continue;
      }
      if ((m = HEADING.exec(line))) { out.push({ t: 'h', level: m[1].length, v: m[2] || '' }); i++; continue; }
      if (HR.test(line)) { out.push({ t: 'hr' }); i++; continue; }
      if (QUOTE.test(line)) {
        const body = [];
        while (i < lines.length && lines[i].trim() && (m = QUOTE.exec(lines[i]) || (body.length && !startsBlock(lines[i]) ? [null, lines[i]] : null))) { body.push(m[1]); i++; }
        out.push(depth < MAX_DEPTH ? { t: 'quote', c: parseBlocks(body, depth + 1) } : { t: 'p', v: body.join('\n') });
        continue;
      }
      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]) && lines[i + 1].includes('-')) {
        const head = splitRow(line);
        const align = splitRow(lines[i + 1]).map(c => (c.startsWith(':') && c.endsWith(':') ? 'center' : c.endsWith(':') ? 'right' : ''));
        const rows = [];
        i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitRow(lines[i++]));
        out.push({ t: 'table', head, align, rows });
        continue;
      }
      if ((m = ITEM.exec(line))) {
        const res = parseList(lines, i, depth);
        out.push(res.node);
        i = res.next;
        continue;
      }
      const para = [];
      while (i < lines.length && lines[i].trim() && !(para.length && startsBlock(lines[i], lines[i + 1]))) para.push(lines[i++].trim());
      out.push({ t: 'p', v: para.join('\n') });
    }
    return out;
  }

  function parseList(lines, start, depth) {
    const first = ITEM.exec(lines[start]);
    const base = indentOf(first[1]);
    const ordered = /\d/.test(first[2]);
    const node = { t: ordered ? 'ol' : 'ul', start: ordered ? parseInt(first[2], 10) : 1, items: [] };
    let item = null;
    let i = start;
    let blank = false;
    while (i < lines.length) {
      const line = lines[i];
      const m = ITEM.exec(line);
      if (m && indentOf(m[1]) <= base + 1 && /\d/.test(m[2]) === ordered) {
        item = { lines: [m[3]], offset: indentOf(m[1]) + m[2].length + 1 };
        node.items.push(item);
        blank = false;
        i++;
        continue;
      }
      if (!line.trim()) {
        const nxt = lines.slice(i + 1).find(l => l.trim());
        if (nxt === undefined || indentOf(nxt) <= base && !ITEM.test(nxt)) break;
        blank = true;
        item.lines.push('');
        i++;
        continue;
      }
      if (indentOf(line) > base) { item.lines.push(stripIndent(line, Math.min(item.offset, indentOf(line)))); i++; continue; }
      if (!blank && !startsBlock(line, lines[i + 1])) { item.lines.push(line.trim()); i++; continue; }
      break;
    }
    for (const it of node.items) {
      let text = it.lines[0];
      const task = /^\[([ xX])\]\s+/.exec(text);
      if (task) { it.task = task[1] !== ' '; text = text.slice(task[0].length); }
      const body = [text].concat(it.lines.slice(1));
      it.c = depth < MAX_DEPTH ? parseBlocks(body, depth + 1) : [{ t: 'p', v: body.join('\n') }];
      delete it.lines;
      delete it.offset;
    }
    return { node, next: i };
  }

  function parse(md) {
    const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
    return parseBlocks(lines, 0);
  }

  // ---------- inline ----------
  const PUNCT = /[!-\/:-@\[-`{-~]/;
  const isWord = (ch) => !!ch && /[\p{L}\p{N}]/u.test(ch);

  function safeHref(url) {
    const u = String(url || '').trim().replace(/^<|>$/g, '');
    return /^https?:\/\/[^\s]+$/i.test(u) ? u : '';
  }

  function inline(s, depth = 0, failed = new Set()) {
    const out = [];
    let text = '';
    const flush = () => { if (text) { out.push({ t: 'text', v: text }); text = ''; } };
    let i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '\\' && PUNCT.test(s[i + 1] || '')) { text += s[i + 1]; i += 2; continue; }
      if (ch === '\n') { flush(); out.push({ t: 'br' }); i++; continue; }
      if (ch === '`') {
        let n = 1;
        while (s[i + n] === '`') n++;
        const fence = '`'.repeat(n);
        let j = s.indexOf(fence, i + n);
        while (j !== -1 && s[j + n] === '`') j = s.indexOf(fence, j + n + 1);
        if (j !== -1) { flush(); out.push({ t: 'code', v: s.slice(i + n, j).replace(/^ (.*) $/s, '$1') }); i = j + n; continue; }
        text += fence; i += n; continue;
      }
      if ((ch === '!' && s[i + 1] === '[') || ch === '[') {
        const img = ch === '!';
        const link = depth < MAX_DEPTH ? matchLink(s, img ? i + 1 : i) : null;
        if (link) {
          flush();
          if (img) out.push({ t: 'img', alt: link.label });
          else {
            const href = safeHref(link.url);
            const kids = inline(link.label, depth + 1);
            out.push(href ? { t: 'a', href, c: kids } : { t: 'span', c: kids });
          }
          i = link.end;
          continue;
        }
      }
      if (ch === '<' && s.slice(i + 1, i + 5).toLowerCase() === 'http') {
        const m = /^<(https?:\/\/[^\s<>]+)>/i.exec(s.slice(i, i + 2048));
        if (m) { flush(); out.push({ t: 'a', href: m[1], c: [{ t: 'text', v: m[1] }] }); i += m[0].length; continue; }
      }
      if ((ch === 'h' || ch === 'H') && s.slice(i, i + 4).toLowerCase() === 'http' && !isWord(s[i - 1])) {
        const m = /^https?:\/\/[^\s<>]+/i.exec(s.slice(i, i + 2048));
        if (m) {
          const url = m[0].replace(/[).,;:!?'"\]]+$/, '');
          flush(); out.push({ t: 'a', href: url, c: [{ t: 'text', v: url }] }); i += url.length; continue;
        }
      }
      if (ch === '*' || ch === '_' || ch === '~') {
        let n = 1;
        while (s[i + n] === ch) n++;
        const can = ch !== '~' || n === 2;
        const tok = ch.repeat(Math.min(n, ch === '~' ? 2 : n >= 2 ? 2 : 1));
        const opens = can && s[i + tok.length] && !/\s/.test(s[i + tok.length]) && !(ch === '_' && isWord(s[i - 1]));
        if (opens && depth < MAX_DEPTH && !failed.has(tok)) {
          const close = findClose(s, i + tok.length, tok, ch === '_');
          if (close === -1) failed.add(tok);
          else {
            flush();
            const kids = inline(s.slice(i + tok.length, close), depth + 1);
            out.push({ t: ch === '~' ? 'del' : tok.length === 2 ? 'strong' : 'em', c: kids });
            i = close + tok.length;
            continue;
          }
        }
        text += s.slice(i, i + n); i += n; continue;
      }
      text += ch; i++;
    }
    flush();
    return out;
  }

  function findClose(s, from, tok, intraword) {
    let j = s.indexOf(tok, from + 1);
    while (j !== -1) {
      const before = s[j - 1];
      const after = s[j + tok.length];
      const okBefore = before && !/\s/.test(before);
      const okAfter = !intraword || !isWord(after);
      // A longer run (e.g. "**" when closing "*") belongs to another delimiter.
      const exact = s[j + tok.length] !== tok[0] || tok.length === 2;
      if (okBefore && okAfter && exact) return j;
      j = s.indexOf(tok, j + 1);
    }
    return -1;
  }

  function matchLink(s, open) {
    let depth = 0, j = open;
    for (; j < s.length && j - open < 1000; j++) {
      if (s[j] === '\\') { j++; continue; }
      if (s[j] === '[') depth++;
      else if (s[j] === ']' && --depth === 0) break;
    }
    if (depth !== 0 || s[j + 1] !== '(') return null;
    // URLs may contain balanced parentheses, e.g. https://en.wikipedia.org/wiki/Foo_(bar).
    let close = -1;
    for (let k = j + 2, d = 0; k < s.length && k - j < 2048; k++) {
      if (s[k] === '(') d++;
      else if (s[k] === ')') { if (d === 0) { close = k; break; } d--; }
      else if (s[k] === '\n') break;
    }
    if (close === -1) return null;
    const url = s.slice(j + 2, close).trim().split(/\s+/)[0];
    return { label: s.slice(open + 1, j), url, end: close + 1 };
  }

  // ---------- output ----------
  function plainInline(nodes) {
    let s = '';
    for (const n of nodes) {
      if (n.t === 'text' || n.t === 'code') s += n.v;
      else if (n.t === 'br') s += ' ';
      else if (n.t === 'img') s += n.alt ? `[${n.alt}]` : '';
      else if (n.c) s += plainInline(n.c);
    }
    return s;
  }

  function plainBlocks(blocks) {
    const parts = [];
    for (const b of blocks) {
      if (b.t === 'p' || b.t === 'h') parts.push(plainInline(inline(b.v)));
      else if (b.t === 'code') parts.push(b.v);
      else if (b.t === 'quote') parts.push(plainBlocks(b.c));
      else if (b.t === 'ul' || b.t === 'ol') b.items.forEach((it, k) => parts.push((b.t === 'ol' ? `${b.start + k}. ` : '• ') + plainBlocks(it.c)));
      else if (b.t === 'table') parts.push([b.head].concat(b.rows).map(r => r.map(c => plainInline(inline(c))).join(' · ')).join(' / '));
    }
    return parts.filter(Boolean).join(' ');
  }

  const plainCache = new Map();

  // One-line preview text for a card: Markdown markers removed, whitespace collapsed.
  function plainText(md) {
    const key = String(md || '');
    if (plainCache.has(key)) return plainCache.get(key);
    const v = plainBlocks(parse(key)).replace(/\s+/g, ' ').trim();
    if (plainCache.size >= 64) plainCache.delete(plainCache.keys().next().value);
    plainCache.set(key, v);
    return v;
  }

  function renderInline(doc, parent, nodes) {
    for (const n of nodes) {
      let el;
      switch (n.t) {
        case 'text': parent.appendChild(doc.createTextNode(n.v)); continue;
        case 'br': parent.appendChild(doc.createElement('br')); continue;
        case 'code': el = doc.createElement('code'); el.textContent = n.v; break;
        case 'img': el = doc.createElement('span'); el.className = 'md-img'; el.textContent = n.alt || 'image'; break;
        case 'a':
          el = doc.createElement('a');
          el.href = n.href;
          el.target = '_blank';
          el.rel = 'noopener noreferrer';
          el.title = n.href;
          renderInline(doc, el, n.c);
          break;
        default:
          el = doc.createElement(n.t === 'span' ? 'span' : n.t);
          renderInline(doc, el, n.c);
      }
      parent.appendChild(el);
    }
  }

  function renderBlocks(doc, parent, blocks) {
    for (const b of blocks) {
      let el;
      if (b.t === 'p') { el = doc.createElement('p'); renderInline(doc, el, inline(b.v)); }
      else if (b.t === 'h') { el = doc.createElement('h' + Math.min(6, b.level)); renderInline(doc, el, inline(b.v)); }
      else if (b.t === 'hr') el = doc.createElement('hr');
      else if (b.t === 'code') {
        el = doc.createElement('pre');
        if (b.lang) el.dataset.lang = b.lang;
        const code = doc.createElement('code');
        code.textContent = b.v;
        el.appendChild(code);
      } else if (b.t === 'quote') { el = doc.createElement('blockquote'); renderBlocks(doc, el, b.c); }
      else if (b.t === 'ul' || b.t === 'ol') {
        el = doc.createElement(b.t);
        if (b.t === 'ol' && b.start !== 1) el.start = b.start;
        for (const it of b.items) {
          const li = doc.createElement('li');
          if (it.task !== undefined) {
            li.className = 'task' + (it.task ? ' on' : '');
            const box = doc.createElement('span');
            box.className = 'md-box';
            box.textContent = it.task ? '☑' : '☐';
            li.appendChild(box);
          }
          renderBlocks(doc, li, it.c);
          el.appendChild(li);
        }
      } else if (b.t === 'table') {
        el = doc.createElement('div');
        el.className = 'md-table';
        const table = doc.createElement('table');
        const row = (cells, tag) => {
          const tr = doc.createElement('tr');
          b.head.forEach((_, k) => {
            const cell = doc.createElement(tag);
            if (b.align[k]) cell.style.textAlign = b.align[k];
            renderInline(doc, cell, inline(cells[k] || ''));
            tr.appendChild(cell);
          });
          return tr;
        };
        const thead = doc.createElement('thead');
        thead.appendChild(row(b.head, 'th'));
        const tbody = doc.createElement('tbody');
        for (const r of b.rows) tbody.appendChild(row(r, 'td'));
        table.append(thead, tbody);
        el.appendChild(table);
      }
      if (el) parent.appendChild(el);
    }
  }

  function render(container, md) {
    const doc = container.ownerDocument;
    container.textContent = '';
    renderBlocks(doc, container, parse(md));
  }

  const api = { parse, inline, plainText, render, safeHref };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.Markdown = api;
})(typeof window !== 'undefined' ? window : globalThis);
