'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const md = require('../src/renderer/markdown');

// Just enough DOM to run render(): elements record tag, attributes and children.
function fakeDoc() {
  const doc = {
    createTextNode: (v) => ({ text: String(v) }),
    createElement: (tag) => {
      const el = { tag, children: [], dataset: {}, style: {}, ownerDocument: doc };
      el.appendChild = (c) => { el.children.push(c); return c; };
      el.append = (...cs) => cs.forEach(c => el.children.push(c));
      Object.defineProperty(el, 'textContent', {
        get: () => el.children.map(c => (c.text !== undefined ? c.text : c.textContent)).join(''),
        set: (v) => { el.children = v ? [{ text: String(v) }] : []; }
      });
      Object.defineProperty(el, 'innerHTML', { set: () => { throw new Error('innerHTML used'); } });
      return el;
    }
  };
  return doc;
}
const tags = (el, out = []) => { if (el.tag) out.push(el.tag); (el.children || []).forEach(c => tags(c, out)); return out; };

test('block structure: headings, fences, lists, quotes, tables, rules', () => {
  const ast = md.parse([
    '## 结果', '', '已完成 **3** 项：', '- 改 `a.js`', '  - 子项', '- [x] 测试通过', '',
    '1. 第一', '2. 第二', '', '> 注意', '> 第二行', '', '```js', 'const a = "<b>";', '```', '',
    '| 文件 | 行数 |', '|:--|--:|', '| a.js | 12 |', '', '---', 'end'
  ].join('\n'));
  assert.deepEqual(ast.map(b => b.t), ['h', 'p', 'ul', 'ol', 'quote', 'code', 'table', 'hr', 'p']);
  assert.equal(ast[2].items.length, 2);
  assert.equal(ast[2].items[0].c[1].t, 'ul', 'nested list');
  assert.equal(ast[2].items[1].task, true);
  assert.equal(ast[3].start, 1);
  assert.equal(ast[5].lang, 'js');
  assert.equal(ast[5].v, 'const a = "<b>";');
  assert.deepEqual(ast[6].align, ['', 'right']);
  assert.deepEqual(ast[6].rows[0], ['a.js', '12']);
});

test('inline: emphasis, code, links and their safety', () => {
  const n = md.inline('**粗** *斜* ~~删~~ `x*y` [doc](https://a.b/c) [bad](javascript:alert(1)) ![pic](https://x/y.png) snake_case_name');
  const kinds = n.map(x => x.t);
  assert.ok(kinds.includes('strong') && kinds.includes('em') && kinds.includes('del') && kinds.includes('code'));
  assert.equal(n.find(x => x.t === 'code').v, 'x*y');
  assert.equal(n.find(x => x.t === 'a').href, 'https://a.b/c');
  assert.ok(n.some(x => x.t === 'span'), 'non-http link loses its href');
  assert.equal(n.find(x => x.t === 'img').alt, 'pic');
  assert.ok(n[n.length - 1].v.endsWith('snake_case_name'), 'intraword underscores stay literal');
  const bare = md.inline('见 https://example.com/x). 结束');
  assert.equal(bare.find(x => x.t === 'a').href, 'https://example.com/x');
});

test('render never uses innerHTML and keeps raw HTML as text', () => {
  const doc = fakeDoc();
  const box = doc.createElement('div');
  md.render(box, '<img src=x onerror=alert(1)>\n\n<script>alert(1)</script> **ok**');
  assert.ok(!tags(box).includes('img') && !tags(box).includes('script'));
  assert.ok(box.textContent.includes('<script>alert(1)</script>'));
  assert.ok(tags(box).includes('strong'));
});

test('plain preview strips markers', () => {
  assert.equal(md.plainText('## 完成\n\n- **a.js**：修复\n- `b`'), '完成 • a.js：修复 • b');
});

test('pathological input stays fast', () => {
  const t0 = Date.now();
  md.plainText('**a '.repeat(5000) + '_b '.repeat(5000) + '['.repeat(3000) + '`'.repeat(3000));
  md.parse('- x\n'.repeat(3000) + '> q\n'.repeat(3000));
  assert.ok(Date.now() - t0 < 1500, `took ${Date.now() - t0}ms`);
});

test('links keep balanced parentheses in the URL', () => {
  const n = md.inline('[wiki](https://en.wikipedia.org/wiki/Foo_(bar)) after');
  assert.equal(n[0].href, 'https://en.wikipedia.org/wiki/Foo_(bar)');
  assert.equal(n[1].v, ' after');
});
