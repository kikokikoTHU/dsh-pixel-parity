/**
 * Render the PixelParity project-flow design mockups to PNG.
 * Run: node docs/design/render-mockups.mjs
 */
import { createRequire } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const mockups = join(here, 'mockups')
const assets = join(here, 'assets')
mkdirSync(mockups, { recursive: true })
mkdirSync(assets, { recursive: true })

const css = `
* { box-sizing: border-box; }
body { margin: 0; background: #080c11; color: #e6edf3; font-family: Inter, "Segoe UI", "Microsoft YaHei", sans-serif; }
.shell { width: 1200px; min-height: 1000px; background: #0f141b; display: flex; flex-direction: column; }
.topbar { height: 54px; border-bottom: 1px solid #1e2937; display: flex; align-items: center; gap: 10px; padding: 0 22px; background: #0f141b; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 13px; color: #e6edf3; }
.mark { width: 24px; height: 24px; border-radius: 7px; background: #2563eb; color: #fff; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
.crumb { color: #8b98a9; font-size: 12px; }
.crumb b { color: #cbd5e1; font-weight: 600; }
.spacer { flex: 1; }
.ghost { border: 1px solid #263445; background: #121a24; color: #cbd5e1; border-radius: 7px; padding: 6px 11px; font-size: 12px; }
.primary { border: 1px solid #2563eb; background: #2563eb; color: #fff; border-radius: 7px; padding: 7px 14px; font-size: 12px; font-weight: 600; }
.primary[disabled] { background: #172033; border-color: #24344d; color: #64748b; }
.body { display: flex; flex: 1; }
.rail { width: 214px; border-right: 1px solid #1a2430; padding: 22px 16px; background: #0c1219; }
.rail h4 { margin: 0 0 14px; font-size: 11px; letter-spacing: .04em; text-transform: uppercase; color: #5f6f82; }
.step { display: flex; gap: 9px; padding: 8px 8px; border-radius: 8px; margin-bottom: 4px; }
.step.active { background: #15243a; }
.dot { width: 20px; height: 20px; border-radius: 50%; border: 1px solid #334155; color: #94a3b8; display: grid; place-items: center; font-size: 10px; flex: none; background: #111a24; }
.step.active .dot { background: #2563eb; border-color: #2563eb; color: #fff; }
.step.done .dot { background: #10301f; border-color: #1f6b40; color: #6ee7a8; }
.step div p { margin: 0; font-size: 12px; font-weight: 600; color: #cbd5e1; }
.step div small { color: #64748b; font-size: 10px; }
.main { flex: 1; padding: 24px 28px; overflow: hidden; }
.h1 { margin: 0; font-size: 18px; letter-spacing: -.01em; color: #f1f5f9; }
.sub { margin: 5px 0 0; color: #8b98a9; font-size: 12px; }
.card { border: 1px solid #223041; border-radius: 10px; background: #111922; }
.card-h { padding: 13px 15px; border-bottom: 1px solid #1b2634; display: flex; align-items: center; gap: 8px; }
.card-b { padding: 15px; }
.label { font-size: 11px; color: #8b98a9; margin-bottom: 5px; display: block; }
.field { height: 34px; border: 1px solid #263544; border-radius: 7px; display: flex; align-items: center; padding: 0 10px; font-size: 12px; color: #e6edf3; background: #0e1621; }
.field.mono { font-family: "Cascadia Code", Consolas, monospace; font-size: 11px; }
.field .hint { margin-left: auto; color: #5f6f82; font-size: 10px; }
.row { display: flex; gap: 12px; }
.grow { flex: 1; }
.src { display: flex; align-items: center; gap: 10px; padding: 9px 10px; border: 1px solid #1e2b3a; border-radius: 8px; margin-bottom: 7px; background: #0e1621; }
.src .kind { width: 30px; height: 26px; border-radius: 6px; display: grid; place-items: center; font-size: 9px; font-weight: 700; }
.kind.url { background: #14263f; color: #7fb3ff; }
.kind.file { background: #1a2432; color: #94a3b8; }
.src div p { margin: 0; font-size: 11px; color: #cbd5e1; font-family: "Cascadia Code", Consolas, monospace; }
.src div small { color: #64748b; font-size: 10px; }
.x { margin-left: auto; color: #64748b; font-size: 14px; }
.add { display: flex; gap: 8px; margin-top: 9px; }
.addbtn { border: 1px dashed #2b405a; color: #7fb3ff; background: #101b2a; border-radius: 7px; padding: 6px 10px; font-size: 11px; }
.footer { border-top: 1px solid #1e2937; padding: 12px 28px; display: flex; align-items: center; gap: 10px; background: #0f141b; }
.footer .note { color: #64748b; font-size: 11px; }
table { width: 100%; border-collapse: collapse; font-size: 11px; }
th { text-align: left; color: #8b98a9; font-weight: 600; padding: 8px 8px; border-bottom: 1px solid #1e2937; font-size: 10px; }
td { padding: 9px 8px; border-bottom: 1px solid #172231; vertical-align: middle; color: #cbd5e1; }
tr:last-child td { border-bottom: none; }
.pill { border-radius: 999px; padding: 2px 7px; font-size: 10px; font-weight: 600; display: inline-block; }
.ok { background: #10301f; color: #6ee7a8; }
.warn { background: #3a2a10; color: #fbbf24; }
.bad { background: #3a1717; color: #f87171; }
.mut { color: #64748b; }
.route { font-family: "Cascadia Code", Consolas, monospace; color: #7fb3ff; }
.bar { height: 5px; border-radius: 3px; background: #1e293b; overflow: hidden; }
.bar > i { display: block; height: 100%; background: #3b82f6; }
.chk { width: 14px; height: 14px; border-radius: 4px; border: 1px solid #2563eb; background: #2563eb; position: relative; display: inline-block; vertical-align: -2px; }
.chk::after { content: "✓"; color: #fff; font-size: 9px; position: absolute; left: 3px; top: 0; }
.chk.off { background: transparent; border-color: #334155; }
.chk.off::after { content: ""; }
.meta { display: flex; gap: 6px; flex-wrap: wrap; }
.chip { border: 1px solid #263445; background: #141d29; color: #cbd5e1; border-radius: 999px; padding: 3px 9px; font-size: 10px; }
.chip.blue { background: #152842; border-color: #23446b; color: #8ab4ff; }
.round { border: 1px solid #223041; border-radius: 10px; padding: 13px 14px; margin-bottom: 10px; background: #111922; }
.round.now { border-color: #2f5fa8; box-shadow: 0 0 0 3px #12233d; }
.round-h { display: flex; align-items: center; gap: 8px; }
.round-h b { font-size: 12px; color: #e6edf3; }
.timeline { color: #64748b; font-size: 10px; }
.stat { display: flex; gap: 22px; }
.stat b { font-size: 18px; display: block; line-height: 1.1; color: #f1f5f9; }
.stat span { font-size: 10px; color: #8b98a9; }
.thumb { width: 74px; height: 42px; border-radius: 5px; border: 1px solid #263445; background: linear-gradient(135deg, #16202d, #0e1621); }
.split { display: flex; gap: 18px; }
.col { flex: 1; }
.big { font-size: 22px; font-weight: 700; letter-spacing: -.02em; color: #f1f5f9; }
.kv { font-size: 11px; color: #8b98a9; line-height: 1.7; }
.kv b { color: #e6edf3; font-weight: 600; }
.empty { border: 1px dashed #2b3a4d; border-radius: 9px; padding: 16px; color: #64748b; font-size: 11px; text-align: center; }
.hr { height: 1px; background: #1e2937; margin: 12px 0; }
`

const shell = (step, crumb, content, footerNote = '') => `
<div class="shell">
  <div class="topbar">
    <div class="brand"><span class="mark">PP</span> Pixel parity</div>
    <span class="crumb">/ <b>新建对齐项目</b> / ${crumb}</span>
    <span class="spacer"></span>
    <button class="ghost">关闭</button>
  </div>
  <div class="body">
    <aside class="rail">
      <h4>步骤</h4>
      ${stepItem(1, '仓库、设计源与自动匹配', 'repo + commit + designs + LLM 匹配', step)}
      ${stepItem(2, '生成子任务', '自动生成，勾选下一轮范围', step)}
      <div class="hr"></div>
      <div class="kv">添加设计源后立即自动分析；全部分析完成前不能生成子任务。<br>第 2 步完成后进入项目页，<br>由 <b>Run next round</b> 手动触发。</div>
    </aside>
    <main class="main">${content}</main>
  </div>
  <div class="footer"><span class="note">${footerNote}</span><span class="spacer"></span>${footer(step)}</div>
</div>`

const stepItem = (num, title, sub, current) => {
  const state = num < current ? 'done' : num === current ? 'active' : ''
  return `<div class="step ${state}"><span class="dot">${num < current ? '✓' : num}</span><div><p>${title}</p><small>${sub}</small></div></div>`
}

const footer = step => {
  if (step === 1) return '<button class="ghost">取消</button><button class="primary" disabled>生成子任务 →</button>'
  return '<button class="ghost">上一步</button><button class="primary">进入项目页</button>'
}

const setup = `
<h1 class="h1">新建对齐项目</h1>
<p class="sub">指定仓库与基准 commit，再加入要对照的设计图或原型页面。</p>
<div class="card" style="margin-top:16px">
  <div class="card-h"><b style="font-size:12px">1 · 仓库</b><span class="mut" style="font-size:10px">对齐将以这个 commit 为基准，后续不会被工作区改动影响</span></div>
  <div class="card-b">
    <div class="row">
      <div class="grow"><span class="label">仓库路径</span><div class="field mono">D:\\work\\anubis <span class="hint">git ✓</span></div></div>
      <div style="width:150px"><span class="label">基准 commit</span><div class="field mono">4363d81 <span class="hint">✓</span></div></div>
    </div>
    <div class="kv" style="margin-top:8px">分支 <b>main</b> · 提交时间 2026-11-20 17:42 · 工作区 clean；对齐时会基于该 commit 创建临时 worktree。</div>
  </div>
</div>
<div class="card" style="margin-top:12px">
  <div class="card-h"><b style="font-size:12px">2 · 设计源</b><span class="mut" style="font-size:10px">支持 URL、本地图片或本地 HTML</span></div>
  <div class="card-b">
    <div class="src"><span class="kind url">URL</span><div><p>https://liumeitong66.github.io/SPC/01-项目统计首页.html</p><small>原型 · 1600×900</small></div><span class="pill ok">已匹配</span><span class="x">×</span></div>
    <div class="src"><span class="kind url">URL</span><div><p>https://liumeitong66.github.io/SPC/02-项目明细.html</p><small>原型 · 1600×900</small></div><span class="pill ok">已匹配</span><span class="x">×</span></div>
    <div class="src"><span class="kind file">FILE</span><div><p>D:\\designs\\projects-empty.png</p><small>Figma 导出 · 1440×900 · 2x</small></div><span class="pill warn">分析中…</span><span class="x">×</span></div>
    <div class="add"><button class="addbtn">+ 添加 URL</button><button class="addbtn">+ 本地图片 / HTML</button><span class="mut" style="font-size:10px;align-self:center">共 3 个设计源</span></div>
    <div class="kv" style="margin-top:9px">分析进度 <b>2/3</b> 完成 · 1 个正在分析；全部完成后才能进入下一步。</div>
    <div class="bar" style="margin-top:6px"><i style="width:66%"></i></div>
  </div>
</div>
<div class="card" style="margin-top:12px">
  <div class="card-h"><b style="font-size:12px">3 · 自动分析与匹配</b><span class="pill warn">2/3 分析完成</span><span class="spacer"></span><span class="mut" style="font-size:10px">全部完成后才能进入下一步</span></div>
  <div class="card-b" style="padding:4px 14px 10px">
    <table>
      <tr><th style="width:34%">设计源</th><th>候选页面</th><th style="width:14%">置信度</th><th style="width:16%">状态</th></tr>
      <tr><td><b>01-项目统计首页.html</b></td><td><span class="route">/projects</span></td><td><span class="pill ok">96%</span></td><td><span class="pill ok">已匹配</span></td></tr>
      <tr><td><b>02-项目明细.html</b></td><td><span class="route">/projects/:id</span></td><td><span class="pill ok">88%</span></td><td><span class="pill ok">已匹配</span></td></tr>
      <tr><td><b>projects-empty.png</b></td><td class="mut">分析中…</td><td class="mut">—</td><td><span class="pill warn">分析中</span></td></tr>
    </table>
    <div class="kv" style="margin-top:7px">低置信度会标记“待复核”并默认不勾选；分析失败会阻塞下一步，直到重试成功或删除该设计源。</div>
  </div>
</div>`

const match = `
<h1 class="h1">自动分析并匹配</h1>
<p class="sub">创建项目后自动执行。LLM 给出候选页面并直接生成子任务；低置信度只标记“待复核”，不阻塞流程。</p>
<div class="meta" style="margin-top:12px">
  <span class="chip blue">已分析 3 个设计源</span><span class="chip">候选页面 6 个</span><span class="chip">自动接受 2 个</span><span class="chip">待复核 1 个</span>
</div>
<div class="card" style="margin-top:12px">
  <div class="card-h"><b style="font-size:12px">设计源 → 前端页面</b><span class="spacer"></span><span class="mut" style="font-size:10px">可下拉修改</span></div>
  <div class="card-b" style="padding:0 14px 6px">
    <table>
      <tr><th style="width:34%">设计源</th><th>候选页面</th><th style="width:20%">组件 / 入口</th><th style="width:12%">置信度</th><th style="width:10%">状态</th></tr>
      <tr><td><b>01-项目统计首页.html</b><div class="mut">原型 URL</div></td><td><span class="route">/projects</span><div class="mut">ProjectStatsDesign.vue</div></td><td class="mut">apps/hub/src/views</td><td><span class="pill ok">96%</span></td><td><span class="pill ok">已匹配</span></td></tr>
      <tr><td><b>02-项目明细.html</b><div class="mut">原型 URL</div></td><td><span class="route">/projects/:id</span><div class="mut">ProjectDetail.vue</div></td><td class="mut">apps/hub/src/views</td><td><span class="pill ok">88%</span></td><td><span class="pill ok">已匹配</span></td></tr>
      <tr><td><b>projects-empty.png</b><div class="mut">Figma 导出</div></td><td><span class="route">/projects?state=empty</span><div class="mut">ProjectStatsDesign.vue · 空态</div></td><td class="mut">同页状态</td><td><span class="pill warn">64%</span></td><td><span class="pill warn">待复核</span></td></tr>
    </table>
  </div>
</div>
<div class="card" style="margin-top:12px">
  <div class="card-b" style="display:flex;gap:16px;align-items:center">
    <div class="thumb"></div>
    <div style="flex:1"><b style="font-size:12px">projects-empty.png → /projects?state=empty</b><div class="kv">LLM 依据：路由表存在 /projects；页面组件包含 empty 分支；设计图尺寸与 1600×900 viewport 匹配。已自动生成子任务，默认不勾选；可在后续子任务页调整，不需要在这里确认。</div></div>
    <button class="ghost">可选：改选页面</button>
  </div>
</div>`

const subtasks = `
<h1 class="h1">生成对齐子任务</h1>
<p class="sub">每个匹配生成一个子任务；勾选决定“下一轮”实际执行哪些。未勾选的不会运行。</p>
<div class="card" style="margin-top:14px">
  <div class="card-h"><b style="font-size:12px">Round 1 · 计划子任务</b><span class="spacer"></span><span class="mut" style="font-size:10px">已选 3 / 3</span></div>
  <div class="card-b" style="padding:6px 14px 10px">
    <table>
      <tr><th style="width:6%"></th><th style="width:34%">子任务</th><th>设计源 → 页面</th><th style="width:14%">检查范围</th><th style="width:12%">预计</th></tr>
      <tr><td><span class="chk"></span></td><td><b>项目统计首页 · 视觉对齐</b><div class="mut">projects</div></td><td><span class="route">01-项目统计首页.html</span><div class="mut">→ /projects</div></td><td class="mut">1600×900 · 1 viewport</td><td class="mut">~40s</td></tr>
      <tr><td><span class="chk"></span></td><td><b>项目明细页 · 视觉对齐</b><div class="mut">projects-detail</div></td><td><span class="route">02-项目明细.html</span><div class="mut">→ /projects/:id</div></td><td class="mut">1600×900 · 1 viewport</td><td class="mut">~40s</td></tr>
      <tr><td><span class="chk"></span></td><td><b>项目统计首页 · 空态对齐</b><div class="mut">projects-empty</div></td><td><span class="route">projects-empty.png</span><div class="mut">→ /projects?state=empty</div></td><td class="mut">1600×900 · 1 viewport</td><td class="mut">~40s</td></tr>
    </table>
  </div>
</div>
<div class="card" style="margin-top:12px">
  <div class="card-b" style="display:flex;gap:12px;align-items:center">
    <span class="chk"></span><div style="flex:1"><b style="font-size:11px">勾选状态会保存为“本轮计划”</b><div class="kv">每轮开始前都可以重新勾选；一旦触发 Run next round，本轮选择就固定下来，报告按本轮实际执行结果生成。</div></div>
    <button class="ghost">全选</button><button class="ghost">全不选</button>
  </div>
</div>`

const dashboard = `
<div class="shell">
  <div class="topbar">
    <div class="brand"><span class="mark">PP</span> Pixel parity</div>
    <span class="crumb">/ <b>anubis</b> / 对齐项目</span>
    <span class="spacer"></span><button class="ghost">项目设置</button><button class="primary" style="padding:8px 16px">Run next round</button>
  </div>
  <div class="main" style="padding:20px 28px">
    <div style="display:flex;align-items:flex-start;gap:18px">
      <div style="flex:1">
        <div style="display:flex;align-items:center;gap:8px"><h1 class="h1">anubis · 设计对齐</h1><span class="pill warn">Round 2 pending</span></div>
        <div class="meta" style="margin-top:7px"><span class="chip">D:\\work\\anubis</span><span class="chip">base 4363d81</span><span class="chip">3 设计源</span><span class="chip">3 子任务</span></div>
      </div>
      <div class="stat" style="padding-top:2px">
        <div><b>1</b><span>rounds done</span></div>
        <div><b>2</b><span>failed subtasks</span></div>
        <div><b>9.26%</b><span>pixels</span></div>
      </div>
    </div>
    <div class="hr"></div>
    <div class="split">
      <div style="flex:1.35">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b style="font-size:12px">轮次</b><span class="mut" style="font-size:10px">每轮由你手动触发，不会自动执行</span></div>
        <div class="round">
          <div class="round-h"><b>Round 1</b><span class="pill ok">done</span><span class="timeline">2026-11-23 12:54 · 3/3 子任务</span><span class="spacer"></span><button class="ghost" style="padding:4px 8px">Report</button></div>
          <div class="kv" style="margin-top:6px">2 failed · 1 passed · 9.26% pixels · 几何/样式 pass</div>
          <div class="bar" style="margin-top:8px"><i style="width:66%;background:#f59e0b"></i></div>
        </div>
        <div class="round now">
          <div class="round-h"><b>Round 2</b><span class="pill warn">queued</span><span class="timeline">等待手动触发 · 已选 2/3 子任务</span></div>
          <div class="kv" style="margin-top:6px">项目统计首页 · 项目明细页 <span class="mut">（空态本轮未勾选）</span></div>
        </div>
        <div class="round" style="opacity:.55"><div class="round-h"><b>Round 3</b><span class="timeline">after Round 2</span></div></div>
      </div>
      <div class="col">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px"><b style="font-size:12px">Round 2 子任务</b><span class="mut" style="font-size:10px">触发前可调整</span></div>
        <div class="card"><div class="card-b" style="padding:4px 12px 10px">
          <table>
            <tr><td style="width:8%"><span class="chk"></span></td><td><b>项目统计首页</b><div class="route">/projects</div></td><td class="mut" style="text-align:right">~40s</td></tr>
            <tr><td><span class="chk"></span></td><td><b>项目明细页</b><div class="route">/projects/:id</div></td><td class="mut" style="text-align:right">~40s</td></tr>
            <tr><td><span class="chk off"></span></td><td><b>项目统计首页 · 空态</b><div class="route">/projects?state=empty</div></td><td class="mut" style="text-align:right">~40s</td></tr>
          </table>
          <div class="kv" style="margin-top:8px">已选 2 个子任务；未勾选的空态本轮跳过。</div>
        </div></div>
        <div class="card" style="margin-top:10px"><div class="card-b">
          <b style="font-size:11px">为什么是手动？</b><div class="kv" style="margin-top:4px">对齐会改动工作区。每轮开始前你可以检查 base commit、设计源与勾选，再决定是否执行。</div>
        </div></div>
      </div>
    </div>
  </div>
</div>`

const report = `
<div class="shell">
  <div class="topbar">
    <div class="brand"><span class="mark">PP</span> Report · Round 1</div>
    <span class="crumb">/ anubis / 2026-11-23T12:54</span>
    <span class="spacer"></span><button class="ghost">Download</button><button class="ghost">关闭</button>
  </div>
  <div class="main" style="padding:22px 30px;background:#0b0f14">
    <div style="display:flex;gap:24px;align-items:flex-start">
      <div style="flex:1">
        <h2 style="margin:0;font-size:16px">Round 1 对齐报告</h2>
        <div class="kv" style="margin-top:4px">3 子任务 · 2 failed · 1 passed · 基于 commit 4363d81</div>
      </div>
      <div class="stat">
        <div><b>9.26%</b><span>pixels</span></div><div><b>1/3</b><span>passed</span></div><div><b>−0.02%</b><span>vs previous</span></div>
      </div>
    </div>
    <div class="card" style="margin-top:14px"><div class="card-b" style="display:flex;gap:16px">
      <div class="thumb" style="width:160px;height:92px"></div>
      <div style="flex:1">
        <div style="display:flex;gap:8px;align-items:center"><b style="font-size:12px">项目统计首页 · /projects</b><span class="pill bad">failed</span><span class="pill">9.26% pixels</span></div>
        <div class="kv" style="margin-top:5px">几何 pass · 样式 pass · 像素差异集中在“良率对比”条形图区域；表格列宽与原型存在偏差。</div>
        <div style="margin-top:8px;display:flex;gap:8px"><span class="chip">[structure] 良率对比条形图</span><span class="chip">[mock] 数据条数差异</span></div>
      </div>
      <button class="ghost" style="align-self:center">查看 diff</button>
    </div></div>
    <div class="card" style="margin-top:10px"><div class="card-b" style="display:flex;gap:16px">
      <div class="thumb" style="width:160px;height:92px;background:linear-gradient(135deg,#162338,#1b2a44)"></div>
      <div style="flex:1">
        <div style="display:flex;gap:8px;align-items:center"><b style="font-size:12px">项目明细页 · /projects/:id</b><span class="pill ok">passed</span><span class="pill">0.00% pixels</span></div>
        <div class="kv" style="margin-top:5px">几何/样式/像素均通过，已可作为 baseline。</div>
      </div>
    </div></div>
    <div class="card" style="margin-top:10px"><div class="card-h"><b style="font-size:12px">下一步</b></div><div class="card-b">
      <div class="kv">1. 修复良率对比条形图的布局与数据条数；2. 重新勾选 Round 2 子任务；3. 手动触发 Run next round。</div>
    </div></div>
  </div>
</div>`

const cards = [
  ['01-setup.png', shell(1, '仓库、设计源与自动匹配', setup, '等待 1 个设计源分析完成；全部分析完成后才能继续。')],
  ['02-subtasks.png', shell(2, '生成子任务', subtasks, '子任务已自动生成；勾选只决定下一轮执行范围。')],
  ['03-dashboard.png', dashboard],
  ['04-report.png', report],
]

const requireFromAnubis = createRequire('C:/Users/shiyuan/go/src/web/anubis/package.json')
const { chromium } = requireFromAnubis('playwright')
const browser = await chromium.launch({ headless: true })
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 }, deviceScaleFactor: 2 })
for (const [name, html] of cards) {
  const file = join(mockups, name.replace('.png', '.html'))
  writeFileSync(file, `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${html}</body></html>`)
  await page.goto(`file://${file.replaceAll('\\', '/')}`)
  await page.waitForTimeout(120)
  await page.screenshot({ path: join(assets, name) })
  console.log('rendered', name)
}
await browser.close()



