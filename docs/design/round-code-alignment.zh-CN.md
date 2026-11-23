# Round 内代码对齐方案（Git 分支 / Commit / LLM）

> 状态：方案设计，未实现  
> 目标：每轮不仅测量 diff，还让 Agent 在独立分支上修改代码，并留下可审查、可回滚的提交。

## 结论先行

- **分支**：每轮一个链式分支 `pp/<repo-slug>-<projectId4>/rNN`，Round 1 从 base commit 拉出，Round N 从上一成功轮的分支 HEAD 拉出。
- **提交**：**按 subtask 提交**，一个 subtask 一个 commit；轮次结束打 tag `pp-rNN`。不额外做“整轮 commit”。
- **Message**：Conventional 风格 + 机器可读 trailers（`PP-Round`、`PP-Subtask`、`PP-Base`、`PP-Before/After`）。
- **LLM**：由插件**指挥 DSH Agent** 修改代码；插件负责测量、校验、commit，Agent 不允许自行 commit。
- **多轮**：Round 2 在 Round 1 分支基础上继续，不重新从 base 切；失败轮次回滚，不推进链条。

---

## 1. 分支如何命名

### 命名规则

```
pp/<repo-slug>-<projectId4>/r<NN>
```

- `repo-slug`：仓库目录名小写、非字母数字转 `-`，截断 24 字符；
- `projectId4`：project id 的随机后缀，避免同名项目冲突；
- `r<NN>`：两位轮次号。

示例：

```
pp/anubis-a1b2/r01
pp/anubis-a1b2/r02
pp/anubis-a1b2/r10
```

### 创建规则

| 轮次 | 起点 |
| --- | --- |
| Round 1 | `baseCommit` |
| Round N（N>1） | 上一个**成功**轮次的分支 HEAD |
| 上一轮失败/无提交 | 回退到最近一个成功轮次的分支 HEAD |

- 若同名分支已存在：默认报错，避免覆盖；只有“恢复该轮”才复用。
- 每轮同时打轻量 tag：`pp-r01`、`pp-r02`，用于报告引用与回滚。

> 如果团队更希望每个项目只维护一个长期分支，可切换为 `pp/<slug>-<id4>` + 每轮 tag；本方案默认“每轮一条链式分支”，便于按轮 review。

---

## 2. 如何 commit：按轮还是按 subtask

**默认按 subtask commit。**

理由：

- 一个 subtask 的改动可单独 revert；
- 报告能精确关联“哪个冲突/哪个文件属于哪个子任务”；
- 多 subtask 共用文件时，冲突在提交顺序中自然解决；
- PR review 可按 commit 查看。

规则：

1. 每个 subtask 开始前记录 `headBefore`；
2. Agent 修改后，插件运行 `git diff`；
3. 无改动 → 跳过，不产生空 commit；
4. 改动有效 → 只 `git add` 该 subtask 范围内的文件并 commit；
5. 轮次结束 → 在最终 HEAD 打 tag `pp-rNN`；
6. 不生成额外的“round commit”。

可配置：

```json
{
  "commitMode": "per-subtask" | "per-round"
}
```

`per-round` 用于“希望一轮只有一个 commit”的团队：所有 subtask 改动合并为一个 commit，消息列 subtasks。

---

## 3. Commit message 模板

### per-subtask

```
pp(<subtask-id>): align <page/section> to design

Project: <project name> (<projectId>)
Round: <NN>
Subtask: <subtask title> (<subtask id>)
Case: <caseId>
Design: <design source URL/path>
Base: <baseCommit short>
Before: pixels <x>%, geometry <pass/fail>, styles <pass/fail>
After: pixels <y>%, geometry <pass/fail>, styles <pass/fail>
Scope: <主要文件或区域>

PP-Project: <projectId>
PP-Round: <NN>
PP-Subtask: <subtaskId>
PP-Base-Commit: <baseCommit>
PP-Design-Source: <source location>
```

示例：

```
pp(projects): align projects page to design

Project: anubis (proj-20261123175913-botp)
Round: 3
Subtask: projects (projects)
Case: projects
Design: https://liumeitong66.github.io/SPC/01-项目统计首页.html
Base: 4363d81
Before: pixels 10.59%, geometry pass, styles pass
After: pixels 4.12%, geometry pass, styles pass
Scope: apps/hub/src/views/ProjectStatsDesign.vue

PP-Project: proj-20261123175913-botp
PP-Round: 3
PP-Subtask: projects
PP-Base-Commit: 4363d81
PP-Design-Source: https://liumeitong66.github.io/SPC/01-项目统计首页.html
```

### per-round

```
pp(round-<NN>): align <n> subtasks

Project: ...
Round: <NN>
Subtasks: projects, shell
Base: <base>
Before/After: ...
PP-Round: <NN>
PP-Subtasks: projects,shell
```

提交作者使用仓库已有 git 配置；不伪造用户身份。可选 trailer：`Co-authored-by: DSH <dsh@local>`。

---

## 4. 代码修改是否由插件指挥 LLM 完成

**是，但分工明确：**

| 角色 | 职责 |
| --- | --- |
| 插件（Host） | 创建/切换分支、测量、生成修复 brief、调用 Agent、校验 diff、commit、打 tag、写报告 |
| DSH Agent（LLM） | 在项目 worktree 内读代码、改代码、必要时运行局部检查 |
| 用户 | 触发轮次、查看报告、审查分支/PR |

### 每轮流程

```
Run next round
  → 校验 worktree 干净、服务可用
  → 从上一成功轮 HEAD 创建分支 pp/<slug>/rNN
  → for each selected subtask:
       1. 测量当前实现（Before）
       2. 由 findings/plan 生成修复 brief
       3. 启动 Agent（cwd = project worktree）
          约束：只改实现代码；禁止改设计源/配置/依赖；禁止 commit
       4. Agent 完成后检查 git diff
       5. 重新测量（After）
       6. 通过或指标改善 → git add 范围内文件 + commit
          否则 → git reset --hard <headBefore>，记录失败
  → 打 tag pp-rNN
  → 生成本轮报告（分支、commits、Before/After）
```

- Agent 通过 `ctx.agents` / subagent 机制启动，不由插件直接调用 `llm.stream` 写代码；
- Agent 必须使用文件编辑工具，插件只接受落盘后的 diff；
- 插件在 Agent 前后各测量一次，报告明确 Before/After；
- 是否“必须改善才提交”可配置，默认 `requireImprovement: true`。

### 安全边界

- 只允许修改实现目录（默认 `apps/`、`src/`，可配置 allowlist）；
- 禁止修改 `parity.config.*`、设计源、`package.json`/lockfile（除非显式允许）；
- Agent 超时（默认 10 分钟）后中止并回滚；
- 每次 Agent 运行有 token/轮次预算；
- 不把 secrets 写入 prompt 或 commit。

---

## 5. 多次 round 如何管理

**Round 2 不重新从 base 切，而是从 Round 1 分支 HEAD 继续。**

```
base 4363d81
  └─ pp/anubis-a1b2/r01   Round 1（成功）
       └─ pp/anubis-a1b2/r02   Round 2（成功）
            └─ pp/anubis-a1b2/r03   Round 3（失败，丢弃）
                 └─ pp/anubis-a1b2/r04  从 r02 重新切
```

规则：

1. 每轮新分支的起点 = **上一成功轮的分支 HEAD**；
2. 失败轮次：`git reset --hard` 回滚未提交改动；分支可删除或保留为 `-failed`；
3. 不在失败分支上继续下一轮，避免把无效改动带入；
4. 保留 tag `pp-rNN` 对应成功轮次；
5. 项目页显示分支链与每轮 commit 数；
6. 项目删除时：默认保留分支供 review，可选 `deleteBranches` 删除。

### 为什么不每轮从 base 切

- 会丢失上一轮已完成的修复；
- 需要 cherry-pick/merge，冲突和不可比指标更复杂；
- 报告无法形成连续改进链。

### 什么时候需要从 base 新切

- 用户明确要求“从干净基线重做”；
- base commit 变更（必须新建项目）；
- 对比实验（保留旧链，另建 `.../rNN-exp`）。

---

## 数据模型补充

```json
{
  "branch": "pp/anubis-a1b2/r02",
  "baseCommit": "4363d81",
  "rounds": [
    {
      "number": 2,
      "branch": "pp/anubis-a1b2/r02",
      "baseSha": "<r01 head>",
      "headSha": "<r02 head>",
      "status": "completed",
      "commits": [
        { "subtaskId": "projects", "sha": "abc1234", "message": "pp(projects): ..." }
      ]
    }
  ]
}
```

Round 状态扩展：

```
queued → measuring → editing → verifying → committing → completed
                                      ↘ failed → rolled-back
```

## 报告内容

每轮报告新增：

- 分支名与起点 commit；
- 每个 subtask 的 Before/After 指标；
- commit 列表与文件统计；
- 失败/回滚原因；
- 一键复制分支名 / commit SHA / PR 描述。

## 风险与对策

| 风险 | 对策 |
| --- | --- |
| Agent 改错文件 | allowlist + diff 范围校验 + 失败回滚 |
| 多 subtask 改同一文件 | 顺序提交；后一个 subtask 重新测量 |
| 分支名冲突 | 项目短 id + 轮次；已存在则报错 |
| worktree 不干净 | 每轮开始 `git status --porcelain` 必须为空 |
| 提交无改善 | `requireImprovement` 默认 true，否则回滚 |
| 用户仓库污染 | 只在项目 worktree 操作，不切主仓库分支 |
| 分支堆积 | 项目结束提供清理/归档；保留 tag |

## 配置草案

```json
{
  "branchPrefix": "pp",
  "commitMode": "per-subtask",
  "requireImprovement": true,
  "agentTimeoutMs": 600000,
  "allowPaths": ["apps/", "src/"],
  "denyPaths": ["parity.config.mjs", "package.json", "pnpm-lock.yaml", "yarn.lock"],
  "deleteBranches": false
}
```
