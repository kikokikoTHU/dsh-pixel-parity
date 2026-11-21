# 代码管理与发布方案

面向 PixelParity 这类 DSH 插件：单包仓库起步，按需拆包；发布走 npm + 语义化版本；
DSH 侧通过 profile bundle 安装与升级。

## 1. 代码组织

### 现在：单包仓库

```
dsh-pixel-parity/
  index.js            # DSH 入口：注册工具与技能
  cli.mjs             # 独立 CLI
  core/               # 配置、编排、判定、基线、初始化
  adapters/           # 运行时适配器（web 已实现，electron/desktop 预留）
  lib/                # PNG、diff、palette、浏览器
  skill/              # 技能正文
  locale/             # 插件显示元数据
  docs/               # 方案、示例、发布流程
  test/               # 单元 + 端到端 fixture
```

约束：

- `core/` 不 import `index.js`，也不 import DSH 服务；工具层只做参数校验和结果渲染。
- 适配器只暴露 `prepare/capture/dispose` 形状，新增桌面运行时不改 core。
- 发布物只包含 `files` 白名单里的文件；测试与文档不进入 npm 包（除非明确需要）。

### 什么时候拆包

出现以下任一情况再拆成 monorepo（`packages/core`、`packages/adapter-web`、`packages/cli`、
`packages/dsh-plugin`）：

- 桌面适配器需要独立的原生依赖；
- CLI 要被其他仓库当作 devDependency 安装；
- 需要单独给 core 发版本。

拆包时用 pnpm workspaces + changesets；DSH bundle 保持薄包装，只依赖 core。

### Git

- `git init`，`main` 保护，禁止直推；
- 分支 `feat/…`、`fix/…`，PR 合并；
- Conventional Commits（`feat:`、`fix:`、`chore:`、`docs:`），changesets 据此生成版本与 CHANGELOG；
- 标签 `vX.Y.Z` 与 `package.json` 版本一致；
- `.gitignore`：`node_modules/`、`.parity/`、`*.log`、`.DS_Store`。

## 2. 质量门（CI）

每次 PR：

1. `node --check` / import 冒烟；
2. `test/run-tests.js`（v1 引擎，需要 Chrome）；
3. `test/v2.test.mjs`（核心 + 端到端，需要仓库里有 Playwright，CI 用官方镜像或 `npx playwright install chromium`）；
4. `npm pack --dry-run` 检查文件清单：`cordis.patch.yml`、`locale/*.json`、`icon.svg`、`index.js`、`core/`、`adapters/`、`lib/`、`skill/`、README；
5. 对生成的 tarball 做一次干净 profile 安装冒烟（可选，发布前必做）。

GitHub Actions 骨架：

```yaml
name: ci
on: [push, pull_request]
jobs:
  test:
    runs-on: ${{ matrix.os }}
    strategy:
      matrix:
        os: [ubuntu-latest, windows-latest]
        node: [22, 24]
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: ${{ matrix.node }} }
      - run: npm ci
      - run: npx playwright install --with-deps chromium
      - run: node test/run-tests.js
      - run: node test/v2.test.mjs
      - run: npm pack --dry-run
```

## 3. 版本与兼容

Semver 规则：

| 变更 | 版本 |
| --- | --- |
| 工具参数/返回值破坏性变化、配置格式不兼容 | major |
| 新增工具/配置字段、判定行为变化 | minor |
| 修复、文案、性能 | patch |

兼容性：

- 插件不 import 任何 `@deepseek-ai/*` 包，只依赖宿主注入的 `ctx.tools`、`ctx.skills`、
  `ctx.get('userQuestions')` 和 Node 内置模块；因此**不需要 peerDependencies**。
- 在 README/CHANGELOG 里声明“在 DSH 0.2.x 上验证”；每次 DSH 升级跑一遍端到端。
- `engines.node` 声明 `>=22`（Playwright 与 DSH 运行时要求）。
- 桌面适配器上线时，按 surface 分别声明支持矩阵。

## 4. 发布流程（npm）

一次性准备：

- `package.json` 去掉 `private: true`，补 `repository`、`keywords`、`license`、`author`；
- 加 `LICENSE`（MIT）；
- 加 `CHANGELOG.md`（changesets 生成）；
- npm scope：包名 `dsh-pixel-parity` 目前未被占用；组织发布用 `@scope/dsh-pixel-parity`；
- npm 账号开启 2FA，CI 用 granular token。

每次发布：

```sh
npx changeset                 # 选择 minor/patch，写变更说明
npx changeset version         # 升版本、生成 CHANGELOG
git commit -am "chore: release v0.2.0"
git tag v0.2.0
npm publish --provenance --access public
```

发布后验证：

```sh
npm view dsh-pixel-parity version dist.tarball
npm pack dsh-pixel-parity@0.2.0 --dry-run    # 文件清单
```

## 5. 分发渠道

| 渠道 | 适用 | 做法 |
| --- | --- | --- |
| npm 公共 | 开源、社区 | `npm publish` |
| 私有 registry | 公司内部 | `.npmrc` 指向 Verdaccio/Nexus；profile 安装时带 registry |
| 本地目录 | 开发 | `plugin_manager install_bundle` 传绝对路径（junction 链接） |
| tarball | 灰度/离线 | `npm pack` 后 `dsh plugin --profile <p> add ./dsh-pixel-parity-0.2.0.tgz` |
| 插件市场索引 | 曝光 | 按市场 index 格式提交条目；本机 plugin-market 未启用，先不做 |

## 6. DSH 侧的安装、升级、回滚

安装：

```
dsh plugin --profile web add dsh-pixel-parity@0.2.0
```

或让 Plugin Manager 安装；bundle 会写进 profile 的 `package.json` 与 `dsh.profile.bundles`。

升级：装新版本 → **重启 DSH**（已加载的模块不会热替换；新装 bundle 可以 HMR，替换不行）。

回滚：安装上一个版本（`dsh-pixel-parity@0.1.0`）；必要时 `npm deprecate dsh-pixel-parity@0.2.0 "reason"`。

配置：用户改 `$DSH_PROFILE_DIR/cordis.patch.yml` 的 row config，升级不会覆盖。

关闭：`plugin_manager set_plugin` 或从 profile bundles 移除，不需要卸载代码。

## 7. 安全

- 发布使用 `--provenance`（GitHub Actions OIDC）；
- 不添加 `postinstall` / `prepare` 运行时代码；
- devDependencies 固定版本，定期 `npm audit`；
- 插件不联网、不写 profile 之外的路径；`.parity/` 只写目标仓库；
- 安装第三方插件前审阅 `cordis.patch.yml` 与入口文件。

## 8. PixelParity 的落地清单

1. `git init` + 首次提交 + 推送 `git@github.com:kikokikoTHU/dsh-pixel-parity.git`；
2. 补 `CHANGELOG.md`（LICENSE、`repository`、`keywords`、`private` 已在 0.2.0 处理）；
3. 版本从 `0.1.0` 升到 `0.2.0`（v2 功能）；
4. 加 changesets 与 `.github/workflows/ci.yml`、`release.yml`；
5. 首次发布前，在干净 profile 用 tarball 安装并跑一次 `parity_run` 冒烟；
6. 可选：桌面适配器落地后再拆 monorepo。
