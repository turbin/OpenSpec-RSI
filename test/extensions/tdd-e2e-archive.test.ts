// test/extensions/tdd-e2e-archive.test.ts
// e2e-lint --archive-gate --execute 受管归档（Task 6；E2 生命周期，设计 §6.3 契约三"已同步后移动"）：
// ①完整判定（含重跑，复用 --gate 单 change 路径）→ ②快照复验（受测快照 == 当前受检树，重算组合键比对）
// → ③sync 完整性校验（specs delta 已合入主 spec 或显式 skip_specs；部分完成 = error:'sync-incomplete'）
// → ④移动（目标预检 / no-clobber / 日期前缀 YYYY-MM-DD-<name> 不重复加 / 复验-移动持 run lock / 失败回退）。
// 退出码 0 = 归档完成；判定红 / 快照复验拒绝 / sync 未完成 / 目标占用 / 移动失败 / 锁忙 = exit 1 且不移动。
// EXEMPT 归档可继续，但 evidence/archive-record.json 必带豁免标记与授权引用（可审计）。
import { it, expect, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-archive-'));
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
const SKIP_META = 'schema: tdd-driven\nx-tdd-e2e.skip: true\nx-tdd-e2e.skip_reason: upstream flake\n';

// ---- specs delta 工件 ----

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

// 两需求各一场景（sync 部分完成用例）
const SPEC_TWO_REQ = [
  '## ADDED Requirements',
  '',
  '### Requirement: Echo behavior',
  'Users SHALL echo input.',
  '',
  '#### Scenario: Basic echo',
  '- **WHEN** input is given',
  '- **THEN** it is echoed',
  '',
  '### Requirement: Empty handling',
  'Users SHALL handle empty input.',
  '',
  '#### Scenario: Empty input',
  '- **WHEN** input is empty',
  '- **THEN** nothing is echoed',
  '',
].join('\n');

// ADDED 一条 + REMOVED 一条（REMOVED 已清/未清用例）
const SPEC_ADD_REMOVE = [
  '## ADDED Requirements',
  '',
  '### Requirement: Echo behavior',
  'Users SHALL echo input.',
  '',
  '#### Scenario: Basic echo',
  '- **WHEN** input is given',
  '- **THEN** it is echoed',
  '',
  '## REMOVED Requirements',
  '',
  '### Requirement: Old behavior',
  '',
].join('\n');

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

const LEDGER_TWO = [
  LEDGER_HEADER,
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Basic echo` | happy | `tests/echo.test.ts#basic` | 绿 |',
  '| `cap` | `### Requirement: Empty handling` | `#Empty handling / Empty input` | edge | `tests/echo.test.ts#empty` | 绿 |',
  '',
].join('\n');

const LEDGER_ONE = [
  LEDGER_HEADER,
  '| `cap` | `### Requirement: Echo behavior` | `#Echo behavior / Basic echo` | happy | `tests/echo.test.ts#basic` | 绿 |',
  '',
].join('\n');

/** 主 spec（openspec/specs/<capability>/spec.md）：sync 完整性校验的比对对象（只看 requirement 头）。 */
function mainSpec(...names: string[]): string {
  return [
    '# cap',
    '',
    '## Purpose',
    '',
    'Main spec for cap.',
    '',
    '## Requirements',
    '',
    ...names.flatMap((n) => [`### Requirement: ${n}`, `Users SHALL ${n.toLowerCase()}.`, '']),
  ].join('\n');
}

/** 归档日期前缀（本地时区 YYYY-MM-DD，与 src/core/archive.ts formatLocalDate 同语义）。 */
function datePrefix(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

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

interface ArchiveRun {
  code: number | null;
  stdout: string;
  stderr: string;
  json: any;
}

function runArchive(args: string[]): ArchiveRun {
  const argv = args.includes('--json') ? args : [...args, '--json'];
  const r = spawnSync(process.execPath, [lintScript, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '' },
  });
  const stdout = r.stdout ?? '';
  let json: unknown = null;
  try {
    json = JSON.parse(stdout);
  } catch {
    /* 非 JSON 输出时保持 null */
  }
  return { code: r.status, stdout, stderr: r.stderr ?? '', json };
}

/** 目录树相对路径清单（排序），用于"源目录完整/原样"断言。 */
function walkRel(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string): void => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) visit(path.join(dir, e.name), r);
      else out.push(r);
    }
  };
  visit(root, '');
  return out.sort();
}

/**
 * 整备 change：change 工件 + （可选）主 spec + 绿 bundle 入库。
 * 返回 init 提交 sha 作 --base（diff 覆盖 change/主 spec/bundle，强制重跑路径）。
 */
function readyChange(opts: {
  name?: string;
  meta?: string | null;
  spec?: string | null;
  ledger?: string | null;
  main?: string | null;
  config?: unknown;
} = {}): { proj: string; base: string; name: string } {
  const name = opts.name ?? 'c1';
  const proj = makeProject({ config: opts.config ?? { command: GREEN_CMD } });
  const base = headSha(proj);
  addChange(proj, name, { meta: opts.meta, spec: opts.spec, ledger: opts.ledger });
  if (opts.main !== null) write(proj, 'openspec/specs/cap/spec.md', opts.main ?? mainSpec('Echo behavior'));
  commitAll(proj, 'add change');
  expect(finalize(proj, name).code).toBe(0);
  commitAll(proj, 'commit bundle');
  return { proj, base, name };
}

// ---------- ① 判定绿 → 执行移动 ----------

it('判定绿 → 执行移动，目录落到 archive/YYYY-MM-DD-<name>，归档记录随行', async () => {
  const { proj, base } = readyChange();
  const r = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', proj, '--base', base]);
  expect(r.code).toBe(0);
  const j = r.json;
  expect(j.archive).toBe('done');
  expect(j.judgment.status).toBe('PASS');
  const target = `openspec/changes/archive/${datePrefix()}-c1`;
  expect(j.target).toBe(target);
  expect(j.archivedAs).toBe(`${datePrefix()}-c1`);
  expect(fs.existsSync(path.join(proj, target))).toBe(true); // 目录落到 archive/
  expect(fs.existsSync(path.join(proj, 'openspec', 'changes', 'c1'))).toBe(false); // 源已移走

  // 归档记录随行（evidence/archive-record.json = 归档记录载体，测试钉住）
  const record = JSON.parse(fs.readFileSync(path.join(proj, target, 'evidence', 'archive-record.json'), 'utf8'));
  expect(record.change).toBe('c1');
  expect(record.archivedAs).toBe(`${datePrefix()}-c1`);
  expect(record.judgment.status).toBe('PASS');
  expect(record.exemption).toBeNull();
  expect(record.snapshot.inputKeyHash).toMatch(/^[0-9a-f]{64}$/);
  expect(fs.existsSync(path.join(proj, target, record.snapshot.bundle))).toBe(true); // bundle 随行可审计
});

// ---------- 日期前缀语义（对齐 src/core/archive.ts 先例：已带前缀不重复加） ----------

it('日期前缀语义：change 名已带 YYYY-MM-DD- 前缀 → 归档名不重复加', async () => {
  const { proj, base } = readyChange({ name: '2026-11-27-early' });
  const r = runArchive(['--archive-gate', '--change', '2026-11-27-early', '--execute', '--project', proj, '--base', base]);
  expect(r.code).toBe(0);
  expect(r.json.archivedAs).toBe('2026-11-27-early'); // 不加第二段日期
  expect(fs.existsSync(path.join(proj, 'openspec/changes/archive/2026-11-27-early'))).toBe(true);
  expect(fs.existsSync(path.join(proj, `openspec/changes/archive/${datePrefix()}-2026-11-27-early`))).toBe(false);
});

// ---------- ③ 移动阶段：no-clobber / 失败回退 ----------

it('目标已存在 → no-clobber 拒绝，源目录原样保留', async () => {
  const { proj, base } = readyChange();
  const target = `openspec/changes/archive/${datePrefix()}-c1`;
  write(proj, `${target}/marker.txt`, 'pre-existing\n'); // 预置同名归档
  const before = walkRel(path.join(proj, 'openspec/changes/c1'));
  const r = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', proj, '--base', base]);
  expect(r.code).toBe(1);
  expect(r.json.error).toBe('archive-target-exists');
  expect(walkRel(path.join(proj, 'openspec/changes/c1'))).toEqual(before); // 源目录原样保留
  expect(fs.readFileSync(path.join(proj, target, 'marker.txt'), 'utf8')).toBe('pre-existing\n'); // 目标未被触碰
  expect(fs.existsSync(path.join(proj, 'openspec/changes/c1', 'evidence', 'archive-record.json'))).toBe(false); // 无半态残留
});

it('移动失败（目标父目录只读）→ 回退不留半态，源目录完整', async () => {
  const { proj, base } = readyChange();
  const before = walkRel(path.join(proj, 'openspec/changes/c1'));
  const archiveDir = path.join(proj, 'openspec/changes/archive');
  fs.mkdirSync(archiveDir, { recursive: true });
  fs.chmodSync(archiveDir, 0o555);
  try {
    const r = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', proj, '--base', base]);
    expect(r.code).toBe(1);
    expect(r.json.error).toBe('move-failed');
    expect(r.json.message).toContain('rolled back');
    // 源目录完整：无缺文件、无归档记录残留
    expect(walkRel(path.join(proj, 'openspec/changes/c1'))).toEqual(before);
    // 无 staged 中间名残留、无半态目标
    const siblings = fs.readdirSync(path.join(proj, 'openspec/changes'));
    expect(siblings.filter((n) => n.startsWith('.e2e-move-'))).toEqual([]);
    expect(fs.existsSync(path.join(proj, `openspec/changes/archive/${datePrefix()}-c1`))).toBe(false);
  } finally {
    fs.chmodSync(archiveDir, 0o755); // 还原权限，供 afterAll 清理
  }
});

// ---------- ③ sync 完整性校验（已同步后移动） ----------

it('sync 未完成（delta 未合入主 spec）→ 报错中止 error:sync-incomplete 不移动', async () => {
  // (a) 完全未合入：主 spec 缺失
  const f1 = readyChange({ main: null });
  const r1 = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', f1.proj, '--base', f1.base]);
  expect(r1.code).toBe(1);
  expect(r1.json.error).toBe('sync-incomplete');
  expect(fs.existsSync(path.join(f1.proj, 'openspec/changes/c1'))).toBe(true);
  expect(fs.existsSync(path.join(f1.proj, `openspec/changes/archive/${datePrefix()}-c1`))).toBe(false);

  // (b) 部分完成：两需求只合入一条
  const f2 = readyChange({ spec: SPEC_TWO_REQ, ledger: LEDGER_TWO, main: mainSpec('Echo behavior') });
  const r2 = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', f2.proj, '--base', f2.base]);
  expect(r2.code).toBe(1);
  expect(r2.json.error).toBe('sync-incomplete');
  expect(r2.json.message).toContain('Empty handling'); // 点名未合入需求
  expect(fs.existsSync(path.join(f2.proj, 'openspec/changes/c1'))).toBe(true);

  // (c) REMOVED 未清：delta 移除的需求仍在主 spec → 同样未完成
  const f3 = readyChange({ spec: SPEC_ADD_REMOVE, ledger: LEDGER_ONE, main: mainSpec('Echo behavior', 'Old behavior') });
  const r3 = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', f3.proj, '--base', f3.base]);
  expect(r3.code).toBe(1);
  expect(r3.json.error).toBe('sync-incomplete');
  expect(r3.json.message).toContain('Old behavior');
  const f3b = readyChange({ spec: SPEC_ADD_REMOVE, ledger: LEDGER_ONE, main: mainSpec('Echo behavior') }); // 已清
  const r3b = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', f3b.proj, '--base', f3b.base]);
  expect(r3b.code).toBe(0);
  expect(fs.existsSync(path.join(f3b.proj, 'openspec/changes/archive', `${datePrefix()}-c1`))).toBe(true);

  // (d) 显式 skip_specs → 跳过 sync 校验（零场景 NOT_APPLICABLE 判定亦可归档）
  const f4 = readyChange({
    meta: 'schema: tdd-driven\nskip_specs: true\n',
    spec: SPEC_ZERO_SCENARIO,
    ledger: null,
    main: null,
  });
  const r4 = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', f4.proj, '--base', f4.base]);
  expect(r4.code).toBe(0);
  expect(r4.json.archive).toBe('done');
  expect(r4.json.judgment.status).toBe('NOT_APPLICABLE');
});

// ---------- ① 判定红 → 不移动 ----------

it('判定红 → 不移动', async () => {
  // (a) 无绿证据（无 run bundle）→ 判定 FAIL
  const p1 = makeProject({ config: { command: GREEN_CMD } });
  const b1 = headSha(p1);
  addChange(p1, 'c1');
  write(p1, 'openspec/specs/cap/spec.md', mainSpec('Echo behavior'));
  commitAll(p1, 'add c1');
  const r1 = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', p1, '--base', b1]);
  expect(r1.code).toBe(1);
  expect(r1.json.error).toBe('judgment-red');
  expect(r1.json.judgment.status).toBe('FAIL');
  expect(fs.existsSync(path.join(p1, 'openspec/changes/c1'))).toBe(true);
  expect(fs.existsSync(path.join(p1, `openspec/changes/archive/${datePrefix()}-c1`))).toBe(false);

  // (b) 权威重跑红（旧 bundle 仍绿）→ 完整判定（含重跑）红 → 不移动
  const p2 = makeProject({ config: { command: 'node -e "process.exit(require(\'fs\').existsSync(\'red.txt\')?1:0)"' } });
  const b2 = headSha(p2);
  addChange(p2, 'c1');
  write(p2, 'openspec/specs/cap/spec.md', mainSpec('Echo behavior'));
  commitAll(p2, 'add c1');
  expect(finalize(p2, 'c1').code).toBe(0);
  commitAll(p2, 'commit bundle');
  write(p2, 'red.txt', 'red\n'); // 未跟踪 → 指纹不可见 → bundle 仍绑定；重跑读到即红
  const r2 = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', p2, '--base', b2]);
  expect(r2.code).toBe(1);
  expect(r2.json.error).toBe('judgment-red');
  expect(r2.json.projectRun.status).toBe('FAIL'); // 重跑红参与判定
  expect(r2.json.judgment.status).toBe('PASS'); // 旧快照仍绿，但完整判定红 → 拒绝
  expect(fs.existsSync(path.join(p2, 'openspec/changes/c1'))).toBe(true);
});

// ---------- ③ EXEMPT 归档标记（裁定：豁免标记 + 授权引用入归档记录） ----------

it('EXEMPT 归档可继续，归档记录带豁免标记与授权引用', async () => {
  const proj = makeProject();
  addChange(proj, 'c1', { meta: SKIP_META });
  write(proj, 'openspec/specs/cap/spec.md', mainSpec('Echo behavior')); // sync 已完成
  const snapshot = computePlanningHash(path.join(proj, 'openspec', 'changes', 'c1'));
  write(proj, 'tdd-e2e.config.json', JSON.stringify({
    command: COUNTER_CMD,
    allowlist: [JSON.stringify({ change: 'c1', snapshot, scope: ['openspec/changes/c1/**'], approver: 'alice' })],
  }));
  git(proj, 'add tdd-e2e.config.json');
  git(proj, '-c user.email=t@t -c user.name=t commit -qm policy'); // 受信策略先入基线
  const base = headSha(proj);
  commitAll(proj, 'add c1');
  const r = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', proj, '--base', base]);
  expect(r.code).toBe(0);
  expect(r.json.archive).toBe('done');
  expect(r.json.judgment.status).toBe('EXEMPT');
  const target = `openspec/changes/archive/${datePrefix()}-c1`;
  expect(fs.existsSync(path.join(proj, target))).toBe(true);
  const record = JSON.parse(fs.readFileSync(path.join(proj, target, 'evidence', 'archive-record.json'), 'utf8'));
  expect(record.judgment.status).toBe('EXEMPT');
  expect(record.exemption.exempt).toBe(true); // 豁免标记
  expect(record.exemption.skipReason).toBe('upstream flake');
  expect(record.exemption.authorization).toEqual({ // 授权引用（身份＋受审快照＋范围＋批准人）
    change: 'c1',
    snapshot,
    scope: ['openspec/changes/c1/**'],
    approver: 'alice',
  });
  expect(record.snapshot).toBeNull(); // 无绿 bundle（EXEMPT 不测）
});

// ---------- ② 快照复验（防判定后编辑：重算组合键比对） ----------

it('快照复验：判定后策略面被改写 → 重算组合键失配拒绝，不移动', async () => {
  const proj = makeProject(); // 无 config（稍后以未跟踪形态写入 → 指纹不可见）
  addChange(proj, 'c1');
  write(proj, 'openspec/specs/cap/spec.md', mainSpec('Echo behavior'));
  commitAll(proj, 'add c1');
  // 受信命令 = 后置编辑器：sentinel 存在时改写策略文件（未跟踪 → 指纹不可见，仅 policyVersion 变）
  const postEditCmd = 'node -e \'const f=require("fs");if(f.existsSync("sentinel.txt")){const c=JSON.parse(f.readFileSync("tdd-e2e.config.json","utf8"));c.note="post-judgment edit";f.writeFileSync("tdd-e2e.config.json",JSON.stringify(c))}\'';
  const base = headSha(proj);
  write(proj, 'tdd-e2e.config.json', JSON.stringify({ command: postEditCmd })); // 保持未跟踪（勿 git add）
  expect(finalize(proj, 'c1').code).toBe(0); // 无 sentinel → 不改写；bundle 绑定 policyVersion=C1
  write(proj, 'sentinel.txt', 'go\n'); // 未跟踪 → 指纹不可见；重跑命令读到即改写策略文件
  const r = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', proj, '--base', base]);
  expect(r.code).toBe(1);
  expect(r.json.error).toBe('snapshot-recheck-failed');
  expect(r.json.judgment.status).toBe('PASS'); // 判定绿（按 C1 策略绑定），
  expect(fs.existsSync(path.join(proj, 'openspec/changes/c1'))).toBe(true); // 但复验拒绝 → 不移动
  expect(fs.existsSync(path.join(proj, `openspec/changes/archive/${datePrefix()}-c1`))).toBe(false);
});

// ---------- ③ 复验-移动间持 run lock（并发防护） ----------

it('锁并发：run lock 持有时拒绝归档（run-locked），源目录原样', async () => {
  const { proj, base } = readyChange();
  write(proj, 'openspec/changes/c1/evidence/.run-lock', 'held\n'); // 他人持锁
  const before = walkRel(path.join(proj, 'openspec/changes/c1'));
  const r = runArchive(['--archive-gate', '--change', 'c1', '--execute', '--project', proj, '--base', base]);
  expect(r.code).toBe(1);
  expect(r.json.error).toBe('run-locked');
  expect(walkRel(path.join(proj, 'openspec/changes/c1'))).toEqual(before); // 源目录原样（含他人锁）
  expect(fs.existsSync(path.join(proj, 'openspec/changes/c1', 'evidence', '.run-lock'))).toBe(true);
  expect(fs.existsSync(path.join(proj, `openspec/changes/archive/${datePrefix()}-c1`))).toBe(false);
});
