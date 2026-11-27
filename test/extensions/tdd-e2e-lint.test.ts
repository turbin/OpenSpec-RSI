// test/extensions/tdd-e2e-lint.test.ts
// e2e-lint --gate 权威判定（Task 5）：判定表真值表全分支 + brief 8 条 P0 用例。
// 判定顺序：①有效 schema（元数据无效=FAIL）→②受检集合（diff 身份决策）→③EXEMPT 授权
// →④项目级重跑（docs-only SKIP-EXEC / code-only 必跑）→⑤快照绑定→⑥台账对账→⑦发布契约
// →聚合取最差项；退出码 0 ∈ {PASS, EXEMPT, NOT_APPLICABLE}，1 = FAIL。
import { it, expect, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { computePlanningHash } from '../../extensions/tdd-e2e/scripts/lib/bundle.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const lintScript = path.join(repoRoot, 'extensions', 'tdd-e2e', 'scripts', 'e2e-lint.mjs');
const gateScript = path.join(repoRoot, 'extensions', 'tdd-e2e', 'scripts', 'e2e-gate.mjs');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function git(root: string, args: string): void {
  execSync(`git ${args}`, { cwd: root, stdio: 'pipe' });
}
function headSha(root: string): string {
  return execSync('git rev-parse HEAD', { cwd: root, encoding: 'utf8' }).trim();
}
function write(root: string, rel: string, content: string): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}
function commitAll(root: string, msg: string): void {
  git(root, 'add -A');
  git(root, `-c user.email=t@t -c user.name=t commit -qm "${msg}"`);
}

interface ProjectOpts {
  config?: unknown; // 对象则 JSON 序列化；字符串则原样写入
  pkg?: unknown;
  files?: Record<string, string>;
}

function makeProject(opts: ProjectOpts = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-lint-'));
  tempDirs.push(root);
  write(root, 'src/a.ts', 'export const a = 1;\n');
  write(root, 'README.md', '# demo\n');
  if (opts.config !== undefined) {
    write(root, 'tdd-e2e.config.json', typeof opts.config === 'string' ? opts.config : JSON.stringify(opts.config));
  }
  if (opts.pkg !== undefined) {
    write(root, 'package.json', typeof opts.pkg === 'string' ? opts.pkg : JSON.stringify(opts.pkg));
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) write(root, rel, content);
  git(root, 'init -q -b main');
  commitAll(root, 'init');
  return root;
}

const GREEN_CMD = 'node -e "process.exit(0)"';
const COUNTER_CMD = `node -e "require('fs').appendFileSync('ran.log','x')"`;

const SPEC_DELTA = [
  '## ADDED Requirements',
  '',
  '### Requirement: Echo behavior',
  'Users SHALL echo input.',
  '',
  '#### Scenario: Basic echo',
  '- **WHEN** input is given',
  '- **THEN** it is echoed',
  '',
  '#### Scenario: Empty input',
  '- **WHEN** input is empty',
  '- **THEN** nothing is echoed',
  '',
].join('\n');

// 场景重名：同一 requirement 下两个同名 h4 子标题（不限字面 Scenario:，任意 h4 都算场景）
const SPEC_DUPLICATE = [
  '## ADDED Requirements',
  '',
  '### Requirement: Echo behavior',
  'Users SHALL echo input.',
  '',
  '#### Scenario: Basic echo',
  '- **WHEN** input is given',
  '- **THEN** it is echoed',
  '',
  '#### Scenario: Basic echo',
  '- **WHEN** input is given twice',
  '- **THEN** it is echoed twice',
  '',
].join('\n');

// 零场景：requirement 下没有 h4 子标题
const SPEC_ZERO_SCENARIO = [
  '## ADDED Requirements',
  '',
  '### Requirement: Echo behavior',
  'Users SHALL echo input.',
  '',
].join('\n');

const LEDGER_HEADER = [
  '# Tests',
  '',
  '| 能力 | 需求 | 场景 | 用例 | 测试路径 | 状态 |',
  '| ---- | ---- | ---- | ---- | -------- | ---- |',
].join('\n');

const LEDGER_GREEN = [
  LEDGER_HEADER,
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Basic echo` | happy | `tests/echo.test.ts#basic` | 绿 |',
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Empty input` | edge | `tests/echo.test.ts#empty` | 绿 |',
  '',
].join('\n');

const LEDGER_UNKNOWN_ROW = [
  LEDGER_HEADER,
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Basic echo` | happy | `tests/echo.test.ts#basic` | 绿 |',
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Empty input` | edge | `tests/echo.test.ts#empty` | 绿 |',
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / No such` | ghost | `tests/echo.test.ts#ghost` | 绿 |',
  '',
].join('\n');

// 映射缺失：只覆盖 Basic echo，Empty input 无台账条目
const LEDGER_PARTIAL = [
  LEDGER_HEADER,
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Basic echo` | happy | `tests/echo.test.ts#basic` | 绿 |',
  '',
].join('\n');

// 台账未全绿：一绿一计划（台账全绿 ⇔ evidence 绿）
const LEDGER_NOT_GREEN = [
  LEDGER_HEADER,
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Basic echo` | happy | `tests/echo.test.ts#basic` | 绿 |',
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Empty input` | edge | `tests/echo.test.ts#empty` | 计划 |',
  '',
].join('\n');

const SKIP_META = 'schema: tdd-driven\nx-tdd-e2e.skip: true\nx-tdd-e2e.skip_reason: upstream flake\n';

interface ChangeOpts {
  meta?: string | null;
  spec?: string | null;
  ledger?: string | null;
  tasks?: string | null;
}

function addChange(root: string, name: string, opts: ChangeOpts = {}): void {
  const base = `openspec/changes/${name}`;
  if (opts.meta !== null) write(root, `${base}/.openspec.yaml`, opts.meta ?? 'schema: tdd-driven\n');
  if (opts.spec !== null) write(root, `${base}/specs/cap/spec.md`, opts.spec ?? SPEC_DELTA);
  if (opts.ledger !== null) write(root, `${base}/tests/ledger.md`, opts.ledger ?? LEDGER_GREEN);
  if (opts.tasks !== null) write(root, `${base}/tasks.md`, opts.tasks ?? '- [x] 1.1 tests written\n');
}

function finalize(root: string, change = 'c1'): { code: number | null; stdout: string } {
  const r = spawnSync(process.execPath, [gateScript, '--change', change, '--project', root, '--finalize', '--json'], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '' },
  });
  return { code: r.status, stdout: r.stdout ?? '' };
}

interface LintRun {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

function runLint(args: string[], env: Record<string, string> = {}): LintRun {
  const argv = args.includes('--json') ? args : [...args, '--json'];
  const r = spawnSync(process.execPath, [lintScript, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '', ...env },
  });
  const stdout = r.stdout ?? '';
  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* 非 JSON 输出时保持 null，由断言报错 */
  }
  return { code: r.status, stdout, stderr: r.stderr ?? '', json };
}

// ---------- ① 有效 schema 解析（元数据无效 = FAIL 独立错误路径） ----------

it('元数据无效/缺失且 enforce=tdd-driven-only → FAIL（schema 绕行防御）', async () => {
  // (a) .openspec.yaml 缺失
  const p1 = makeProject({ config: { command: GREEN_CMD, enforce: 'tdd-driven-only' } });
  addChange(p1, 'c1', { meta: null });
  commitAll(p1, 'add c1');
  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', 'HEAD~1']);
  expect(r1.code).toBe(1);
  expect(r1.json.aggregate).toBe('FAIL');
  expect(r1.json.changes[0].reason).toContain('schema-bypass');

  // (b) schema 键缺失（元数据在、有效 schema 不可判）
  const p2 = makeProject({ config: { command: GREEN_CMD, enforce: 'tdd-driven-only' } });
  addChange(p2, 'c1', { meta: 'created: 2026-11-27\n' });
  commitAll(p2, 'add c1');
  const r2 = runLint(['--gate', '--change', 'c1', '--project', p2, '--base', 'HEAD~1']);
  expect(r2.json.aggregate).toBe('FAIL');
  expect(r2.json.changes[0].reason).toContain('schema-bypass');

  // (c) 元数据无效（schema 空值）——独立错误路径，无 enforce 也 FAIL
  const p3 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p3, 'c1', { meta: "schema: ''\n" });
  commitAll(p3, 'add c1');
  const r3 = runLint(['--gate', '--change', 'c1', '--project', p3, '--base', 'HEAD~1']);
  expect(r3.code).toBe(1);
  expect(r3.json.aggregate).toBe('FAIL');
  expect(r3.json.changes[0].reason).toContain('invalid-metadata');

  // (d) .openspec.yaml 不可读为文件（目录占位）→ 解析失败 = 无效
  const p4 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p4, 'c1');
  fs.rmSync(path.join(p4, 'openspec', 'changes', 'c1', '.openspec.yaml'));
  fs.mkdirSync(path.join(p4, 'openspec', 'changes', 'c1', '.openspec.yaml'));
  commitAll(p4, 'add c1');
  const r4 = runLint(['--gate', '--change', 'c1', '--project', p4, '--base', 'HEAD~1']);
  expect(r4.json.aggregate).toBe('FAIL');
  expect(r4.json.changes[0].reason).toContain('invalid-metadata');
});

it('enforce 取值非法 → fail-closed invalid-config', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD, enforce: 'everything' } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.error).toBe('invalid-config');
  expect(r.json.aggregate).toBe('FAIL');
});

it('有效 schema 解析顺序：显式覆盖 > change 元数据 > 项目默认 > spec-driven', async () => {
  // 元数据 schema: spec-driven + 无 enforce → 执法范围外 NOT_APPLICABLE；
  // --schema tdd-driven（受信输入显式覆盖）→ 收进执法范围（无绿证据 → FAIL）
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1', { meta: 'schema: spec-driven\n', spec: null, ledger: null });
  commitAll(proj, 'add c1');
  const base = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(base.json.changes[0].status).toBe('NOT_APPLICABLE');
  expect(base.json.changes[0].reason).toContain('out-of-scope');

  const over = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1', '--schema', 'tdd-driven']);
  expect(over.code).toBe(1);
  expect(over.json.changes[0].status).toBe('FAIL'); // 0-task/无证据同样受限
});

it('enforce: all-changes = 全员收测试门禁，但不强求无 tests 工件的 schema 补台账', async () => {
  // (a) spec-driven（无 tests 工件）：不欠台账（无 delta 不 FAIL），但必须有绿证据
  const p1 = makeProject({ config: { command: GREEN_CMD, enforce: 'all-changes' } });
  addChange(p1, 'c1', { meta: 'schema: spec-driven\n', spec: null, ledger: null });
  commitAll(p1, 'add c1');
  expect(finalize(p1, 'c1').code).toBe(0);
  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', 'HEAD~1']);
  expect(r1.code).toBe(0);
  expect(r1.json.changes[0].status).toBe('PASS'); // 不因无台账 FAIL

  // (b) 无绿证据 → FAIL（全员收测试门禁，不是只管 tdd-driven）
  const p2 = makeProject({ config: { command: GREEN_CMD, enforce: 'all-changes' } });
  addChange(p2, 'c2', { meta: 'schema: spec-driven\n', spec: null, ledger: null });
  commitAll(p2, 'add c2');
  const r2 = runLint(['--gate', '--change', 'c2', '--project', p2, '--base', 'HEAD~1']);
  expect(r2.code).toBe(1);
  expect(r2.json.changes[0].reason).toContain('no-evidence');

  // (c) tdd-driven（有 tests 工件）仍欠台账：零场景且无 skip_specs → FAIL
  const p3 = makeProject({ config: { command: GREEN_CMD, enforce: 'all-changes' } });
  addChange(p3, 'c3', { spec: SPEC_ZERO_SCENARIO, ledger: null });
  commitAll(p3, 'add c3');
  expect(finalize(p3, 'c3').code).toBe(0);
  const r3 = runLint(['--gate', '--change', 'c3', '--project', p3, '--base', 'HEAD~1']);
  expect(r3.code).toBe(1);
  expect(r3.json.changes[0].reason).toContain('no-scenarios');
});

it('元数据编辑规则：修改既有 change 的 schema/豁免字段须授权记录，未授权 = FAIL', async () => {
  // (a) 既有 change 把 schema: tdd-driven 改成 spec-driven（脱管企图）→ 未授权 FAIL
  const p1 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p1, 'c1');
  commitAll(p1, 'add c1');
  const base1 = headSha(p1);
  write(p1, 'openspec/changes/c1/.openspec.yaml', 'schema: spec-driven\n');
  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', base1]);
  expect(r1.code).toBe(1);
  expect(r1.json.changes[0].reason).toContain('unauthorized-metadata-edit');

  // (b) 新授权记录（受审快照 = 当前规划面）→ 编辑获准
  const p2 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p2, 'c1', { meta: 'schema: tdd-driven\nx-tdd-e2e.skip_reason: old reason\n' });
  commitAll(p2, 'add c1');
  const base2 = headSha(p2);
  write(p2, 'openspec/changes/c1/.openspec.yaml', 'schema: tdd-driven\nx-tdd-e2e.skip_reason: new reason\n');
  const snapshot = computePlanningHash(path.join(p2, 'openspec', 'changes', 'c1'));
  write(p2, 'tdd-e2e.config.json', JSON.stringify({
    command: GREEN_CMD,
    allowlist: [JSON.stringify({ change: 'c1', snapshot, scope: ['openspec/changes/c1/**'], approver: 'alice' })],
  }));
  expect(finalize(p2, 'c1').code).toBe(0); // 编辑后重新收尾（键含元数据）
  const r2 = runLint(['--gate', '--change', 'c1', '--project', p2, '--base', base2]);
  expect(r2.json.changes[0].reason).not.toContain('unauthorized-metadata-edit');
  expect(r2.json.changes[0].status).toBe('PASS');
});

// ---------- 真值表：项目级 e2e 重跑决策 ----------

it('docs-only：diff⊂文档路径 → 项目级记 SKIP-EXEC（非 PASS），无在范围 change → NOT_APPLICABLE', async () => {
  const proj = makeProject({ config: { command: COUNTER_CMD } });
  write(proj, 'docs/guide.md', '# guide\n');
  commitAll(proj, 'docs only');
  const r = runLint(['--gate', '--project', proj]); // 缺省 --base：无 origin/main → HEAD~1 + warning
  expect(r.code).toBe(0);
  const j = r.json;
  expect(j.aggregate).toBe('NOT_APPLICABLE');
  expect(j.projectRun.status).toBe('SKIP-EXEC');
  expect(j.changes).toEqual([]);
  expect(j.warnings.join('\n')).toContain('HEAD~1');
  expect(fs.existsSync(path.join(proj, 'ran.log'))).toBe(false); // 免重跑（非 PASS）
});

it('docs-only 路径过滤 fail-closed：仅顶层文档目录白名单扩展名免重跑（宁可多跑不可漏跑）', async () => {
  // ① src/docs/generator.ts 单独变更 → 非 docs-only（深层 docs 目录永不算）→ 强制重跑
  const p1 = makeProject({ config: { command: COUNTER_CMD } });
  write(p1, 'src/docs/generator.ts', 'export const g = 1;\n');
  commitAll(p1, 'code under deep docs dir');
  const r1 = runLint(['--gate', '--project', p1, '--base', 'HEAD~1']);
  expect(r1.code).toBe(0);
  expect(r1.json.projectRun.status).toBe('PASS');
  expect(r1.json.aggregate).toBe('PASS');
  expect(fs.readFileSync(path.join(p1, 'ran.log'), 'utf8')).toBe('x'); // 真实重跑

  // ② 顶层 docs/foo.md 单独变更 → docs-only → SKIP-EXEC（非 PASS）
  const p2 = makeProject({ config: { command: COUNTER_CMD } });
  write(p2, 'docs/foo.md', '# foo\n');
  commitAll(p2, 'docs only');
  const r2 = runLint(['--gate', '--project', p2, '--base', 'HEAD~1']);
  expect(r2.code).toBe(0);
  expect(r2.json.projectRun.status).toBe('SKIP-EXEC');
  expect(r2.json.aggregate).toBe('NOT_APPLICABLE');
  expect(fs.existsSync(path.join(p2, 'ran.log'))).toBe(false);

  // ③ 顶层 docs/legacy.ts → 白名单外扩展名 → 非 docs-only → 强制重跑
  const p3 = makeProject({ config: { command: COUNTER_CMD } });
  write(p3, 'docs/legacy.ts', 'export const l = 1;\n');
  commitAll(p3, 'code in docs dir');
  const r3 = runLint(['--gate', '--project', p3, '--base', 'HEAD~1']);
  expect(r3.code).toBe(0);
  expect(r3.json.projectRun.status).toBe('PASS');
  expect(fs.readFileSync(path.join(p3, 'ran.log'), 'utf8')).toBe('x');
});

it('code-only（无 change 目录变动）：必须重跑，重跑绿才 PASS', async () => {
  const proj = makeProject({
    config: { command: COUNTER_CMD },
    files: { 'openspec/changes/old/.openspec.yaml': 'schema: tdd-driven\n' }, // 未触碰的 change 不入受检集合
  });
  write(proj, 'src/a.ts', 'export const a = 2;\n');
  commitAll(proj, 'touch src');
  const r = runLint(['--gate', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(0);
  const j = r.json;
  expect(j.projectRun.status).toBe('PASS');
  expect(j.aggregate).toBe('PASS');
  expect(j.changes).toEqual([]); // 空集合 → 无对账项
  expect(fs.readFileSync(path.join(proj, 'ran.log'), 'utf8')).toBe('x'); // 真实执行过（调用计数）

  // 重跑红 → FAIL（红灯永不记 PASS）
  const red = makeProject({ config: { command: 'node -e "process.exit(1)"' } });
  write(red, 'src/a.ts', 'export const a = 2;\n');
  commitAll(red, 'touch src');
  const r2 = runLint(['--gate', '--project', red, '--base', 'HEAD~1']);
  expect(r2.code).toBe(1);
  expect(r2.json.aggregate).toBe('FAIL');
  expect(r2.json.projectRun.status).toBe('FAIL');
});

it("'CI 不执行 change-metadata'：发现链只落到 change-metadata 源 → FAIL no-trusted-command（命令不执行）", async () => {
  const proj = makeProject(); // 无 config / package.json 受信命令
  addChange(proj, 'c1', { meta: `schema: tdd-driven\nx-tdd-e2e.command: ${COUNTER_CMD}\n` });
  commitAll(proj, 'add c1');
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  const j = r.json;
  expect(j.aggregate).toBe('FAIL');
  expect(j.projectRun.error).toBe('no-trusted-command');
  expect(fs.existsSync(path.join(proj, 'ran.log'))).toBe(false); // change 级命令不被执行
});

it('命令链全空且无豁免 → FAIL no-command（fail-closed，不"没配就绿"）', async () => {
  const proj = makeProject();
  write(proj, 'src/a.ts', 'export const a = 2;\n');
  commitAll(proj, 'touch src');
  const r = runLint(['--gate', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.projectRun.error).toBe('no-command');
});

// ---------- 真值表 PASS 基线 ----------

it('真值表 PASS 基线：受信执行＋快照绑定＋台账/发布契约全过 → PASS', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(0);
  const j = r.json;
  expect(j.aggregate).toBe('PASS');
  expect(j.projectRun.status).toBe('PASS');
  expect(j.changes[0]).toMatchObject({ name: 'c1', status: 'PASS' });
});

it('merge queue：合成结果 vs 目标分支基线（--base 传目标分支）', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  const targetBase = headSha(proj); // 目标分支基线
  git(proj, 'checkout -qb feature');
  addChange(proj, 'c1');
  write(proj, 'src/a.ts', 'export const a = 2;\n');
  commitAll(proj, 'feature work');
  expect(finalize(proj, 'c1').code).toBe(0);
  git(proj, 'checkout -q main');
  git(proj, '-c user.email=t@t -c user.name=t merge -q --no-ff -m merge feature'); // 合成结果
  const r = runLint(['--gate', '--project', proj, '--base', targetBase]);
  expect(r.code).toBe(0);
  const j = r.json;
  expect(j.aggregate).toBe('PASS');
  expect(j.changes[0]).toMatchObject({ name: 'c1', status: 'PASS' });
});

// ---------- ② 受检集合身份决策（新增/迁移/删除/空集合） ----------

it('身份决策：迁移按迁移后身份（含新归档 archive/YYYY-MM-DD-<name>），旧身份删除记 NOT_APPLICABLE', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);
  commitAll(proj, 'commit bundle'); // E3：bundle 随 change 入提交
  const base = headSha(proj);
  fs.mkdirSync(path.join(proj, 'openspec', 'changes', 'archive'), { recursive: true });
  git(proj, 'mv openspec/changes/c1 openspec/changes/archive/2026-11-27-c1');
  commitAll(proj, 'managed archive move');
  const r = runLint(['--gate', '--project', proj, '--base', base]);
  expect(r.code).toBe(0);
  const j = r.json;
  const byName = Object.fromEntries(j.changes.map((c: any) => [c.name, c]));
  expect(byName['archive/2026-11-27-c1']).toMatchObject({ status: 'PASS' }); // 按迁移后身份受判
  expect(byName.c1.status).toBe('NOT_APPLICABLE');
  expect(byName.c1.reason).toContain('deleted');
  expect(j.aggregate).toBe('PASS');
});

it('身份决策：删除须确认清理完整——干净删除 NOT_APPLICABLE，生成记录残片 FAIL', async () => {
  // 干净删除
  const p1 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p1, 'c1');
  commitAll(p1, 'add c1');
  const base1 = headSha(p1);
  git(p1, 'rm -rq openspec/changes/c1');
  commitAll(p1, 'delete change');
  const r1 = runLint(['--gate', '--project', p1, '--base', base1]);
  expect(r1.code).toBe(0);
  expect(r1.json.changes[0]).toMatchObject({ name: 'c1', status: 'NOT_APPLICABLE' });
  expect(r1.json.changes[0].reason).toContain('deleted');

  // 删除后留 evidence 残片 → 清理不完整 FAIL
  const p2 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p2, 'c1');
  commitAll(p2, 'add c1');
  const base2 = headSha(p2);
  git(p2, 'rm -rq openspec/changes/c1');
  commitAll(p2, 'delete change');
  write(p2, 'openspec/changes/c1/evidence/leftover.json', '{}');
  const r2 = runLint(['--gate', '--project', p2, '--base', base2]);
  expect(r2.code).toBe(1);
  expect(r2.json.changes[0].reason).toContain('incomplete-deletion');
});

// ---------- ③ EXEMPT 授权（受信授权记录） ----------

it('EXEMPT 需受信授权记录：glob 不授权、快照变化授权失效', async () => {
  // (a) 裸 glob/名称条目只筛候选，不作授权 → FAIL
  const p1 = makeProject({ config: { command: COUNTER_CMD, allowlist: ['c1', 'openspec/changes/c1/**'] } });
  addChange(p1, 'c1', { meta: SKIP_META });
  commitAll(p1, 'add c1');
  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', 'HEAD~1']);
  expect(r1.code).toBe(1);
  expect(r1.json.aggregate).toBe('FAIL');
  expect(r1.json.changes[0].reason).toContain('unauthorized');

  // (b) 结构化记录命中身份但受审快照 hash 不符 → 授权失效 → FAIL
  const p2 = makeProject({
    config: {
      command: COUNTER_CMD,
      allowlist: [JSON.stringify({ change: 'c1', snapshot: '0'.repeat(64), scope: ['openspec/changes/c1/**'], approver: 'alice' })],
    },
  });
  addChange(p2, 'c1', { meta: SKIP_META });
  commitAll(p2, 'add c1');
  const r2 = runLint(['--gate', '--change', 'c1', '--project', p2, '--base', 'HEAD~1']);
  expect(r2.code).toBe(1);
  expect(r2.json.changes[0].reason).toContain('authorization-stale');

  // (c) 有效授权（身份＋受审快照 hash＋范围＋批准人）→ EXEMPT 独立结果、免重跑
  const p3 = makeProject();
  addChange(p3, 'c1', { meta: SKIP_META });
  const snapshot = computePlanningHash(path.join(p3, 'openspec', 'changes', 'c1'));
  write(p3, 'tdd-e2e.config.json', JSON.stringify({
    command: COUNTER_CMD,
    allowlist: [JSON.stringify({ change: 'c1', snapshot, scope: ['openspec/changes/c1/**'], approver: 'alice' })],
  }));
  git(p3, 'add tdd-e2e.config.json');
  git(p3, '-c user.email=t@t -c user.name=t commit -qm policy'); // 受信策略先入基线（diff 只含 change）
  commitAll(p3, 'add c1');
  const r3 = runLint(['--gate', '--change', 'c1', '--project', p3, '--base', 'HEAD~1']);
  expect(r3.code).toBe(0);
  const j3 = r3.json;
  expect(j3.aggregate).toBe('EXEMPT');
  expect(j3.changes[0].status).toBe('EXEMPT');
  expect(j3.changes[0].reason).toContain('alice');
  expect(j3.projectRun.status).toBe('SKIP-EXEC'); // 免重跑（凭授权记录）
  expect(fs.existsSync(path.join(p3, 'ran.log'))).toBe(false);

  // (d) 记录缺批准人 = 不完整记录，不作授权 → FAIL
  const p4 = makeProject();
  addChange(p4, 'c1', { meta: SKIP_META });
  const snap4 = computePlanningHash(path.join(p4, 'openspec', 'changes', 'c1'));
  write(p4, 'tdd-e2e.config.json', JSON.stringify({
    command: COUNTER_CMD,
    allowlist: [JSON.stringify({ change: 'c1', snapshot: snap4, scope: ['**'] })],
  }));
  git(p4, 'add tdd-e2e.config.json');
  git(p4, '-c user.email=t@t -c user.name=t commit -qm policy');
  commitAll(p4, 'add c1');
  const r4 = runLint(['--gate', '--change', 'c1', '--project', p4, '--base', 'HEAD~1']);
  expect(r4.code).toBe(1);
  expect(r4.json.changes[0].reason).toContain('unauthorized');
});

it('skip 无 reason 不构成豁免声明，照常收测试门禁（0-task 受限）', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1', { meta: 'schema: tdd-driven\nx-tdd-e2e.skip: true\n', tasks: '- bullet one\n' });
  commitAll(proj, 'add c1');
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.changes[0].status).toBe('FAIL'); // 无绿证据（蕴含式：0-task 同样受限）
});

// ---------- ⑤ 快照绑定（从最终候选重算组合键） ----------

it('快照绑定：finalize 后改 src → --gate 判 FAIL（stale-inputs）', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);
  write(proj, 'src/a.ts', 'export const a = 2;\n'); // 绿检查后改 src
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  const j = r.json;
  expect(j.aggregate).toBe('FAIL');
  expect(j.changes[0].status).toBe('FAIL');
  expect(j.changes[0].reason).toContain('stale-inputs');
});

it('快照绑定：finalize 后改台账 → 组合键变（规划面入键）→ FAIL stale-inputs', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);
  write(proj, 'openspec/changes/c1/tests/ledger.md', `${LEDGER_GREEN}// touched\n`);
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.changes[0].reason).toContain('stale-inputs');
});

it('绿检查后移动/修改 bundle 文件 → 旧检查不可放行（联动 Task 4）', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  const f = finalize(proj, 'c1');
  expect(f.code).toBe(0);
  const runId = JSON.parse(f.stdout).runId;
  const bundle = path.join(proj, 'openspec', 'changes', 'c1', 'evidence', 'runs', runId);
  fs.renameSync(path.join(bundle, 'e2e-result.json'), path.join(bundle, 'moved.json'));
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.changes[0].status).toBe('FAIL');
  expect(r.json.changes[0].reason).toContain('evidence');
});

// ---------- ⑥ 台账对账（场景 = requirement 下 h4 子标题） ----------

it('台账对账：未知场景引用 FAIL、场景重名 FAIL、映射缺失 FAIL', async () => {
  // (a) 未知场景引用
  const p1 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p1, 'c1', { ledger: LEDGER_UNKNOWN_ROW });
  commitAll(p1, 'add c1');
  expect(finalize(p1, 'c1').code).toBe(0);
  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', 'HEAD~1']);
  expect(r1.code).toBe(1);
  expect(r1.json.changes[0].reason).toContain('unknown');

  // (b) 场景重名（同 requirement 下同名 h4）→ FAIL + 诊断
  const p2 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p2, 'c1', { spec: SPEC_DUPLICATE });
  commitAll(p2, 'add c1');
  expect(finalize(p2, 'c1').code).toBe(0);
  const r2 = runLint(['--gate', '--change', 'c1', '--project', p2, '--base', 'HEAD~1']);
  expect(r2.code).toBe(1);
  expect(r2.json.changes[0].reason).toContain('duplicate');
  expect(r2.json.changes[0].diagnostics.join('\n')).toContain('Basic echo');

  // (c) 映射缺失（场景无台账条目）
  const p3 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p3, 'c1', { ledger: LEDGER_PARTIAL });
  commitAll(p3, 'add c1');
  expect(finalize(p3, 'c1').code).toBe(0);
  const r3 = runLint(['--gate', '--change', 'c1', '--project', p3, '--base', 'HEAD~1']);
  expect(r3.code).toBe(1);
  expect(r3.json.changes[0].reason).toContain('unmapped');
});

it('台账全绿 ⇔ evidence 绿：绿 bundle 下台账仍有计划/红 → FAIL', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1', { ledger: LEDGER_NOT_GREEN });
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.changes[0].reason).toContain('ledger-not-green');
});

it('无 delta / 零场景 → 按 skip_specs 判 NOT_APPLICABLE 或 FAIL', async () => {
  // skip_specs: true → 免场景对账，记 NOT_APPLICABLE（不因此 PASS；项目级 e2e 不免）
  const p1 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p1, 'c1', { meta: 'schema: tdd-driven\nskip_specs: true\n', spec: SPEC_ZERO_SCENARIO, ledger: null });
  commitAll(p1, 'add c1');
  expect(finalize(p1, 'c1').code).toBe(0);
  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', 'HEAD~1']);
  expect(r1.code).toBe(0);
  expect(r1.json.changes[0].status).toBe('NOT_APPLICABLE');

  // 无 skip_specs → FAIL（tdd-driven 必须有可对账场景）
  const p2 = makeProject({ config: { command: GREEN_CMD } });
  addChange(p2, 'c1', { spec: SPEC_ZERO_SCENARIO, ledger: null });
  commitAll(p2, 'add c1');
  expect(finalize(p2, 'c1').code).toBe(0);
  const r2 = runLint(['--gate', '--change', 'c1', '--project', p2, '--base', 'HEAD~1']);
  expect(r2.code).toBe(1);
  expect(r2.json.changes[0].reason).toContain('no-scenarios');
});

// ---------- ⑦ 发布契约（produces 齐全、清单校验） ----------

it('发布契约：produces 声明缺件 → FAIL missing-produces', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD, produces: ['dist/app.js'] } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  write(proj, 'dist/app.js', 'artifact\n'); // 未跟踪制品（不入指纹，差异不引入 stale）
  expect(finalize(proj, 'c1').code).toBe(0); // 收尾时制品在场
  fs.rmSync(path.join(proj, 'dist', 'app.js')); // 发布前制品消失
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.changes[0].reason).toContain('missing-produces');
});

it('发布契约：制品清单内容复验（verifyBundle 只做结构校验，内容复验在权威判定）', async () => {
  const proj = makeProject({
    config: {
      command: `node -e "const fs=require('fs');if(!fs.existsSync('dist/app.js')){fs.mkdirSync('dist',{recursive:true});fs.writeFileSync('dist/app.js','hello')}"`,
      produces: ['dist/app.js'],
      collect: ['dist/*'],
    },
  });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  const f = finalize(proj, 'c1');
  expect(f.code).toBe(0);
  expect(JSON.parse(f.stdout).artifacts).toHaveLength(1);
  write(proj, 'dist/app.js', 'tampered'); // 绿检查后改制品内容（未跟踪 → 指纹不变）
  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  expect(r.json.changes[0].reason).toContain('manifest-mismatch');
});

// ---------- 聚合与输出 ----------

it('聚合取最差项：一 change FAIL → aggregate FAIL', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1', { meta: "schema: ''\n" }); // 元数据无效 → FAIL
  addChange(proj, 'c2'); // 全绿
  commitAll(proj, 'add changes');
  expect(finalize(proj, 'c2').code).toBe(0);
  const r = runLint(['--gate', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code).toBe(1);
  const j = r.json;
  expect(j.aggregate).toBe('FAIL');
  expect(j.changes.map((c: any) => [c.name, c.status])).toEqual([['c1', 'FAIL'], ['c2', 'PASS']]);
});

it('非 --json 模式：人类可读摘要 + 相同退出码；缺 --gate / 坏 --base → usage 错误 exit 2', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  addChange(proj, 'c1');
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);
  const human = spawnSync(process.execPath, [lintScript, '--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1'], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '' },
  });
  expect(human.status).toBe(0);
  expect(human.stdout).toContain('AGGREGATE=PASS');

  const noGate = runLint(['--project', proj]);
  expect(noGate.code).toBe(2);
  expect(noGate.json.error).toBe('invalid-args');

  const badBase = runLint(['--gate', '--project', proj, '--base', 'no-such-ref']);
  expect(badBase.code).toBe(2);
  expect(badBase.json.error).toBe('invalid-args');
});

// ---------- typo 诊断（设计 §6.3：warning 不拦截） ----------

it('元数据近似键 → warnings 报 metadata-typo 诊断，不拦截判定（aggregate 不因此变）', async () => {
  const proj = makeProject({ config: { command: GREEN_CMD } });
  // c1：近似键（下划线分隔变体 + 裸 skip_reason）但 schema 合法、证据全绿 → 应 PASS + 诊断
  addChange(proj, 'c1', {
    meta: 'schema: tdd-driven\nx-tdd-e2e_skip: true\nskip_reason: upstream flake\n',
  });
  commitAll(proj, 'add c1');
  expect(finalize(proj, 'c1').code).toBe(0);

  const r = runLint(['--gate', '--change', 'c1', '--project', proj, '--base', 'HEAD~1']);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);
  const j = r.json;
  expect(j.aggregate).toBe('PASS');
  expect(j.changes[0].status).toBe('PASS');
  const typos = (j.warnings as string[]).filter((w) => w.startsWith('metadata-typo:'));
  expect(typos.some((w) => w.includes('"x-tdd-e2e_skip"')), '近似键 x-tdd-e2e_skip 应被点名').toBe(true);
  expect(typos.some((w) => w.includes('"skip_reason"')), '裸 skip_reason 应被点名').toBe(true);
  expect(typos.some((w) => w.includes('c1')), '诊断应可定位到 change').toBe(true);

  // 对照：无近似键的绿 change 不产生 typo 诊断
  const clean = makeProject({ config: { command: GREEN_CMD } });
  addChange(clean, 'c1');
  commitAll(clean, 'add c1');
  expect(finalize(clean, 'c1').code).toBe(0);
  const r2 = runLint(['--gate', '--change', 'c1', '--project', clean, '--base', 'HEAD~1']);
  expect(r2.code).toBe(0);
  expect((r2.json.warnings as string[]).filter((w) => w.startsWith('metadata-typo:'))).toEqual([]);
});

// ---------- 受信策略 ref（契约一：命令发现/policyVersion/enforce/allowlist 走受信 ref） ----------

it('受信策略 ref：默认 origin/main 解析命令与 policyVersion，工作树篡改 test:e2e 不生效', async () => {
  // ① 临时双 ref 仓库：origin/main 版 test:e2e = COUNTER_CMD，工作树版被改成平凡绿 true
  const p1 = makeProject({ pkg: { scripts: { 'test:e2e': COUNTER_CMD } } });
  addChange(p1, 'c1');
  commitAll(p1, 'add c1');
  const base1 = headSha(p1);
  git(p1, `update-ref refs/remotes/origin/main ${base1}`);
  write(p1, 'package.json', JSON.stringify({ scripts: { 'test:e2e': 'true' } })); // 工作树篡改

  const r1 = runLint(['--gate', '--change', 'c1', '--project', p1, '--base', base1]);
  expect(r1.json.projectRun.command).toBe(COUNTER_CMD); // discovery 仍解析 origin/main 版本
  expect(r1.json.projectRun.commandSource).toBe('package-json');
  expect(r1.json.projectRun.policySource).toBe('ref:origin/main');
  const refPkg = execSync('git show origin/main:package.json', { cwd: p1, encoding: 'utf8' });
  expect(r1.json.projectRun.policyVersion).toBe(createHash('sha256').update(refPkg).digest('hex')); // policyVersion = ref 内容哈希
  expect(fs.readFileSync(path.join(p1, 'ran.log'), 'utf8')).toBe('x'); // 真实执行的是 ref 版命令（不是 true）

  // ② 完整放行链：finalize 同样按受信 ref 收尾（键含 ref 的 policyVersion）→ --gate 缺省也走 ref → PASS
  const p2 = makeProject({ pkg: { scripts: { 'test:e2e': COUNTER_CMD } } });
  addChange(p2, 'c1');
  commitAll(p2, 'add c1');
  const base2 = headSha(p2);
  git(p2, `update-ref refs/remotes/origin/main ${base2}`);
  write(p2, 'package.json', JSON.stringify({ scripts: { 'test:e2e': 'true' } }));
  const f2 = spawnSync(
    process.execPath,
    [gateScript, '--change', 'c1', '--project', p2, '--finalize', '--policy-ref', 'origin/main', '--json'],
    { encoding: 'utf-8', env: { ...process.env, CI: '' } },
  );
  expect(f2.status, f2.stderr ?? '').toBe(0);
  const r2 = runLint(['--gate', '--change', 'c1', '--project', p2, '--base', base2]);
  expect(r2.code, `${r2.stdout}\n${r2.stderr}`).toBe(0);
  expect(r2.json.aggregate).toBe('PASS');
  expect(r2.json.changes[0].status).toBe('PASS');
  expect(r2.json.projectRun.policySource).toBe('ref:origin/main');
});

it('受信策略 ref 不可解析回退：无 origin/main → 回退 working-tree 并记 warning；显式 ref 不可解析 → exit 2', async () => {
  const proj = makeProject({ config: { command: COUNTER_CMD } });
  write(proj, 'src/a.ts', 'export const a = 2;\n');
  commitAll(proj, 'touch src');
  const r = runLint(['--gate', '--project', proj, '--base', 'HEAD~1']); // 缺省 --policy-ref：origin/main 不可解析
  expect(r.code).toBe(0);
  expect(r.json.projectRun.policySource).toBe('working-tree');
  expect((r.json.warnings as string[]).some((w) => w.includes('origin/main'))).toBe(true); // 回退有 warning

  const bad = runLint(['--gate', '--project', proj, '--base', 'HEAD~1', '--policy-ref', 'no-such-ref']);
  expect(bad.code).toBe(2);
  expect(bad.json.error).toBe('invalid-args');
});
