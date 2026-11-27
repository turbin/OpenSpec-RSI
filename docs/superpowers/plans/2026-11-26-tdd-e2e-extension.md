# tdd-e2e 扩展实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `extensions/tdd-e2e/` 落地 TDD schema + e2e 门禁扩展包（含 runner/受管归档/收尾三脚本），并完成本仓 dogfood 接线。

**Architecture:** 纯扩展包，零核心 CLI 改动（仿 `extensions/experience-loop/` 先例）：`tdd-driven` schema（spec-driven 全量 fork + tests/evidence 工件）+ 三个零依赖 `.mjs` 脚本（共享 `scripts/lib/` 模块）+ README。安全属性以 §6.3 三条契约为准，实现须逐字遵循。

**Tech Stack:** Node ≥22 ESM（零新依赖，仅 node 内置模块）、vitest（复用仓库测试栈）、TypeScript 测试（`test/extensions/` 沿既有模式 import `src/` 与扩展脚本）。

**Spec:** `docs/superpowers/specs/2026-11-26-tdd-e2e-artifacts-design.md`（本计划从该设计论证，执行者需同时阅读；安全属性在设计 §6.3，勿自行改语义）

## Global Constraints

以下为设计 §6.3 的安全属性，逐字生效，任何任务不得偏离：

- **发布资格 = 受信执行成功 ∧ 快照绑定一致 ∧ 台账/发布契约通过**；退出码只是"本次测试是否通过"。
- **`authority` 字段仅记录执行环境（ci/local/pre-commit），永不参与判定**；机器记录只是溯源/诊断。
- **输入键 v1** = {仓库根业务/测试输入，规划根 delta/台账/元数据，策略版本 hash}；**精确排除**生成记录（`runs/`、`evidence.md` 投影、`.staging/`）与授权记录本身；**不排除 `openspec/tdd-e2e/`**；EOL 归一化仅适用文本；symlink 默认拒绝；字节敏感文件不归一化。
- **fail-closed**：命令链全空且无豁免 = FAIL；元数据无效 = FAIL；未执行永不记 PASS；超时 = 红。
- **蕴含式**：按**有效 schema**（显式覆盖→change 元数据→项目默认→spec-driven）执法，有效 schema 为 `tdd-driven` ⇒ 必须有绿证据；0-task 同样受限；`enforce: "all-changes"` = 全员收测试门禁但不强求补台账。
- **扁平点号键**：`.openspec.yaml` 只认 `x-tdd-e2e.command` / `x-tdd-e2e.skip` / `x-tdd-e2e.skip_reason`（顶层 `x-*` 命名空间），近似键 typo 诊断。
- **幂等复用**：仅"同输入键 v1 ＋完整＋成功＋通过清单校验"的本地 bundle 可复用；红灯/损坏/残片/仅元数据变化不复用。
- **--execute 归档**：移动阶段无半态——目标预检、同文件系统/no-clobber、保留日期前缀（`YYYY-MM-DD-<name>`）、复验到移动间文件锁、失败回退；sync 是前置工作，命令校验 sync 完整性。
- **零新依赖**；**不改 `src/` 核心**（本计划只新增 `extensions/`、`test/`、`docs-lab/`、`package.json` 脚本、`.github/workflows/ci.yml` 接线）。
- 测试命令统一：`corepack pnpm exec vitest run <file>`；提交信息沿仓库惯例（`feat(ext):`/`test(ext):` 前缀）。

## Review Focus

以下输入/失败模式设计已规定但最易在实现中走样，每条的测试钉在所属任务：

1. **指纹把 evidence/deliverables 自身算进去**（写证据即弄脏指纹 → 门禁死锁）→ Task 2 排除规则测试。
2. **lint 在 change 元数据无效/缺失时静默放行**（schema 绕行）→ Task 5 无效元数据 FAIL 测试。
3. **幂等把红灯/损坏 bundle 当绿复用**（旧绿放行）→ Task 4 复用条件四测试。
4. **Windows CRLF 造成假陈旧**（CI LF vs 本地 CRLF）→ Task 2 EOL 归一化测试。
5. **命令链为空时静默"没配就绿"** → Task 3 fail-closed 测试。

## File Structure

| 文件 | 职责 |
|---|---|
| `extensions/tdd-e2e/schema/schema.yaml` | `tdd-driven` 工件图与全部 instruction（fork 自 `schemas/spec-driven/` + tests/evidence） |
| `extensions/tdd-e2e/schema/templates/tests.md` | 红绿台账模板（结构化表格：能力/需求/场景/用例/测试路径/状态） |
| `extensions/tdd-e2e/schema/templates/evidence.md` | 证据模板（台账回填/摘要/失败清单/制品清单/豁免标记） |
| `extensions/tdd-e2e/scripts/lib/fingerprint.mjs` | 输入键 v1：git 跟踪文件遍历、排除、EOL 归一化、tree-hash |
| `extensions/tdd-e2e/scripts/lib/config.mjs` | 项目配置加载、命令发现链（受信源优先）、x- 键解析+typo 诊断 |
| `extensions/tdd-e2e/scripts/lib/bundle.mjs` | run-id、staging、bundle 完整性校验（复用条件）、run lock |
| `extensions/tdd-e2e/scripts/e2e-gate.mjs` | 运行协议（前后指纹/超时=红/authority 记录/collect 清单）＋ `--finalize` 幂等收尾 ＋ `--rerun` |
| `extensions/tdd-e2e/scripts/e2e-lint.mjs` | `--gate` 权威判定（判定表/EXEMPT/快照绑定/台账对账/发布契约）＋ `--archive-gate --execute` 受管归档 |
| `extensions/tdd-e2e/scripts/install.mjs` | 落位 schema 与脚本、打印 config.yaml 建议片段（含限定语） |
| `extensions/tdd-e2e/README.md` | 安装/信任模型/判定表/生命周期/样例/已知边界 |
| `test/extensions/tdd-e2e-{schema,fingerprint,gate,lint,archive,install}.test.ts` | 本扩展测试矩阵 |
| dogfood：`package.json`（`test:e2e`）、`.github/workflows/ci.yml`（gate 接线+docs-only）、`docs-lab/`（用法页+glossary 词条） | 本仓试点 |

---

### Task 1: `tdd-driven` schema 与模板

**Files:**
- Create: `extensions/tdd-e2e/schema/schema.yaml`
- Create: `extensions/tdd-e2e/schema/templates/tests.md`、`extensions/tdd-e2e/schema/templates/evidence.md`
- Copy: `extensions/tdd-e2e/schema/templates/{proposal,spec,design,tasks}.md` ← `schemas/spec-driven/templates/`（未改动工件的模板随 fork 原样携带）
- Test: `test/extensions/tdd-e2e-schema.test.ts`

**Interfaces:**
- Consumes: `src/core/artifact-graph/schema.ts` 的 schema 解析器（`parseSchema`，既有导出，以测试内实际导入为准）
- Produces: `schema.yaml` 的工件 id 集 `{proposal, specs, tests, design, tasks, evidence}`；`apply.requires = [tasks, tests]`；`tests` 生成 `tests/**/*.md`（requires `[specs]`）；`evidence` 生成 `evidence.md`（requires `[tasks]`，含"勿提前创建"权威条款）

- [ ] **Step 1: 写失败测试**（schema 解析 + requires 边 + tracks + parity）

```ts
// test/extensions/tdd-e2e-schema.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadSchema } from '../../src/core/artifact-graph/schema';

const SCHEMA_DIR = path.resolve(__dirname, '../../extensions/tdd-e2e/schema');
const SPEC_DRIVEN = path.resolve(__dirname, '../../schemas/spec-driven');

describe('tdd-driven schema', () => {
  it('parses with exact requires edges', () => {
    const schema = loadSchema(path.join(SCHEMA_DIR, 'schema.yaml'));
    const ids = schema.artifacts.map((a) => a.id);
    expect(ids).toEqual(['proposal', 'specs', 'tests', 'design', 'tasks', 'evidence']);
    const byId = Object.fromEntries(schema.artifacts.map((a) => [a.id, a]));
    expect(byId.specs.requires).toEqual(['proposal']);
    expect(byId.tests.requires).toEqual(['specs']);
    expect(byId.design.requires).toEqual(['proposal']);
    expect(byId.tasks.requires).toEqual(['specs', 'design', 'tests']);
    expect(byId.evidence.requires).toEqual(['tasks']);
    expect(schema.apply.requires).toEqual(['tasks', 'tests']);
    expect(schema.apply.tracks).toBe('tasks.md');
  });
  it('evidence instruction carries the no-early-creation clause', () => {
    const schema = loadSchema(path.join(SCHEMA_DIR, 'schema.yaml'));
    const evidence = schema.artifacts.find((a) => a.id === 'evidence')!;
    expect(evidence.instruction).toContain('仅当实现完成后创建');
    expect(evidence.instruction).toContain('本 instruction 优先');
  });
  it('fork parity: unchanged instructions byte-identical to spec-driven', () => {
    for (const f of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
      const forked = readFileSync(path.join(SCHEMA_DIR, 'templates', f), 'utf8');
      const base = readFileSync(path.join(SPEC_DRIVEN, 'templates', f), 'utf8');
      expect(forked).toBe(base);
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**
  Run: `corepack pnpm exec vitest run test/extensions/tdd-e2e-schema.test.ts`
  Expected: FAIL（文件不存在/解析失败）

- [ ] **Step 3: 实现 schema**
  - `schema.yaml`：以 `schemas/spec-driven/schema.yaml` 全文为底，插入 `tests` 工件（位于 `specs` 之后，requires `[specs]`；instruction 含：场景→用例映射、结构化表格、红绿台账三态语义、"一场景一条目多用例"、superpowers 组合条款"内联为锚，冲突以内联为准"）与 `evidence` 工件（requires `[tasks]`；instruction 首段为 retro 式"仅当实现完成后创建……本 instruction 优先——推迟"权威条款，正文含台账回填/摘要/失败清单/制品清单/豁免标记）；`tasks` instruction 追加"先写失败测试（红-绿-重构）"条款；`apply` 改 `requires: [tasks, tests]` 并追加收尾序列与 ARCHIVE_HANDOFF 混合信号条款（"收尾序列完成前不得进入归档叙事"）；工件链文案用精确 DAG（`proposal→specs→tests、proposal→design、（specs,design,tests）→tasks→evidence`）。
  - `templates/tests.md`：标题 + 使用说明 + 表格列 `| 能力 | 需求 | 场景 | 用例 | 测试路径 | 状态 |`（状态 ∈ 计划/红/绿；"红 = 已写且失败"，无红不记绿）。
  - `templates/evidence.md`：五节模板（台账回填 / e2e 摘要 / 失败清单 / 制品清单 / 豁免标记）。
  - `templates/{proposal,spec,design,tasks}.md`：从 `schemas/spec-driven/templates/` 原样复制（parity 测试钉住）。

- [ ] **Step 4: 跑测试确认通过**
  Run: `corepack pnpm exec vitest run test/extensions/tdd-e2e-schema.test.ts`
  Expected: PASS

- [ ] **Step 5: 提交**
  `git add extensions/tdd-e2e/schema test/extensions/tdd-e2e-schema.test.ts && git commit -m "feat(ext): tdd-driven schema with tests/evidence artifacts"`

---

### Task 2: 指纹库 `lib/fingerprint.mjs`

**Files:**
- Create: `extensions/tdd-e2e/scripts/lib/fingerprint.mjs`
- Test: `test/extensions/tdd-e2e-fingerprint.test.ts`

**Interfaces:**
- Consumes: node 内置 `child_process`（`git ls-files`）、`crypto`、`fs`
- Produces（后续 Task 3/4/5 依赖，签名固定）：
  - `computeInputKeyV1({ projectRoot, planningRoot, include = [] })` → `Promise<{ version: 1, hash: string, fileCount: number, warnings: string[] }>`
  - `normalizeEol(buf: Buffer, filePath: string): Buffer`（文本 CRLF→LF；字节敏感/二进制原样）
  - 常量 `EXCLUDED_GENERATED = ['evidence/', 'deliverables/', '.staging/']`（change 内精确生成路径）与 `EXCLUDED_PLANNING = ['openspec/changes/', 'openspec/specs/', 'openspec/experience/']`

- [ ] **Step 1: 写失败测试**

```ts
// test/extensions/tdd-e2e-fingerprint.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { computeInputKeyV1 } from '../../extensions/tdd-e2e/scripts/lib/fingerprint.mjs';

let root: string;
function git(args: string) { execSync(`git ${args}`, { cwd: root }); }

beforeAll(() => {
  root = path.join('/tmp', `fp-test-${Date.now()}`);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'openspec/changes/c1/evidence'), { recursive: true });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'openspec/changes/c1/tasks.md'), '- [x] 1.1\n');
  writeFileSync(path.join(root, 'openspec/changes/c1/evidence/old.json'), '{"stale":true}');
  git('init -q'); git('add -A'); git('-c user.email=t@t -c user.name=t commit -qm init');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('stable across CRLF rewrite of tracked text file (EOL 归一化)', async () => {
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\r\n');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).toBe(before.hash);
});
it('excludes generated evidence/ and planning dirs (写证据不弄脏指纹)', async () => {
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'openspec/changes/c1/evidence/new.json'), 'x');
  writeFileSync(path.join(root, 'openspec/changes/c1/tasks.md'), '- [x] 1.1\n- [x] 1.2\n');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).toBe(before.hash);
});
it('detects uncommitted src change (glm P0-1)', async () => {
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).not.toBe(before.hash);
});
it('includes openspec/tdd-e2e (runner 自身入指纹)', async () => {
  mkdirSync(path.join(root, 'openspec/tdd-e2e'), { recursive: true });
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'openspec/tdd-e2e/e2e-lint.mjs'), '// v1');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).not.toBe(before.hash);
});
```

- [ ] **Step 2: 跑测试确认失败**
  Run: `corepack pnpm exec vitest run test/extensions/tdd-e2e-fingerprint.test.ts` → FAIL（模块不存在）

- [ ] **Step 3: 实现**
  ESM 零依赖。遍历 `git ls-files -z`（tracked）∪ `include`（显式未跟踪，存在才计）；按 `EXCLUDED_GENERATED`（相对 change 目录的精确路径）与 `EXCLUDED_PLANNING` 前缀排除；symlink（`lstat` isSymbolicLink）默认 `warnings.push` 并**拒绝**（不计入 hash，lint 层会告警）；每文件 `normalizeEol` 后 sha256；tree-hash = sha256(sorted `relPath\0fileHash` 拼接)；返回 `{version:1, hash, fileCount, warnings}`。文本判定：首 8KB 无 NUL 且扩展名不在二进制清单（.png/.jpg/.zip/.woff/.pdf 等）。

- [ ] **Step 4: 跑测试确认通过** → `corepack pnpm exec vitest run test/extensions/tdd-e2e-fingerprint.test.ts` PASS

- [ ] **Step 5: 提交** `git add extensions/tdd-e2e/scripts/lib/fingerprint.mjs test/extensions/tdd-e2e-fingerprint.test.ts && git commit -m "feat(ext): input key v1 fingerprint with EOL normalization"`

---

### Task 3: 配置发现与 `e2e-gate.mjs` 运行协议

**Files:**
- Create: `extensions/tdd-e2e/scripts/lib/config.mjs`
- Create: `extensions/tdd-e2e/scripts/e2e-gate.mjs`
- Test: `test/extensions/tdd-e2e-gate.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `computeInputKeyV1`
- Produces:
  - `loadProjectConfig(projectRoot)` → `{ command, enforce, allowlist, include, collect, produces, skipApproved }`（缺省全 null/false；读 `tdd-e2e.config.json`）
  - `discoverCommand({ projectRoot, changeMetadata })` → `{ command: string|null, source: 'config'|'package-json'|'change-metadata'|null }`（只读**项目级受信源**；change 级 x- 键仅返回提示并标 `source:'change-metadata'`）
  - `parseChangeMetadata(changeDir)` → `{ values: Record<string,string|boolean>, typos: string[] }`（扁平点号键 + 近似键诊断）
  - gate CLI：`node e2e-gate.mjs --change <name> [--project <root>] [--finalize] [--rerun] [--authority ci|local|pre-commit] [--json]`；退出码 = 测试退出码（超时=124 红）

- [ ] **Step 1: 写失败测试**（用 `node -e` 当假 e2e 命令，临时目录当项目）

```ts
// test/extensions/tdd-e2e-gate.test.ts（节选核心用例，全量按此风格补齐）
it('fail-closed: 命令链全空且无豁免 → exit 1 且 JSON 报 no-command', async () => {
  // 临时项目无 tdd-e2e.config.json、无 package.json test:e2e、change 无 x-tdd-e2e.command
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('no-command');
});
it('timeout = red (exit 124)', async () => {
  // config command: "node -e 'setTimeout(()=>{},60000)'"，gate --timeout 1000
  const r = await runGate(['--change', 'c1', '--project', proj, '--timeout', '1000']);
  expect(r.code).toBe(124);
});
it('authority 仅记录：改 --authority 不改变同一次运行的判定 (gpt P2-2)', async () => {
  const a = await runGate(['--change', 'c1', '--project', proj, '--authority', 'local']);
  const b = await runGate(['--change', 'c1', '--project', proj, '--authority', 'ci']);
  expect(a.code).toBe(b.code); // 都 exit 0（绿命令）
  expect(JSON.parse(b.stdout).authority).toBe('ci'); // 仅记录字段不同
});
it('command 优先级：config > package.json test:e2e > change 级 x- 键（仅提示）', async () => { /* 三级分别断言 source 字段 */ });
it('produces 声明但缺应交制品 → 失败', async () => { /* config produces: ["dist/app.js"]，命令不产 → exit 1 */ });
```

- [ ] **Step 2: 跑测试确认失败** → `corepack pnpm exec vitest run test/extensions/tdd-e2e-gate.test.ts` FAIL

- [ ] **Step 3: 实现 `config.mjs` 与 `e2e-gate.mjs`**
  - 运行协议顺序（设计 §6.3）：发现命令（空→`no-command` fail-closed）→ 前指纹 `computeInputKeyV1` → `child_process.spawn`（shell 命令、超时 kill 进程组→124）→ 后指纹（不一致→`stale-inputs` 作废）→ 写 `evidence/.staging/<run-id>/e2e-result.json`（字段：runId、exitCode、summary、前后 hash、authority（仅记录）、commandSource、timestamp、timeoutMs）→ 绿则按 `collect` 生成制品清单（文件名+sha256+大小）→ `--json` 输出。
  - `--rerun` 与默认同协议（authority 默认按 `env.CI` 判 ci/local，可 `--authority` 覆盖）。
  - `--finalize` 属 Task 4，本任务留 CLI 分支占位（`--finalize` 报 `not-implemented`），避免跨任务。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `git commit -m "feat(ext): e2e-gate run protocol with fail-closed command discovery"`

---

### Task 4: `--finalize` 幂等收尾与 bundle 发布

**Files:**
- Create: `extensions/tdd-e2e/scripts/lib/bundle.mjs`
- Modify: `extensions/tdd-e2e/scripts/e2e-gate.mjs`（接入 `--finalize`）
- Test: `test/extensions/tdd-e2e-gate.test.ts`（追加 `--finalize` 组）

**Interfaces:**
- Consumes: Task 3 的 gate 运行协议、Task 2 的 `computeInputKeyV1`
- Produces（Task 5/6 依赖）:
  - `createRunId()` → `string`（时间戳+随机）
  - `stageDir(projectRoot, runId)` → `evidence/.staging/<runId>/`
  - `publishBundle({ stagingDir, bundleDir })` → 原子 rename 落地 `evidence/runs/<runId>/`
  - `verifyBundle(bundleDir, inputKeyHash)` → `{ complete, success, manifestOk, reusable }`（复用条件：同键＋完整＋成功＋清单校验通过）
  - `acquireRunLock(changeDir)` / `releaseRunLock(changeDir)`（fs lock 文件，EEXIST 即忙）

- [ ] **Step 1: 写失败测试**（幂等四用例 + 恢复三用例）

```ts
it('同键重复 finalize 复用既有 bundle，不产生新 run', async () => {
  const r1 = await runGate(['--change','c1','--project',proj,'--finalize','--json']);
  const r2 = await runGate(['--change','c1','--project',proj,'--finalize','--json']);
  expect(JSON.parse(r1.stdout).runId).toBe(JSON.parse(r2.stdout).runId);
});
it('输入变化后重跑 → 新 run（键变）', async () => { /* 改 src 后 finalize，runId 变 */ });
it('同键损坏 bundle 不复用 → 重建', async () => { /* 删 bundle 内 e2e-result.json 后 finalize，reusable=false 路径 */ });
it('红灯 bundle 不复用（exit≠0）', async () => { /* 命令 exit 1，finalize 后 reusable=false */ });
it('发布前中断不留半态：staging 残留被清理，再次 finalize 成功', async () => { /* 预置脏 staging 目录 */ });
it('仅元数据变化（键含元数据）→ 新 run', async () => { /* 改 .openspec.yaml 元数据字段 */ });
it('绿检查后移动 bundle 任一文件 → 旧检查不可放行（与 Task 5 联动断言键失配）', async () => { /* 留 Task 5 断言侧，本处断言键含 bundle 路径外输入 */ });
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**
  `bundle.mjs` 按签名实现；`--finalize` 流程 = 运行协议 → staging → `verifyBundle` 复用判定（reusable 则直接返回既有 runId，不重跑不重发）→ `publishBundle`（rename，跨设备回退 copy+unlink，失败清理）→ 生成 `evidence.md` 人读投影（引用 runId，五节从模板填充）→ run lock 全程持锁、finally 释放。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `git commit -m "feat(ext): finalize idempotency with bundle reuse conditions"`

---

### Task 5: `e2e-lint.mjs --gate` 权威判定

**Files:**
- Create: `extensions/tdd-e2e/scripts/e2e-lint.mjs`
- Test: `test/extensions/tdd-e2e-lint.test.ts`

**Interfaces:**
- Consumes: Task 2/3/4 全部导出
- Produces: CLI `node e2e-lint.mjs --gate [--change <name>] [--project <root>] [--json]`；退出码 0 ∈ {PASS, EXEMPT, NOT_APPLICABLE}，1 = FAIL；stdout JSON：`{ aggregate, projectRun, changes: [{ name, status, reason }] }`（三态分离）

- [ ] **Step 1: 写失败测试**（判定表真值表 + P0 用例）

```ts
it('元数据无效/缺失且 enforce=tdd-driven-only → FAIL（schema 绕行防御）', async () => {
  const r = await runLint(['--gate','--change','c1','--project',proj,'--json']);
  expect(JSON.parse(r.stdout).aggregate).toBe('FAIL');
});
it('docs-only：diff⊂文档路径 → 项目级记 SKIP-EXEC（非 PASS），无在范围 change → NOT_APPLICABLE', async () => { /* 用 git diff 模拟文档-only 提交 */ });
it('code-only（无 change 目录变动）：必须重跑，重跑绿才 PASS', async () => { /* 断言 projectRun.status === 'PASS' 且真实执行过（调用计数） */ });
it('0-task change 同样受限（蕴含式）', async () => { /* 纯 bullet tasks.md 仍要求绿证据 */ });
it('EXEMPT 需受信授权记录：glob 不授权、快照变化授权失效', async () => { /* allowlist 命中但受审快照 hash 不符 → FAIL */ });
it('台账对账：未知场景引用 FAIL、场景重名 FAIL、映射缺失 FAIL', async () => { /* 三个子用例 */ });
it('快照绑定：finalize 后改 src → --gate 判 FAIL（stale-inputs）', async () => { /* 联动 Task 4 的"绿检查后改 bundle" */ });
it('聚合取最差项：一 change FAIL → aggregate FAIL', async () => { /* 双 change */ });
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现**
  判定顺序按设计 §6.3 判定表：①有效 schema 解析（元数据无效=FAIL）→ ②受检集合（diff 涉及 change 决策：新增/迁移/删除/空集合）→ ③EXEMPT 授权校验（受信授权记录：身份+受审快照 hash+范围，glob 只筛）→ ④项目级重跑判定（docs-only SKIP-EXEC 免重跑但非 PASS；code-only 必跑）→ ⑤逐 change 快照绑定（重算输入键 v1 与 bundle 记录比对）→ ⑥台账对账（specs delta 的 requirement 下 h4 子标题为场景全集，台账表格行必须逐场景覆盖、拒未知/重名）→ ⑦发布契约（produces 齐全、清单校验）→ 聚合取最差项。全部分支输出三态之一，未执行永不记 PASS。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `git commit -m "feat(ext): e2e-lint --gate authoritative judgment with decision table"`

---

### Task 6: `--archive-gate --execute` 受管归档

**Files:**
- Modify: `extensions/tdd-e2e/scripts/e2e-lint.mjs`（加子命令）
- Test: `test/extensions/tdd-e2e-archive.test.ts`

**Interfaces:**
- Consumes: Task 5 判定、Task 4 bundle 校验
- Produces: `node e2e-lint.mjs --archive-gate --change <name> --execute [--project <root>]`；行为 = 复用 `--gate` 对单 change 判定 → 快照复验 → sync 完整性校验 → **执行移动**（目标预检/no-clobber/日期前缀 `YYYY-MM-DD-<name>`/复验-移动文件锁/失败回退）；退出码 0 = 归档完成

- [ ] **Step 1: 写失败测试**

```ts
it('判定绿 → 执行移动，目录落到 archive/YYYY-MM-DD-<name>', async () => { /* 断言 mv 结果与命名 */ });
it('目标已存在 → no-clobber 拒绝，源目录原样保留', async () => { /* 预置同名归档 */ });
it('移动失败（目标只读）→ 回退不留半态，源目录完整', async () => { /* chmod 目标父目录只读 */ });
it('sync 未完成（delta 未合入主 spec）→ 报错中止不移动', async () => { /* 构造未同步状态 */ });
it('判定红 → 不移动', async () => { /* exit 1 且目录未动 */ });
```

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现** 按 Global Constraints 的 `--execute` 语义：先 `verifyBundle`+快照复验，再目标预检，持 run lock 执行 rename（同文件系统），失败回退（保留日期前缀语义对齐 `src/core/archive.ts` 先例：目标已有日期前缀不重复加），finally 释放锁。

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `git commit -m "feat(ext): managed archive gate with no-clobber move"`

---

### Task 7: `install.mjs`、README 与文档

**Files:**
- Create: `extensions/tdd-e2e/scripts/install.mjs`、`extensions/tdd-e2e/README.md`
- Create: `docs-lab/customize/tdd-e2e.md`（或并入现有 customize 结构，以仓库文档组织为准）
- Modify: `docs-lab/reference/glossary.md`（evidence/deliverables 词条）
- Test: `test/extensions/tdd-e2e-install.test.ts`

**Interfaces:**
- Consumes: Task 1 的 schema 目录、Task 3-6 的脚本
- Produces: `node install.mjs --project <root>` → 复制 `schema/` → `openspec/schemas/tdd-driven/`、`scripts/` → `openspec/tdd-e2e/`、打印 config.yaml 建议片段（`operations.*.guidance` 带 `guidance:` 层与"（仅 tdd-driven change 适用）"限定语）；不自动改 config

- [ ] **Step 1: 写失败测试**：安装到临时项目 → 断言落位文件齐、片段含 `guidance:` 与限定语、二次运行幂等、源目录缺失时报错明确。

- [ ] **Step 2: 跑测试确认失败** → FAIL

- [ ] **Step 3: 实现 install.mjs + README（安装/命令发现与信任模型/判定表/生命周期四事件/EXEMPT 协议/skip 协议/CI 样例单入口 `--gate`/已知边界 L1-L3/术语表/skill id 验证方法）+ docs-lab 页 + glossary 词条。**

- [ ] **Step 4: 跑测试确认通过** → PASS

- [ ] **Step 5: 提交** `git commit -m "feat(ext): installer, README, and docs for tdd-e2e"`

---

### Task 8: 本仓 dogfood 接线与全量验证

**Files:**
- Modify: `package.json`（加 `"test:e2e": "vitest run test/cli-e2e"`）
- Modify: `.github/workflows/ci.yml`（新增 tdd-e2e 门禁步骤：install → `openspec/tdd-e2e/e2e-lint.mjs --gate`；入 required checks 聚合；docs-only 路径过滤——只免重跑不免判定）
- Test: 无新测试文件；验证 = 全量测试 + CI 本地等价命令

**Interfaces:**
- Consumes: Task 1-7 全部产物

- [ ] **Step 1: 加 `test:e2e` script 并跑通** `corepack pnpm test:e2e` → PASS（基线：test/cli-e2e 全绿）

- [ ] **Step 2: CI 接线**：ci.yml 按设计 §7 接 `--gate` 单入口（步骤顺序：checkout → setup → `node extensions/tdd-e2e/scripts/install.mjs --project .` → `node openspec/tdd-e2e/e2e-lint.mjs --gate --json`），docs-only 过滤只影响重跑层。

- [ ] **Step 3: 试点 change 冒烟**：`corepack pnpm exec openspec new change pilot-tdd --schema tdd-driven`（或等价 CLI 调用）走一遍 propose→tests→tasks→apply（假命令）→ `--finalize` → `--archive-gate --execute`，记录输出。

- [ ] **Step 4: 全量验证**
  Run: `corepack pnpm exec vitest run` → 0 failures（全仓库回归）
  Run: `corepack pnpm exec vitest run test/extensions/` → 0 failures
  Run: `corepack pnpm exec tsc --noEmit -p tsconfig.json`（若仓库有类型检查脚本，以其为准）

- [ ] **Step 5: 提交** `git commit -m "feat: dogfood tdd-e2e gate in CI with test:e2e script"`

---

## 执行交接

计划已存 `docs/superpowers/plans/2026-11-26-tdd-e2e-extension.md`。执行方法待定（subagent-driven / native），见会话内选择。
