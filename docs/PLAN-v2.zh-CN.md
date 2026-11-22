# PixelParity v2 实现方案：任意前端仓库 ↔ 设计稿 / 参考实现 / 代码原型

> 定位：不是给某个 repo 写死的验收脚本，而是一个**通用对齐工具**。Web 前端先行；桌面程序 UI（Electron、Tauri、原生窗口）通过同一套适配器接口逐步接入。
> 原则：核心与运行时解耦；能力不足时**降级并明说**，绝不假装验证过。

## 1. 范围

| 维度 | 支持目标 |
| --- | --- |
| 参考物 | 在线页面/原型、设计图（PNG/JPEG）、参考构建、Figma 导出（后续） |
| 实现物 | 本地 dev server、静态文件、Electron/Tauri 应用、桌面窗口截图 |
| 仓库 | 任意：Vue/React/Svelte/Next/Nuxt、Electron、Tauri、Qt/WPF（截图级） |
| 不被绑定 | 不假设端口、不假设路由、不假设框架、不假设只有 Web |

v1（`parity_check`）保留为“单图快检”的底层能力；v2 是配置驱动的多 case 验收系统。

## 2. 为什么 v1 不够（不只针对 anubis）

- v1 只做 **一张图 vs 一个页面**；参考物经常是“另一个可运行页面”；
- 纯像素 diff 在数据不同的两个实现之间必然产生噪声；
- 没有锚点就无法定位“哪个元素错了”，只能看整图比例；
- 字体、DPR、滚动条、动画的渲染差异会淹没真实设计差异；
- 没有基线/回归，无法守住“已经对齐的页面不被改坏”。

这些问题与具体仓库无关，所以 v2 的抽象必须从“仓库”提升到“运行时”。

## 3. 架构：核心 + 适配器

```
parity.config.yaml
        │
   ┌────▼──────────────────────────────────────────┐
   │ core                                          │
   │  config 解析 / case 编排 / 判定 / 证据 / 基线  │
   └────┬───────────────┬───────────────┬──────────┘
        │               │               │
   ┌────▼─────┐   ┌─────▼──────┐   ┌────▼─────────┐
   │ adapter  │   │ adapter    │   │ adapter      │
   │ web      │   │ electron   │   │ desktop      │
   │(Playwright│  │ (CDP)      │   │ (窗口截图)    │
   │ /Chrome) │   │            │   │ +UIA 可选     │
   └──────────┘   └────────────┘   └──────────────┘
        │               │               │
        └───────────────┴───────────────┘
                        │
              G 几何 / S 样式 / P 像素
                        │
              manifest + 截图 + 基线
```

**适配器接口**（每个 surface 实现同一组方法）：

```ts
interface Adapter {
  id: 'web' | 'electron' | 'desktop' | 'image'
  prepare(case, viewport): Promise<Session>        // 启动/连接目标
  capturePixels(session, viewport): Promise<Image> // 截图（统一 RGBA）
  captureGeometry?(session, selectors): Promise<Anchor[]>   // 可选：盒子
  captureStyles?(session, selectors): Promise<StyleToken[]> // 可选：计算样式
  dispose(session): Promise<void>
}
```

`captureGeometry` / `captureStyles` 标为可选：原生桌面可能没有 DOM，就必须走像素级或可访问性树，判定状态相应降级。

## 4. 判定模型与能力矩阵

每个 case × viewport 独立判定，三层：

| 层 | 内容 | 判定（默认） |
| --- | --- | --- |
| **G 几何** | 锚点盒子（x/y/w/h）与布局属性 | 偏差 ≤1px 或 ≤0.5%；锚点缺失=硬失败 |
| **S 样式** | 计算样式 token | 精确匹配；长度 0.5px 容差 |
| **P 像素** | 静态区逐像素；动态区掩码 | 静态区 ≤0.5%，整页 ≤1%，网格 ≤40% |

不同 surface 的能力不同，**判定状态必须如实反映**：

| surface | G | S | P | 可声明的最高状态 |
| --- | --- | --- | --- | --- |
| `web` | DOM 盒子 | computed styles | 截图 | `verified` |
| `electron` / `tauri`(WebView) | DOM（CDP） | computed styles | 截图 | `verified` |
| `desktop`（原生窗口） | 可访问性树（可选） | 部分属性 | 窗口截图 | `image-verified`（有 UIA 时 `geometry-verified`） |
| `image` | ✗ | ✗ | 区域像素 | `image-verified` |

状态命名：`verified` / `geometry-verified` / `image-verified` / `incomplete`。模型和工具都不能把低状态写成高状态。

## 5. 配置模型

配置文件按 repo 放：`<repo>/parity.config.yaml`（路径可通过工具参数覆盖）。

```yaml
version: 2
defaults:
  surface: web
  tolerance: 24
  maxMismatch: 0.01
  maxRegionMismatch: 0.40
  maxStaticMismatch: 0.005
  masks: ['[data-parity-mask]']
  freeze:
    animations: true
    caret: false

viewports:
  - { id: desktop, width: 1440, height: 900, dpr: 1 }
  - { id: mobile,  width: 390,  height: 844, dpr: 3 }

targets:
  reference:
    kind: web                  # web | image | app
    baseUrl: https://example.dev/proto/
  implementation:
    kind: web
    baseUrl: http://127.0.0.1:5173
    start: npm run dev          # 可选；已运行时 attach
    ready: /                    # 就绪探测路径

cases:
  - id: settings-page
    reference: { url: 'settings.html' }
    implementation: { path: '/settings' }
    anchors:
      header: { ref: 'header.app', impl: '[data-parity="header"]' }
      form:   { ref: 'form.settings', impl: '[data-parity="settings-form"]' }
    masks:
      - ref: '.toast'
        impl: '.toast'

  # 桌面（后续阶段）：参考是设计图，实现是运行中的应用窗口
  - id: desktop-settings
    surface: desktop
    reference:
      kind: image
      path: design/settings-1x.png
      dpr: 1
    implementation:
      kind: app
      launch: { command: './build/App.exe', args: [] }
      window: { title: 'Settings', includeFrame: false }
      crop: content
```

要点：

- `surface` 可全局默认、case 覆盖；
- 一个 case = 一个参考 × 一个实现，不靠点击导航（避免状态依赖）；
- 锚点是契约，选择器只在配置里维护；
- 阈值可分层覆盖：默认 → case → 区域；
- 参考物与实现物都允许 `web` / `image` / `app`，交叉组合（例如“设计图 vs 页面”“页面 vs 桌面应用”）。

## 6. 适配器设计

### 6.1 `web`（先落地）

- 采集：Playwright（repo 已有则复用；否则回退 v1 的 Chrome CLI，仅 P 层）；
- G/S：DOM `getBoundingClientRect` + `getComputedStyle` 白名单；
- 确定性：同一浏览器版本、同一视口/DPR、注入 `font-synthesis: none`、禁用动画/caret、冻结时钟、隐藏滚动条；
- 参考侧可选预处理：隐藏原型工具条、固定 query/locale/theme。

### 6.2 `electron` / Tauri

- Electron：`--remote-debugging-port` 启动，Playwright `chromium.connectOverCDP()` 接管；DOM G/S/P 与 web 同构；
- Tauri（Windows）：`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`；macOS 的 WKWebView 不支持同等方式，需窗口截图降级；
- 启动与就绪：等窗口出现 + 目标 selector 可见；关闭时清理子进程。

### 6.3 `desktop`（原生窗口，后续阶段）

- 截图：
  - Windows：`PrintWindow`（P/Invoke）或 `Windows.Graphics.Capture`；用 `DwmGetWindowAttribute` 取无阴影窗口矩形；
  - macOS：`screencapture -l <windowId>`；
  - Linux：`grim`（Wayland）/ `import`（X11）。
- 几何（可选）：Windows UI Automation（UIA）读元素矩形与名称；macOS AX；Linux AT-SPI。只有目标 UI 暴露了可访问性信息才有 G 层。
- 参考：设计图或“黄金构建”的截图；窗口内容区与设计图按像素尺寸对齐，系统标题栏通过 `includeFrame: false` 排除。
- 已知限制：不同 DPI 缩放、主题（浅/深）、字体渲染、窗口动画；必须固定缩放与主题，否则每次结果不同。

### 6.4 `image`

- 单图对比：设计图 vs 截图（现有 `parity_check` 的通用化）；
- 支持区域裁剪、掩码、多视口尺寸校验；
- 是桌面/无 DOM 场景的兜底，也是“设计图 vs 任意实现”的最终手段。

## 7. 交互：首次遇到在线参考时询问基准策略

基线策略不写死。`parity_run` 在采集前检测“在线参考 + 尚无基线”的 case，就地弹出问题，等用户选择后继续本次运行。

**触发条件**：参考是 `http(s)` 在线地址；该 `case@viewport` 无基线；当前允许交互（非 CI、未 `--no-prompt`、有 UI answerer）。

**问题形态**（一次运行只问一次，detail 列出命中的 case）：

```
基准策略：检测到 5 个 case 的参考物是在线页面，且尚无本地基线。这次如何建立基准？
  A 对齐在线原型并固化基线（推荐）
  B 仅本次比对，不保存基线
  C 与已有基线回归
```

实现：`ctx.userQuestions.ask({ agent: exec.agent, signal: exec.signal, questions: [...] })`，阻塞等待，答案回到本次运行；决策写进 manifest（`decision.baselineMode`、`answeredAt`）。

选 A 时只有本次 `pass` 才写基线；选 C 但基线缺失 → 该 case 标 `incomplete`，不静默跳过。

**降级**：

| 场景 | 行为 |
| --- | --- |
| 无 UI answerer（`NO_PROVIDER`） | 回退 `ephemeral`，标 `decision.fallback: 'no-provider'` |
| subagent 调用（`DELEGATED_CALLER`） | 返回 `decisionRequired`，由上层转达 |
| `CI=1` / `--no-prompt` | 有基线走回归，无基线失败并提示，不静默固化 |
| 用户跳过 | 按 `ephemeral`，不写基线 |

同一机制也用于**首次初始化**：`parity_init` 检测到多个候选运行时（web / electron / 桌面）时，用同一个交互面板让用户确认 surface，而不是猜。

## 8. 工具面

| 工具 | 职责 |
| --- | --- |
| `parity_init` | 扫描 repo（`package.json`、`vite/next/nuxt` 配置、Electron 主进程、`tauri.conf.json`、`.csproj`），生成配置草案；有歧义时交互确认 surface 与启动命令 |
| `parity_run` | 按配置跑 case × viewport，返回 G/S/P 汇总、失败区域、artifacts |
| `parity_report` | 读 manifest，输出紧凑表格与最差区域 |
| `parity_approve` | 把通过确认的 run 提升为基线（记录 commit、时间、阈值） |
| `parity_check` | 保留：单图快检，向后兼容 |

配套 skill `pixel-parity`：**建 case → 采集 → 按 G/S/P 分层修 → 回归 → 批准基线**，并明确“能力不足时降级、不谎报”。

## 9. 执行与仓库集成

- 核心以独立 CLI 交付：`node <plugin>/cli.mjs run --config parity.config.yaml --json`；插件工具只是它的封装；
- 为什么 CLI 独立：可进 CI、可脱离 DSH 用、可被别的 agent 调用；
- `parity_init` 只**建议**启动命令与端口，不写死任何仓库的路径；
- 启动策略：attach 到已运行实例 → 否则按配置 `start` 拉起 → 否则用 Playwright `webServer`；
- 并发：case 级并行（默认 2），CI 用 1 保证确定性；
- 输出目录：`<repo>/.parity/`（runs、baselines），加 `.gitignore` 建议。

## 10. 证据、基线与状态

每次 run：`.parity/runs/<runId>/`

```
manifest.json          # commit、dirty、源码 hash、配置 hash、浏览器/适配器版本、阈值、decision
cases/<case>/<viewport>/
  reference.png
  implementation.png
  diff.png
  region-1.png ...
  metrics.json         # G/S/P 明细
  dom.json             # 锚点快照（无 DOM 的 surface 为空）
```

三态/四态：`verified` / `geometry-verified` / `image-verified` / `incomplete`。

基线：`.parity/baselines/<case>@<viewport>.png`（可附带 `dom.json`）；回归模式只比基线，不依赖在线原型。

## 11. 里程碑

| 阶段 | 内容 | 说明 |
| --- | --- | --- |
| M1 ✅ | core + `web` 适配器：URL↔URL、G/S/P、掩码、manifest | 已完成，fixtures 验证 |
| M2 ✅ | 多视口 + 基线/`approve` + 回归 + 交互询问基准策略 | 已完成，回归 0.00% |
| M3 ✅ | `parity_init`：扫描 repo（框架、启动命令、候选 surface）生成配置草案 | 已完成，anubis 识别 yarn/vue/7620/29 条路由 |
| M4 ✅ | 真实仓库验证（anubis 自比对 0%、原型↔实现抓出 3.87% 差异）+ fixtures 数据拦截 | 端到端可用 |
| M5 | `electron` 适配器（CDP） | 桌面预留接口的首个实现 |
| M6 | `desktop` 截图 + Windows `image` 级判定 | 原生 UI 的诚实降级 |
| M7 | `desktop` 的 UIA 几何（Windows 先行） | 有可访问性树才升到 geometry |
| M8 | Figma 输入（REST API） | 替代截图基准 |
| M9 ✅ | IR v1：DOM → IR（tokens/节点/文本 run）→ 重新生成 Web，真实原型页回环 0.61% | 多端生成的地基 |
| M10 ✅ | 布局语义（flex/grid/table/block）+ 语义化 HTML 生成，345 节点中 336 个盒子 ≤2px，像素差 0.65% | IR 不再只靠坐标 |
| M11 ✅ | 尺寸合成：flow 渲染回测，仅按需写 `layout.pins`；345 节点中 247 个需固定尺寸（表格占 143），336 个盒子 ≤2px | IR 自描述“哪些尺寸是硬性的” |
| M12 ✅ | 表格列宽：采集首行派生 `columnWidths` + `colspan`/`rowspan`，生成 `<colgroup>`；表格单元格不再单独 pin，pin 从 247 降到 120 | 表格结构可移植 |
| M13 ✅ | SVG 几何 + 图片引用：`viewBox`/`cx`/`d`/`points`/`src` 入 IR；语义渲染图标不再丢失，pin 115，337 节点中 332 个 ≤2px | 图标与资源可复现 |
| M14 ✅ | Pin 剪枝：逐节点回测（block 类，预算 30 次渲染），21 个冗余 pin 被移除；pin 94，精度不变，导出约 18s | 只保留承重尺寸 |
| M15 ✅ | 字体资源：采集 `@font-face` 并物化到 `assets/fonts/`，语义页注入 `@font-face`；anubis 项目页抓到 PrimeIcons（35 KB），像素差 0.28% | 图标字体不再回退 |
| M16 ✅ | 作者尺寸：CSSOM 采集 `width/height` 等，只保留与实测盒一致的 px 值；201 个节点改为 `authored`，pin 从 94 降到 24，精度不变 | 显式尺寸回归“设计意图” |
| M17 ✅ | QML 生成：IR → `generated.qml`（Rectangle/Text/FontLoader/Image），qmlscene 渲染校验；原型页像素差 5.56%，导出多 1~2s | 一份 IR 首次跨端渲染 |
| M18 ✅ | 语义化 QML：可证明的 flex/block 序列映射为 Row/Column（起始对齐 + 均匀 gap），其余回退绝对定位；语义版像素差 5.78% | 生成结构可维护 |
| M19 ✅ | QML 表格与 SVG：表格按 `columnWidths` 生成 Column/Row（colspan 感知），内联 SVG 转 data-URI Image；绝对版 5.56%，语义版 5.77% | 图标与表格结构落地 |
| M20 ✅ | Figma 输入：`kind: "figma"` → `figmaToIr` → 同一 IR/渲染/比对管线；支持内联 document 离线测试 | 第三个 IR 来源 |
| M21 ✅ | 图片资源：`img.src` 与 `background-image` 下载到 `assets/images/` 并改相对路径；补齐 background-size/position/repeat 采集 | 生成页与 QML 离线可看 |
| M22 ✅ | `parity_report` 工具 + `cli report`：只读 manifest，输出每视口状态、像素差、几何失败、样式差异与热点区域 | 运行后可复查，CI 友好 |
| M23 ✅ | 自动启动：`targets.implementation.start` 在 URL 不可达时拉起命令，轮询就绪，结束后杀进程树；已运行服务复用不杀 | 一条命令跑完 |
| M24 ✅ | 多行文本：按字符落入的行盒分桶，每视觉行一个 run；QML 每行一个 Text | 换行文本不再近似 |
| M25 ✅ | 视觉效果：采集 outline/filter/backdrop-filter/mix-blend-mode（默认值剪除），渐变随 background-image 保留；IR 体积降约 2% | 描边与滤镜可复现 |
| M26 ✅ | 生成内容与表单：`::before/::after` 作为生成子节点、百分比作者尺寸、`<select>` options、表单属性；pin 24→3，盒子 ≤1px 330/337，语义像素差 0.56% | 拟合度跨过 99.4% |
| M27 ✅ | Canvas：`toDataURL` 抓帧 → `assets/images/`，HTML 输出 `<img>`、QML 输出 `Image`；被污染的画布只保留盒子 | 图表类页面不再空白 |
| M28 ✅ | QML 对齐：`justify-content: center/flex-end` 映射为 anchors（水平/垂直居中、右/底对齐）；原型 QML 5.55%/5.77% 不回归 | 布局语义更完整 |
| M29 ✅ | QML `space-between`：分布间距均匀时按起始对齐映射，不再回退绝对定位；TableView 尝试因 Qt 5.14 抓图限制暂不采用 | 常见工具栏布局可语义化 |
| M30 ✅ | 几何边界：零尺寸 flex/grid 子节点保留（占 gap）、transform(matrix) + transformedSize、grid justify-items/place-items、content-box 尺寸；anubis 盒子 ≤1px 从 89 升到 107/112，语义像素差 0.19% → 0.05% | 修复头部 8px 偏移根因 |
| M31 ✅ | 可配置容差：`geometryTolerance`（像素）进入 defaults/case/run 三层，`maxMismatch` 可按 run 覆盖；工具参数 `geometryTolerance`/`maxMismatch`，CLI `--geometry-tolerance`/`--max-mismatch` | 不再硬性 ±1px |
| M32 ✅ | 容差档位：`defaults.preset` 支持 strict(1%,1px)/balanced(2%,2px)/tolerant(5%,4px)，显式数值覆盖档位 | 一行配置“容忍多少” |
| M33 ✅ | 组合树：Shadow DOM 按 composed tree 采集（slot → assigned elements），文本 run 记录 `afterChild` 保持“图标+文字”顺序；anubis 盒子 108/108 ≤1px、像素差 0.01% | 组件化页面与按钮顺序正确 |
| M34 ✅ | QML 收尾：纯旋转映射 `rotation`+`transformOrigin`、线性渐变→`Gradient`、`background-image`→`Image`、`video poster`→`Image`；`content:url()` 伪元素转背景图；插件详情页 `docs/DETAIL*.md` + `preview.svg`，版本 0.3.0 | P0/P1 采集与展示补齐 |
| M35 ✅ | 语义 HTML/CSS 生成器：`--export-component` 输出 `generated.component.html/.css`（类复用、`:root` token 变量、`::before/::after` 还原、`@font-face`、相对资源）；原型像素差 0.43%，优于语义版 0.52% | 从“保真证明页”到可维护代码 |
| M36 ✅ | 组件 CSS 剪枝与可读类名：默认值剪除 + `button` UA 重置 + 伪元素签名入类键；CSS 159KB→93KB，类名 `div-container` 等，像素差保持 0.44% | 产物更接近可维护代码 |
| M37 ✅ | 组件抽取：按深度 3 结构签名聚类，≥3 实例输出 `generated.components.json` + `components/*.html`（`{{textN}}` 槽位）；原型抽出表格行×16、导航链接×11、信息块×6、导航按钮×4，主渲染不变 | 重复结构可复用 |
| M38 ✅ | CSS 简写合并与作用域过滤：padding/margin/border/gap/flex 合并为简写，SVG 绘制属性只在 SVG 内输出、表格属性只在 table 上输出；CSS 93KB→59KB（累计 159KB→59KB），像素差 0.43% | 产物更精简 |
| M39 ✅ | LLM 闭环：manifest 记录 `iteration`/`parentRun`/`delta`；新增 `parity_diagnose`（按几何→样式→像素+重叠 IR 节点排序）与 CLI `diagnose`；skill/README 明确“测量仪/迭代器，不是低代码生成器” | 迭代对齐可测量、可审计 |

每个阶段都用真实 repo 验证：Web 阶段用任意 Vue/React 项目（anubis 只是其中一个测试样本，不进入插件代码）。

## 12. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 字体/抗锯齿噪声 | 双端同管线注入；tolerance；文本区掩码；以 G/S 为准 |
| 数据漂移 | fixtures 或掩码；数据区只比结构 |
| 参考是活页面、会改版 | 基线化 + 显式 approve |
| 选择器脆弱 | `data-parity` 属性 + 配置集中维护 |
| 桌面 DPI/主题/字体 | 固定缩放与主题；`includeFrame:false`；记录环境 |
| 原生 UI 无 DOM | 明确降级为 `image-verified`，有 UIA 才升 `geometry-verified` |
| CI 无桌面环境 | headless shell + 固定浏览器版本；桌面阶段单独 runner |
| 误报导致“狼来了” | 分层报告 + 区域裁剪 + 基线回归，不做单一整页分数 |

## 13. 验收（工具自测，与 repo 无关）

1. 同一目标连续两次 run：0 差异（确定性）；
2. 同一 commit 两次：0 差异；
3. 偏移 4px：G 报 delta=4，P 对应区域失败；
4. 改一个颜色：S 报 expected/actual；
5. 只改数据不改布局：掩码后 pass；
6. 删除锚点：硬失败并指明；
7. 基线 approve 后改样式：回归失败；
8. 没有 PNG/无浏览器/无 Playwright 的 repo：给出明确的安装/降级提示，不崩溃；
9. 桌面 case 在只有截图能力时：状态为 `image-verified`，报告里写明“无几何证据”。

## 附录 A：anubis 作为 Web 阶段的验证样本

anubis 不进入插件代码，只作为“真实仓库验证”的一个样本：

- hub dev `7620`，`pages.js` 集中路由；Playwright 1.58.2 + chromium 已安装；
- 已有 `apps/hub/e2e/hub-api.spec.js` 的全量 API mock fixture，可作为确定性数据源；
- 首批 5 个 case：`/projects`、`/device-analysis`、`/defects`、`/monitor`、`/monitor-record`；
- 给关键容器加 `data-parity` 属性（纯增量，不改样式）。

接入步骤与配置示例见 `docs/EXAMPLES.md`（落地时补充）。
