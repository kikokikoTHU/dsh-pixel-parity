/**
 * Render the project-flow Markdown design doc to a self-contained HTML reading page.
 * Run: node docs/design/render-doc.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const source = join(here, 'project-flow.zh-CN.md')
const target = join(here, 'project-flow.zh-CN.html')
const markdown = readFileSync(source, 'utf8')

const escapeHtml = value => value
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')

const inline = value => {
  let text = escapeHtml(value)
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>')
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
  return text
}

const body = markdown.slice(markdown.indexOf('## 0.'))
const lines = body.replace(/\r\n/g, '\n').split('\n')
const output = []
let index = 0
let inList = null
let listItems = []

const flushList = () => {
  if (inList === null) return
  output.push(`<${inList}>${listItems.join('')}</${inList}>`)
  inList = null
  listItems = []
}

const parseTable = start => {
  const rows = []
  let cursor = start
  while (cursor < lines.length && lines[cursor].trim().startsWith('|')) {
    rows.push(lines[cursor].trim())
    cursor += 1
  }
  if (rows.length < 2 || !/^\|[\s:|-]+\|$/.test(rows[1])) return null
  const cells = rows.map(row => row.replace(/^\||\|$/g, '').split('|').map(cell => cell.trim()))
  const head = cells[0].map(cell => `<th>${inline(cell)}</th>`).join('')
  const body = cells.slice(2).map(row => `<tr>${row.map(cell => `<td>${inline(cell)}</td>`).join('')}</tr>`).join('')
  return { html: `<div class="table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`, next: cursor }
}

while (index < lines.length) {
  const line = lines[index]
  const trimmed = line.trim()

  if (trimmed.startsWith('```')) {
    flushList()
    const language = trimmed.slice(3).trim()
    const code = []
    index += 1
    while (index < lines.length && !lines[index].trim().startsWith('```')) {
      code.push(lines[index])
      index += 1
    }
    index += 1
    output.push(`<pre><code data-lang="${language}">${escapeHtml(code.join('\n'))}</code></pre>`)
    continue
  }

  if (trimmed === '') {
    flushList()
    index += 1
    continue
  }

  if (trimmed === '---') {
    flushList()
    output.push('<hr>')
    index += 1
    continue
  }

  const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed)
  if (heading !== null) {
    flushList()
    const level = heading[1].length
    const id = heading[2].toLowerCase().replace(/[^\w\u4e00-\u9fa5]+/g, '-').replace(/^-|-$/g, '')
    output.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`)
    index += 1
    continue
  }

  const image = /^!\[(.*)\]\((.*)\)$/.exec(trimmed)
  if (image !== null) {
    flushList()
    output.push(`<figure><img src="${image[2]}" alt="${escapeHtml(image[1])}"><figcaption>${inline(image[1])}</figcaption></figure>`)
    index += 1
    continue
  }

  if (trimmed.startsWith('|')) {
    const table = parseTable(index)
    if (table !== null) {
      flushList()
      output.push(table.html)
      index = table.next
      continue
    }
  }

  const bullet = /^-\s+(.*)$/.exec(trimmed)
  const ordered = /^\d+\.\s+(.*)$/.exec(trimmed)
  if (bullet !== null || ordered !== null) {
    const kind = bullet !== null ? 'ul' : 'ol'
    if (inList !== kind) {
      flushList()
      inList = kind
    }
    let content = (bullet ?? ordered)[1]
    const todo = /^\[( |x|X)\]\s+(.*)$/.exec(content)
    if (todo !== null) {
      content = `<span class="todo">${todo[1] === ' ' ? '☐' : '☑'}</span> ${todo[2]}`
    }
    listItems.push(`<li>${inline(content)}</li>`)
    index += 1
    continue
  }

  if (trimmed.startsWith('>')) {
    flushList()
    output.push(`<blockquote>${inline(trimmed.slice(1).trim())}</blockquote>`)
    index += 1
    continue
  }

  flushList()
  const paragraph = []
  while (index < lines.length && lines[index].trim() !== '' && !/^([#>`-]|\d+\.|!\[|\|)/.test(lines[index].trim())) {
    paragraph.push(lines[index].trim())
    index += 1
  }
  if (paragraph.length === 0) {
    output.push(`<p>${inline(trimmed)}</p>`)
    index += 1
    continue
  }
  output.push(`<p>${inline(paragraph.join(' '))}</p>`)
}

const html = `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>PixelParity 项目式对齐流程 · 交互设计</title>
<style>
:root {
  --bg: #eef2f7; --surface: #ffffff; --subtle: #fbfcfe;
  --border: #e5eaf1; --border-weak: #eef2f7;
  --text: #0f172a; --muted: #64748b; --faint: #94a3b8;
  --control: #111827; --link: #1d4ed8;
  --ok: #15803d; --warn: #b45309; --danger: #b91c1c;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; line-height: 1.72; }
.layout { display: flex; max-width: 1380px; margin: 0 auto; gap: 28px; padding: 34px 28px 80px; }
nav { width: 248px; position: sticky; top: 24px; align-self: flex-start; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 18px; max-height: calc(100vh - 48px); overflow: auto; }
nav h4 { margin: 0 0 10px; font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--faint); }
nav a { display: block; color: var(--muted); text-decoration: none; font-size: 12px; padding: 4px 0; }
nav a:hover { color: var(--text); }
nav a.lv3 { padding-left: 12px; font-size: 11px; }
main { flex: 1; min-width: 0; background: var(--surface); border: 1px solid var(--border); border-radius: 14px; padding: 40px 48px; }
.kicker { color: var(--muted); font-size: 12px; margin-bottom: 6px; }
h1 { font-size: 28px; line-height: 1.25; letter-spacing: -.02em; margin: 0 0 10px; }
h2 { font-size: 20px; margin: 40px 0 12px; padding-top: 18px; border-top: 1px solid var(--border-weak); }
h3 { font-size: 16px; margin: 28px 0 8px; }
h4 { font-size: 14px; margin: 22px 0 6px; color: #1e293b; }
p { margin: 9px 0; color: #1e293b; font-size: 13.5px; }
ul, ol { padding-left: 22px; margin: 8px 0; }
li { margin: 4px 0; font-size: 13.5px; }
strong { color: #0f172a; }
code { font-family: "Cascadia Code", Consolas, monospace; font-size: 12px; background: #f1f5f9; border: 1px solid #e2e8f0; border-radius: 4px; padding: 1px 5px; }
pre { background: #0f172a; color: #e2e8f0; border-radius: 9px; padding: 14px 16px; overflow: auto; font-size: 12px; line-height: 1.6; }
pre code { background: transparent; border: none; color: inherit; padding: 0; }
figure { margin: 18px 0 24px; }
figure img { width: 100%; border: 1px solid var(--border); border-radius: 10px; box-shadow: 0 8px 24px rgba(15, 23, 42, .08); display: block; }
figcaption { color: var(--faint); font-size: 11px; margin-top: 7px; }
.table-wrap { overflow: auto; margin: 14px 0; border: 1px solid var(--border); border-radius: 9px; }
table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
th { text-align: left; background: var(--subtle); color: #475569; font-size: 11px; padding: 9px 12px; border-bottom: 1px solid var(--border); }
td { padding: 9px 12px; border-bottom: 1px solid var(--border-weak); vertical-align: top; }
tr:last-child td { border-bottom: none; }
blockquote { margin: 14px 0; padding: 10px 14px; background: var(--subtle); border-left: 3px solid var(--control); color: var(--muted); font-size: 13px; border-radius: 0 7px 7px 0; }
hr { border: none; border-top: 1px solid var(--border-weak); margin: 26px 0; }
a { color: var(--link); }
.todo { font-weight: 700; color: var(--control); }
.meta { display: flex; gap: 8px; flex-wrap: wrap; margin: 10px 0 0; }
.meta span { border: 1px solid var(--border); background: var(--subtle); color: var(--muted); border-radius: 999px; padding: 3px 9px; font-size: 10px; }
@media (max-width: 1080px) { nav { display: none; } main { padding: 26px 22px; } }
@media print { body { background: #fff; } nav { display: none; } .layout { display: block; padding: 0; } main { border: none; padding: 0; } figure img { box-shadow: none; } }
</style>
</head>
<body>
<div class="layout">
<nav><h4>目录</h4><div id="toc"></div></nav>
<main>
<div class="kicker">PixelParity · Design Document</div>
<h1>项目式对齐流程（交互设计）</h1>
<div class="meta"><span>状态：设计稿</span><span>版本：v1</span><span>更新：2026-11-23</span><span>适用：DSH PP 面板</span></div>
${output.join('\n')}
</main>
</div>
<script>
const toc = document.querySelector('#toc');
for (const heading of document.querySelectorAll('main h2, main h3')) {
  const link = document.createElement('a');
  link.href = '#' + heading.id;
  link.textContent = heading.textContent;
  if (heading.tagName === 'H3') link.className = 'lv3';
  toc.appendChild(link);
}
</script>
</body>
</html>
`

writeFileSync(target, html, 'utf8')
console.log('wrote', target)

