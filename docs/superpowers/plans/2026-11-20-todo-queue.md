# 待办队列（issue/ + INDEX + AGENTS.md）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在仓库里建一个 agent 每次开工都能看到的待办队列：`issue/` 存待办（带状态）+ `issue/INDEX.md` 同步摘要+状态 + `AGENTS.md` 约束 agent 读未完成待办列给用户选继续，并用 lint 保 INDEX↔文件双向一致。

**Architecture:** 纯约定方案（Approach A）：`issue/` 一文件一条待办（frontmatter 记 id/title/status/summary），`issue/INDEX.md` 一行一条做摘要索引，二者由 `scripts/todo-lint.mjs` 校验双向一致；`AGENTS.md` 追加一段开工约束。全程不碰 OpenSpec（其输出 100% 不含待办内容）。

**Tech Stack:** Node.js ≥22（ESM，`.mjs`）、vitest（测试）、`node:fs`/`node:path`（无第三方依赖）。

**Spec:** `docs/superpowers/specs/2026-11-20-todo-queue-design.md`

## Global Constraints

- OpenSpec 输出（`instructions --json` 等）**100% 不含任何 issue 内容，连指针都不含**；本功能不改 `openspec/` 下任何文件、不接 `openspec/config.yaml`。
- 约束落 `AGENTS.md`（harness 层），不依赖 OpenSpec 是否安装。
- 状态取值仅四态：`未开始` / `进行中` / `已完成` / `受阻`（逐字，CJK）。
- `issue/<id>.md` frontmatter 四键：`id` / `title` / `status` / `summary`；文件名 `<id>.md` 与 frontmatter `id` 必须一致。
- `issue/INDEX.md` 行格式：`| <id> | <title> | <status> | <summary> |`，与文件逐字一致、按 id 排序。
- `summary` 禁止含 `|` 或换行（否则破坏表格解析，lint 打回）。
- lint：`node scripts/todo-lint.mjs [--project <root>]`（默认 cwd），读 `<root>/issue/`；干净 exit 0，有违规 exit 1 并逐条打印。

## Review Focus

- **孤儿文件 / 孤儿索引行**：`issue/<id>.md` 无对应 INDEX 行、或 INDEX 行无对应文件 —— lint 须双向都打回（人会以为有/没有这条待办）。
- **列内容漂移**：INDEX 行的 title/status/summary 与文件 frontmatter 不一致 —— lint 须逐字比对打回。
- **非法状态**：status 不在四态内（手滑写第 5 个值）—— lint 须打回。
- **文件名-id 不符**：`issue/foo.md` 里 `id: bar` —— lint 须打回（否则索引按 id 排、文件按名找会对不上）。
- **summary 含 `|`/换行**：会把 INDEX 表格列解析错位 —— lint 须明确打回，而非静默错解。
- **空 issue/ 目录**（还没待办）—— lint 须 exit 0，不崩溃。

---

## File Structure

- Create: `scripts/todo-lint.mjs` — lint：解析 `issue/` 与 `issue/INDEX.md`，校验双向一致 + 状态 + 文件名-id；导出 `runLint(root)` 供测试，CLI 入口供命令行。
- Test: `test/todo-lint.test.ts` — vitest，临时目录造 fixture 断言 `runLint` 返回的 violations 与 CLI 退出码。
- Create: `issue/INDEX.md` — 索引（注释头 + 行）。
- Create: `issue/todo-001.md` — 一条示例待办（合法，用于种子与自校验）。
- Modify: `AGENTS.md` — 追加开工约束段。

---

### Task 1: todo-lint 解析 + INDEX↔文件双向一致

**Files:**
- Create: `scripts/todo-lint.mjs`
- Test: `test/todo-lint.test.ts`

**Interfaces:**
- Produces: `runLint(root: string): { violations: string[] }`（在 `scripts/todo-lint.mjs` 以 ESM named export 导出；`violations` 空数组=干净）。后续任务与 CLI 复用。
- 内部约定（本任务实现）：解析 `issue/<id>.md` frontmatter 得 `{id,title,status,summary}`；解析 `issue/INDEX.md` 每个 `|` 行得同样四元组（忽略 `#` 注释行与空行）。

- [ ] **Step 1: 写失败测试——缺索引行**

`test/todo-lint.test.ts` 里建 fixture（`node:fs.mkdtemp` 造 `<tmp>/issue/todo-001.md`，含合法 frontmatter，但 INDEX 无行），断言：

```ts
import { describe, expect, it } from 'vitest';
import { runLint } from '../scripts/todo-lint.mjs';

it('文件无对应 INDEX 行 → 违规', () => {
  const { violations } = runLint(tmpRootWithFileButNoIndexRow);
  expect(violations.some(v => v.includes('todo-001') && v.includes('缺'))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm vitest run test/todo-lint.test.ts`
Expected: FAIL（`runLint` 未定义 / 未导出）。

- [ ] **Step 3: 实现 `runLint` 的解析与"缺索引行"检测**

在 `scripts/todo-lint.mjs` 写最小 frontmatter/INDEX 解析 + "文件存在但 INDEX 无对应 id" → push 一条 violation。无需第三方 YAML 库：frontmatter 取 `---` 之间 `key: value` 行（值取行剩余并 trim）；INDEX 取 `|`-split 行（跳过 `#`/空行），trim 各列。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run test/todo-lint.test.ts`
Expected: PASS（该用例）。

- [ ] **Step 5: 补失败测试——孤儿索引行 + 列漂移 + 干净态 + 空目录，逐个补、跑、过**

- 孤儿索引行：INDEX 有行、无对应 `<id>.md` → violation。
- 列漂移：INDEX 行 summary 与文件 summary 不一致 → violation。
- 干净态：文件与 INDEX 一致 → `violations` 为空数组。
- 空 issue/：目录存在但无待办、INDEX 无行 → `violations` 为空（不崩溃）。
  每条按 Step1/2/3/4 的节奏（先写断言跑红、再补实现跑绿）。`summary`/`title` 逐字比对。

- [ ] **Step 6: 跑全测试确认通过**

Run: `pnpm vitest run test/todo-lint.test.ts`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add scripts/todo-lint.mjs test/todo-lint.test.ts
git commit -m "feat(todo): todo-lint 解析与 INDEX↔文件双向一致校验"
```

---

### Task 2: todo-lint 状态 / 文件名-id 校验 + CLI 出口

**Files:**
- Modify: `scripts/todo-lint.mjs`
- Test: `test/todo-lint.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `runLint(root)`。
- Produces: `runLint` 增加两类违规；CLI `main()`：`node scripts/todo-lint.mjs [--project <root>]`，干净 exit 0，否则 exit 1 并逐条 `console.error` 违规。

- [ ] **Step 1: 写失败测试——非法状态**

fixture：`issue/todo-001.md` 的 `status: 进行中ing`（不在四态）→ 断言 violation 提到 `todo-001` 与"状态"。

```ts
it('状态不在四态 → 违规', () => {
  const { violations } = runLint(tmpRootWithBadStatus);
  expect(violations.some(v => v.includes('todo-001') && v.includes('状态'))).toBe(true);
});
```

- [ ] **Step 2: 跑测试确认失败**（Run: `pnpm vitest run test/todo-lint.test.ts`；Expected: FAIL）。

- [ ] **Step 3: 实现状态校验**（`status` 必须 ∈ `['未开始','进行中','已完成','受阻']`，否则 violation）。

- [ ] **Step 4: 跑测试确认通过**。

- [ ] **Step 5: 写失败测试——文件名-id 不符 + summary 含 `|`**，逐个补、跑、过

- `issue/foo.md` 的 `id: bar` → violation。
- `summary` 含 `|` 或换行 → violation（明确打回，不静默错解）。

- [ ] **Step 6: 写失败测试——CLI 退出码**

`child_process.spawnSync('node', ['scripts/todo-lint.mjs','--project', tmp])`：
- 干净 fixture → `status === 0`。
- 含违规 fixture → `status === 1` 且 `stderr` 含违规文字。

- [ ] **Step 7: 实现 `main()` CLI**（解析 `--project`（默认 `process.cwd()`），调 `runLint`，打印并按有无违规设 `process.exitCode`）。跑 Step 6 测试过。

- [ ] **Step 8: 跑全测试确认通过**（Run: `pnpm vitest run test/todo-lint.test.ts`；Expected: PASS）。

- [ ] **Step 9: Commit**

```bash
git add scripts/todo-lint.mjs test/todo-lint.test.ts
git commit -m "feat(todo): todo-lint 状态/文件名校验与 CLI 退出码"
```

---

### Task 3: issue/ 约定 + 示例 + AGENTS.md 约束段

**Files:**
- Create: `issue/INDEX.md`
- Create: `issue/todo-001.md`
- Modify: `AGENTS.md`

**Interfaces:**
- Consumes: Task 2 的 lint（用它自校验种子数据）。
- Produces: `issue/` 就位、`AGENTS.md` 含约束段。运行 `node scripts/todo-lint.mjs --project .` → exit 0。

- [ ] **Step 1: 建 `issue/todo-001.md`**（合法示例）

```markdown
---
id: todo-001
title: 示例待办：跑通 todo-queue 约定
status: 未开始
summary: 用这条验证 issue 与 INDEX 双向一致
---
正文写细节（自由格式）。
```

- [ ] **Step 2: 建 `issue/INDEX.md`**（注释头 + 一行，逐字对齐上文）

```markdown
# issue/INDEX.md — 一行一条，与 issue/*.md 双向一致（scripts/todo-lint.mjs 校验）
# 格式：| <id> | <title> | <status> | <summary> |
# 状态取值：未开始 / 进行中 / 已完成 / 受阻；按 id 排序；summary 逐字取自 frontmatter。

| todo-001 | 示例待办：跑通 todo-queue 约定 | 未开始 | 用这条验证 issue 与 INDEX 双向一致 |
```

- [ ] **Step 3: 跑 lint 自校验**

Run: `node scripts/todo-lint.mjs --project .`
Expected: exit 0（种子数据一致）。

- [ ] **Step 4: 写 AGENTS.md 约束段**（追加小节）

```markdown
## 待办队列（issue/）
每次开工前先读 `issue/INDEX.md`，把状态≠已完成的待办列给用户选继续哪些；
做完一条就更新 `issue/<id>.md` 的 frontmatter 状态，并同步 `issue/INDEX.md` 对应行
（改完跑 `node scripts/todo-lint.mjs --project .` 确认一致）。
```

- [ ] **Step 5: 校验 AGENTS.md 含约束段**（手工/`grep -q '待办队列' AGENTS.md` 确认存在；这是文案，靠 review 把关）。

- [ ] **Step 6: 跑全量套件确认无回归**

Run: `pnpm test`
Expected: 全绿（新增 todo-lint 测试 + 既有套件不回归）。

- [ ] **Step 7: Commit**

```bash
git add issue/ AGENTS.md
git commit -m "feat(todo): issue/ 待办约定 + AGENTS.md 开工约束"
```
