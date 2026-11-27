// test/extensions/tdd-e2e-gate.test.ts
import { it, expect, afterAll } from 'vitest';
import { spawnSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
  loadProjectConfig,
  discoverCommand,
  parseChangeMetadata,
} from '../../extensions/tdd-e2e/scripts/lib/config.mjs';
import { verifyBundle } from '../../extensions/tdd-e2e/scripts/lib/bundle.mjs';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const gateScript = path.join(repoRoot, 'extensions', 'tdd-e2e', 'scripts', 'e2e-gate.mjs');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

interface ProjectOpts {
  config?: unknown; // 对象则 JSON 序列化；字符串则原样写入（用于坏 JSON）
  pkg?: unknown;
  meta?: string; // .openspec.yaml 全文
  files?: Record<string, string>;
}

function makeProject(opts: ProjectOpts = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  fs.mkdirSync(path.join(root, 'openspec', 'changes', 'c1'), { recursive: true });
  fs.writeFileSync(
    path.join(root, 'openspec', 'changes', 'c1', '.openspec.yaml'),
    opts.meta ?? 'schema: tdd-driven\n',
  );
  if (opts.config !== undefined) {
    fs.writeFileSync(
      path.join(root, 'tdd-e2e.config.json'),
      typeof opts.config === 'string' ? opts.config : JSON.stringify(opts.config),
    );
  }
  if (opts.pkg !== undefined) {
    fs.writeFileSync(
      path.join(root, 'package.json'),
      typeof opts.pkg === 'string' ? opts.pkg : JSON.stringify(opts.pkg),
    );
  }
  for (const [rel, content] of Object.entries(opts.files ?? {})) {
    const abs = path.join(root, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execSync('git init -q -b main', { cwd: root });
  execSync('git add -A', { cwd: root });
  execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
  return root;
}

/** spawn node 执行 gate、收集 stdout/exit code；缺省补 --json 便于断言（CI 环境强制置空，authority 默认可测）。 */
function runGate(args: string[], env: Record<string, string> = {}) {
  const argv = args.includes('--json') ? args : [...args, '--json'];
  const r = spawnSync(process.execPath, [gateScript, ...argv], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '', ...env },
  });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function stagingFile(root: string, runId: string): string {
  return path.join(root, 'openspec', 'changes', 'c1', 'evidence', '.staging', runId, 'e2e-result.json');
}

const sha256File = (p: string) => createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const marker = (label: string) => `node -e "require('fs').writeFileSync('ran.txt','${label}')"`;

// ---------- config.mjs 单元面 ----------

it('loadProjectConfig: 缺省全 null/false（无 tdd-e2e.config.json）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-cfg-'));
  tempDirs.push(root);
  expect(loadProjectConfig(root)).toEqual({
    command: null,
    enforce: null,
    allowlist: null,
    include: null,
    collect: null,
    produces: null,
    skipApproved: false,
    policySource: 'working-tree',
  });
});

it('loadProjectConfig: 读取全部字段；非法 JSON 抛 invalid-config', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-cfg-'));
  tempDirs.push(root);
  fs.writeFileSync(
    path.join(root, 'tdd-e2e.config.json'),
    JSON.stringify({
      command: 'node x',
      enforce: 'all-changes',
      allowlist: ['c1'],
      include: ['src/**'],
      collect: ['dist/*'],
      produces: ['dist/app.js'],
      skipApproved: true,
    }),
  );
  expect(loadProjectConfig(root)).toEqual({
    command: 'node x',
    enforce: 'all-changes',
    allowlist: ['c1'],
    include: ['src/**'],
    collect: ['dist/*'],
    produces: ['dist/app.js'],
    skipApproved: true,
    policySource: 'working-tree',
  });

  fs.writeFileSync(path.join(root, 'tdd-e2e.config.json'), '{ not json');
  let err: { code?: string } | undefined;
  try {
    loadProjectConfig(root);
  } catch (e) {
    err = e as { code?: string };
  }
  expect(err?.code).toBe('invalid-config');
});

it('parseChangeMetadata: 扁平点号键解析（字符串/布尔 coercion）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-meta-'));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, '.openspec.yaml'),
    [
      'schema: tdd-driven',
      'created: 2026-11-26',
      'x-tdd-e2e.command: node -e "process.exit(0)"',
      'x-tdd-e2e.skip: true',
      "x-tdd-e2e.skip_reason: 'upstream flake'",
      'skip_specs: false',
      '',
    ].join('\n'),
  );
  const { values, typos } = parseChangeMetadata(dir);
  expect(values).toEqual({
    schema: 'tdd-driven',
    created: '2026-11-26',
    'x-tdd-e2e.command': 'node -e "process.exit(0)"',
    'x-tdd-e2e.skip': true,
    'x-tdd-e2e.skip_reason': 'upstream flake',
    skip_specs: false,
  });
  expect(typos).toEqual([]);
});

it('parseChangeMetadata: 近似键 typo 诊断（x-tdd-e2e_skip、裸 skip_reason、拼写变体；核心键不误报）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-meta-'));
  tempDirs.push(dir);
  fs.writeFileSync(
    path.join(dir, '.openspec.yaml'),
    [
      'schema: tdd-driven',
      'skip_specs: true',
      'x-tdd-e2e.skip: true',
      'x-tdd-e2e_skip: true',
      'skip_reason: because',
      'x-tdd-e2e.comand: node x',
      'x-tdd-e2e.whatever: 1',
      '',
    ].join('\n'),
  );
  const { typos } = parseChangeMetadata(dir);
  expect(typos).toContain('x-tdd-e2e_skip');
  expect(typos).toContain('skip_reason');
  expect(typos).toContain('x-tdd-e2e.comand');
  expect(typos).toContain('x-tdd-e2e.whatever');
  expect(typos).not.toContain('schema');
  expect(typos).not.toContain('skip_specs');
  expect(typos).not.toContain('x-tdd-e2e.skip');
});

it('parseChangeMetadata: 无 .openspec.yaml → 空值不抛', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-meta-'));
  tempDirs.push(dir);
  expect(parseChangeMetadata(dir)).toEqual({ values: {}, typos: [] });
});

it('discoverCommand: config > package-json > change-metadata 三级优先', () => {
  const all = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-dc-'));
  tempDirs.push(all);
  fs.writeFileSync(path.join(all, 'tdd-e2e.config.json'), JSON.stringify({ command: 'cmd-config' }));
  fs.writeFileSync(path.join(all, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'cmd-pkg' } }));
  expect(discoverCommand({ projectRoot: all, changeMetadata: { 'x-tdd-e2e.command': 'cmd-change' } })).toEqual({
    command: 'cmd-config',
    source: 'config',
    policySource: 'working-tree',
    policyVersion: sha256File(path.join(all, 'tdd-e2e.config.json')),
  });

  const mid = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-dc-'));
  tempDirs.push(mid);
  fs.writeFileSync(path.join(mid, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'cmd-pkg' } }));
  expect(discoverCommand({ projectRoot: mid, changeMetadata: { 'x-tdd-e2e.command': 'cmd-change' } })).toEqual({
    command: 'cmd-pkg',
    source: 'package-json',
    policySource: 'working-tree',
    policyVersion: sha256File(path.join(mid, 'package.json')),
  });

  const low = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-dc-'));
  tempDirs.push(low);
  expect(discoverCommand({ projectRoot: low, changeMetadata: { 'x-tdd-e2e.command': 'cmd-change' } })).toEqual({
    command: 'cmd-change',
    source: 'change-metadata',
    policySource: 'working-tree',
    policyVersion: null,
  });
  expect(discoverCommand({ projectRoot: low, changeMetadata: {} })).toEqual({
    command: null,
    source: null,
    policySource: 'working-tree',
    policyVersion: null,
  });
});

// ---------- 受信策略 ref（契约一：命令/策略只读受信版本，候选 checkout 只提供被测代码与测试） ----------

const gitShowBuf = (root: string, ref: string, rel: string): Buffer =>
  execSync(`git show ${ref}:${rel}`, { cwd: root, maxBuffer: 64 * 1024 * 1024 });
const sha256Buf = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

it('policyRef：loadProjectConfig/discoverCommand 走 git show 受信版本，policyVersion=ref 内容哈希（工作树篡改不生效）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-ref-'));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, 'tdd-e2e.config.json'), JSON.stringify({ command: 'cmd-config-old', enforce: 'all-changes' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'cmd-pkg-old' } }));
  execSync('git init -q -b main', { cwd: root });
  execSync('git add -A', { cwd: root });
  execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });
  execSync('git update-ref refs/remotes/origin/main HEAD', { cwd: root });
  // 工作树篡改（未提交）：命令换成平凡绿 true、enforce 换掉——受信 ref 解析应完全无视
  fs.writeFileSync(path.join(root, 'tdd-e2e.config.json'), JSON.stringify({ command: 'true' }));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': 'true' } }));

  const refCfg = loadProjectConfig(root, { policyRef: 'origin/main' });
  expect(refCfg.command).toBe('cmd-config-old');
  expect(refCfg.enforce).toBe('all-changes');
  expect(refCfg.policySource).toBe('ref:origin/main');

  const refDisc = discoverCommand({ projectRoot: root, policyRef: 'origin/main' });
  expect(refDisc).toEqual({
    command: 'cmd-config-old',
    source: 'config',
    policySource: 'ref:origin/main',
    policyVersion: sha256Buf(gitShowBuf(root, 'origin/main', 'tdd-e2e.config.json')),
  });

  const wt = discoverCommand({ projectRoot: root });
  expect(wt.command).toBe('true');
  expect(wt.policySource).toBe('working-tree');
  expect(wt.policyVersion).toBe(sha256File(path.join(root, 'tdd-e2e.config.json')));
  expect(refDisc.policyVersion).not.toBe(wt.policyVersion); // ref 内容哈希 ≠ 工作树哈希

  // ref 内无 tdd-e2e.config.json 时命令发现按 ref 内 package.json 走（不受工作树篡改）
  const refPkgOnly = discoverCommand({ projectRoot: root, policyRef: 'origin/main', changeMetadata: {} });
  expect(refPkgOnly.source).toBe('config'); // ref 里 config 在，先命中
  const pkgSha = sha256Buf(gitShowBuf(root, 'origin/main', 'package.json'));
  expect(pkgSha).not.toBe(sha256File(path.join(root, 'package.json')));
});

it('policyRef 不可解析 → fail-closed 抛错（不静默降级 working-tree）', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'e2e-gate-ref-'));
  tempDirs.push(root);
  fs.writeFileSync(path.join(root, 'tdd-e2e.config.json'), JSON.stringify({ command: 'cmd' }));
  execSync('git init -q -b main', { cwd: root });
  execSync('git add -A', { cwd: root });
  execSync('git -c user.email=t@t -c user.name=t commit -qm init', { cwd: root });

  for (const fn of [
    () => loadProjectConfig(root, { policyRef: 'no-such-ref' }),
    () => discoverCommand({ projectRoot: root, policyRef: 'no-such-ref' }),
  ]) {
    let err: { code?: string } | undefined;
    try {
      fn();
    } catch (e) {
      err = e as { code?: string };
    }
    expect(err?.code).toBe('invalid-config');
  }
});

// ---------- e2e-gate 运行协议 ----------

it('fail-closed: 命令链全空且无豁免 → exit 1 且 JSON 报 no-command', async () => {
  // 临时项目无 tdd-e2e.config.json、无 package.json test:e2e、change 无 x-tdd-e2e.command
  const proj = makeProject();
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('no-command');
});

it('timeout = red (exit 124)', async () => {
  // config command: "node -e 'setTimeout(()=>{},60000)'"，gate --timeout 1000
  const proj = makeProject({ config: { command: "node -e 'setTimeout(()=>{},60000)'" } });
  const r = await runGate(['--change', 'c1', '--project', proj, '--timeout', '1000']);
  expect(r.code).toBe(124);
  expect(JSON.parse(r.stdout).exitCode).toBe(124);
});

it('authority 仅记录：改 --authority 不改变同一次运行的判定 (gpt P2-2)', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const a = await runGate(['--change', 'c1', '--project', proj, '--authority', 'local']);
  const b = await runGate(['--change', 'c1', '--project', proj, '--authority', 'ci']);
  expect(a.code).toBe(b.code); // 都 exit 0（绿命令）
  expect(a.code).toBe(0);
  expect(JSON.parse(a.stdout).authority).toBe('local');
  expect(JSON.parse(b.stdout).authority).toBe('ci'); // 仅记录字段不同
});

it('authority 默认：env.CI 为真 → ci，否则 local；--authority 显式优先于 env.CI', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const ci = await runGate(['--change', 'c1', '--project', proj], { CI: 'true' });
  expect(JSON.parse(ci.stdout).authority).toBe('ci');
  const local = await runGate(['--change', 'c1', '--project', proj]);
  expect(JSON.parse(local.stdout).authority).toBe('local');
  const over = await runGate(['--change', 'c1', '--project', proj, '--authority', 'local'], { CI: 'true' });
  expect(JSON.parse(over.stdout).authority).toBe('local');
});

it('command 优先级：config > package.json test:e2e > change 级 x- 键（仅提示）', async () => {
  // 三级分别断言 source 字段（并用 marker 文件证明实际执行的是命中源的命令）
  const p1 = makeProject({
    config: { command: marker('config') },
    pkg: { scripts: { 'test:e2e': marker('pkg') } },
    meta: `schema: tdd-driven\nx-tdd-e2e.command: ${marker('change')}\n`,
  });
  const r1 = await runGate(['--change', 'c1', '--project', p1]);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  expect(j1.commandSource).toBe('config');
  expect(fs.readFileSync(path.join(p1, 'ran.txt'), 'utf8')).toBe('config');
  expect(j1.policyVersion).toBe(sha256File(path.join(p1, 'tdd-e2e.config.json')));

  const p2 = makeProject({
    pkg: { scripts: { 'test:e2e': marker('pkg') } },
    meta: `schema: tdd-driven\nx-tdd-e2e.command: ${marker('change')}\n`,
  });
  const r2 = await runGate(['--change', 'c1', '--project', p2]);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.commandSource).toBe('package-json');
  expect(fs.readFileSync(path.join(p2, 'ran.txt'), 'utf8')).toBe('pkg');
  expect(j2.policyVersion).toBe(sha256File(path.join(p2, 'package.json')));

  const p3 = makeProject({ meta: `schema: tdd-driven\nx-tdd-e2e.command: ${marker('change')}\n` });
  const r3 = await runGate(['--change', 'c1', '--project', p3]);
  expect(r3.code).toBe(0);
  const j3 = JSON.parse(r3.stdout);
  expect(j3.commandSource).toBe('change-metadata');
  expect(fs.readFileSync(path.join(p3, 'ran.txt'), 'utf8')).toBe('change');
  expect(j3.policyVersion).toBeNull();
});

it('--policy-ref：命令与策略标识取受信 ref，工作树篡改不生效（契约一）', async () => {
  const proj = makeProject({ pkg: { scripts: { 'test:e2e': marker('ref') } } });
  const head = execSync('git rev-parse HEAD', { cwd: proj, encoding: 'utf8' }).trim();
  execSync(`git update-ref refs/remotes/origin/main ${head}`, { cwd: proj });
  // 工作树把 test:e2e 改成另一个命令（未提交）——受信 ref 解析应完全无视
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': marker('worktree') } }));

  const r = await runGate(['--change', 'c1', '--project', proj, '--policy-ref', 'origin/main']);
  expect(r.code, r.stderr).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.command).toBe(marker('ref'));
  expect(j.commandSource).toBe('package-json');
  expect(j.policySource).toBe('ref:origin/main');
  expect(j.policyVersion).toBe(sha256Buf(gitShowBuf(proj, 'origin/main', 'package.json'))); // policyVersion = ref 内容哈希
  expect(fs.readFileSync(path.join(proj, 'ran.txt'), 'utf8')).toBe('ref'); // 真跑的是 ref 版命令
});

it('--policy-ref 缺省不设 = working-tree（本地 advisory）；显式 ref 不可解析 → exit 2 invalid-args', async () => {
  const proj = makeProject({ pkg: { scripts: { 'test:e2e': marker('worktree') } } });
  const head = execSync('git rev-parse HEAD', { cwd: proj, encoding: 'utf8' }).trim();
  execSync(`git update-ref refs/remotes/origin/main ${head}`, { cwd: proj }); // 即便 origin/main 可解析
  fs.writeFileSync(path.join(proj, 'package.json'), JSON.stringify({ scripts: { 'test:e2e': marker('worktree2') } }));

  const r = await runGate(['--change', 'c1', '--project', proj]);
  expect(r.code, r.stderr).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.policySource).toBe('working-tree'); // gate 缺省不自动取 ref
  expect(j.policyVersion).toBe(sha256File(path.join(proj, 'package.json')));
  expect(fs.readFileSync(path.join(proj, 'ran.txt'), 'utf8')).toBe('worktree2');

  const bad = await runGate(['--change', 'c1', '--project', proj, '--policy-ref', 'no-such-ref']);
  expect(bad.code).toBe(2);
  expect(JSON.parse(bad.stdout).error).toBe('invalid-args');
});

it('produces 声明但缺应交制品 → 失败', async () => {
  // config produces: ["dist/app.js"]，命令不产 → exit 1
  const proj = makeProject({
    config: { command: 'node -e "process.exit(0)"', produces: ['dist/app.js'] },
  });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  const j = JSON.parse(r.stdout);
  expect(j.error).toBe('missing-produces');
  expect(j.missing).toEqual(['dist/app.js']);
});

it('绿 + collect → 制品清单（文件名+sha256+大小）', async () => {
  const proj = makeProject({
    config: {
      command: `node -e "require('fs').mkdirSync('dist',{recursive:true});require('fs').writeFileSync('dist/app.js','hello')"`,
      produces: ['dist/app.js'],
      collect: ['dist/*'],
    },
  });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.error).toBeUndefined();
  expect(j.artifacts).toEqual([
    { file: 'dist/app.js', sha256: createHash('sha256').update('hello').digest('hex'), size: 5 },
  ]);
  // staging 记录落地（清单本体走 --json，evidence.md 投影由 finalize 组装）
  const rec = JSON.parse(fs.readFileSync(stagingFile(proj, j.runId), 'utf8'));
  expect(rec.exitCode).toBe(0);
  expect(rec.runId).toBe(j.runId);
});

it('前后指纹不一致 → stale-inputs 作废（exit 1）', async () => {
  const proj = makeProject({
    config: { command: `node -e "require('fs').appendFileSync('src/a.ts','// touched')"` },
  });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  const j = JSON.parse(r.stdout);
  expect(j.error).toBe('stale-inputs');
  expect(j.inputKeyBefore).not.toBe(j.inputKeyAfter);
  const rec = JSON.parse(fs.readFileSync(stagingFile(proj, j.runId), 'utf8'));
  expect(rec.exitCode).toBe(1);
  expect(rec.summary).toContain('stale-inputs');
});

it('命令不存在 → 非零退出（shell 127，不装绿）', async () => {
  const proj = makeProject({ config: { command: 'no-such-command-xyz-12345' } });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(127);
  expect(JSON.parse(r.stdout).exitCode).toBe(127);
});

it('staging 写失败 → exit 1 且 JSON 报 staging-failed', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  fs.writeFileSync(path.join(proj, 'openspec', 'changes', 'c1', 'evidence'), 'not a dir');
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('staging-failed');
});

it('change 目录不存在 → fail-closed exit 1 且 JSON 报 change-not-found', () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  fs.rmSync(path.join(proj, 'openspec', 'changes', 'c1'), { recursive: true, force: true });
  const r = runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('change-not-found');
});

it('绿运行 staging 记录字段齐全，policyVersion = 命中策略文件内容 hash', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r = await runGate(['--change', 'c1', '--project', proj, '--timeout', '5000']);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.command).toBe('node -e "process.exit(0)"');
  const rec = JSON.parse(fs.readFileSync(stagingFile(proj, j.runId), 'utf8'));
  expect(rec.runId).toBe(j.runId);
  expect(rec.exitCode).toBe(0);
  expect(typeof rec.summary).toBe('string');
  expect(rec.inputKeyBefore).toBe(rec.inputKeyAfter);
  expect(rec.authority).toBe('local');
  expect(rec.commandSource).toBe('config');
  expect(Date.parse(rec.timestamp)).not.toBeNaN();
  expect(rec.timeoutMs).toBe(5000);
  expect(rec.policyVersion).toBe(sha256File(path.join(proj, 'tdd-e2e.config.json')));
});

it('豁免：命令链全空但 config.skipApproved → exit 0 status skipped', async () => {
  const proj = makeProject({ config: { skipApproved: true } });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(j.status).toBe('skipped');
  expect(j.skipSource).toBe('config');
});

it('豁免：change 级 x-tdd-e2e.skip 需 reason；无 reason 仍 fail-closed no-command', async () => {
  const withReason = makeProject({
    meta: 'schema: tdd-driven\nx-tdd-e2e.skip: true\nx-tdd-e2e.skip_reason: upstream flake\n',
  });
  const r1 = await runGate(['--change', 'c1', '--project', withReason, '--json']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  expect(j1.status).toBe('skipped');
  expect(j1.skipSource).toBe('change-metadata');

  const noReason = makeProject({ meta: 'schema: tdd-driven\nx-tdd-e2e.skip: true\n' });
  const r2 = await runGate(['--change', 'c1', '--project', noReason, '--json']);
  expect(r2.code).toBe(1);
  expect(JSON.parse(r2.stdout).error).toBe('no-command');
});

it('--rerun 与默认同协议：绿 → exit 0 且 staging 落地', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r = await runGate(['--change', 'c1', '--project', proj, '--rerun', '--json']);
  expect(r.code).toBe(0);
  const j = JSON.parse(r.stdout);
  expect(fs.existsSync(stagingFile(proj, j.runId))).toBe(true);
});

it('非法 tdd-e2e.config.json → fail-closed exit 1 且 JSON 报 invalid-config', async () => {
  const proj = makeProject({ config: '{ not json' });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('invalid-config');
});

it('非法 package.json（config 无 command 时才读）→ fail-closed invalid-package-json；config 有 command 则不读', async () => {
  const broken = makeProject({ pkg: '{ not json', meta: `schema: tdd-driven\nx-tdd-e2e.command: ${marker('change')}\n` });
  const r = await runGate(['--change', 'c1', '--project', broken, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('invalid-package-json');

  const withCmd = makeProject({ config: { command: marker('config') }, pkg: '{ not json' });
  const r2 = await runGate(['--change', 'c1', '--project', withCmd, '--json']);
  expect(r2.code).toBe(0);
  expect(JSON.parse(r2.stdout).commandSource).toBe('config');
});

it('空白 config command 视为未配置（不装绿）→ 落到下一级或 no-command', async () => {
  const proj = makeProject({ config: { command: '   ' } });
  const r = await runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('no-command');
});

it('非 git 项目（前指纹失败）→ fail-closed exit 1 且 JSON 报 fingerprint-failed', () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  fs.rmSync(path.join(proj, '.git'), { recursive: true, force: true });
  const r = runGate(['--change', 'c1', '--project', proj, '--json']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('fingerprint-failed');
});

it('非法 --authority 取值 → usage 错误 exit 2', () => {
  const proj = makeProject();
  const r = runGate(['--change', 'c1', '--project', proj, '--authority', 'boss']);
  expect(r.code).toBe(2);
  expect(JSON.parse(r.stdout).error).toBe('invalid-args');
});

it('缺 --change → usage 错误 exit 2', () => {
  const proj = makeProject();
  const r = spawnSync(process.execPath, [gateScript, '--project', proj, '--json'], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '' },
  });
  expect(r.status).toBe(2);
  expect(JSON.parse(r.stdout ?? '').error).toBe('invalid-args');
});

it('非 --json 模式：人类可读单行输出 + 相同退出码', () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r = spawnSync(process.execPath, [gateScript, '--change', 'c1', '--project', proj], {
    encoding: 'utf-8',
    env: { ...process.env, CI: '' },
  });
  expect(r.status).toBe(0);
  expect(r.stdout).toContain('PASS');
});

// ---------- --finalize 幂等收尾与 bundle 发布（E1 生命周期） ----------

const changeDirOf = (root: string): string => path.join(root, 'openspec', 'changes', 'c1');
const bundleDirOf = (root: string, runId: string): string =>
  path.join(changeDirOf(root), 'evidence', 'runs', runId);
const lockFileOf = (root: string): string => path.join(changeDirOf(root), 'evidence', '.run-lock');

it('同键重复 finalize 复用既有 bundle，不产生新 run', async () => {
  const proj = makeProject({ config: { command: `node -e "require('fs').appendFileSync('runs.log','x')"` } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  expect(j1.reused).toBe(false);
  expect(j1.state).toBe('local-finalized');

  // bundle 关键文件齐：e2e-result.json（含 contentHash/policyVersion/inputKeyHash）+ 人读报告
  const bundle = bundleDirOf(proj, j1.runId);
  expect(fs.existsSync(path.join(bundle, 'evidence.md'))).toBe(true);
  const rec = JSON.parse(fs.readFileSync(path.join(bundle, 'e2e-result.json'), 'utf8'));
  expect(typeof rec.contentHash).toBe('string');
  expect(typeof rec.inputKeyHash).toBe('string');
  expect(rec.policyVersion).toBe(sha256File(path.join(proj, 'tdd-e2e.config.json')));
  // 三段入键可审计（裁定：记录三段各自的 hash）：
  // 内容段 = sha256(指纹 ⊕ 规划面)；组合键 = sha256(内容段 ⊕ 策略)
  const H = (s: string) => createHash('sha256').update(s).digest('hex');
  expect(typeof rec.planningHash).toBe('string');
  expect(rec.contentHash).toBe(H(`${rec.inputKeyBefore}\0${rec.planningHash}`));
  expect(rec.inputKeyHash).toBe(H(`${rec.contentHash}\0${rec.policyVersion}`));

  // 顶层 evidence.md 人读投影：模板五节 + 引用 runId
  const md = fs.readFileSync(path.join(changeDirOf(proj), 'evidence.md'), 'utf8');
  for (const sec of ['## 台账回填', '## e2e 摘要', '## 失败清单', '## 制品清单', '## 豁免标记']) {
    expect(md).toContain(sec);
  }
  expect(md).toContain(j1.runId);

  // run lock 收尾即释放（不留半态）
  expect(fs.existsSync(lockFileOf(proj))).toBe(false);

  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).toBe(j1.runId);
  expect(j2.reused).toBe(true);
  // 不重跑不重发：命令只执行过一次（副作用计数证明）
  expect(fs.readFileSync(path.join(proj, 'runs.log'), 'utf8')).toBe('x');
});

it('输入变化后重跑 → 新 run（键变）', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);

  fs.writeFileSync(path.join(proj, 'src', 'a.ts'), 'export const a = 2;\n');
  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).not.toBe(j1.runId);
  expect(j2.reused).toBe(false);
  expect(j2.inputKeyHash).not.toBe(j1.inputKeyHash);
});

it('同键损坏 bundle 不复用 → 重建', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  const bundle = bundleDirOf(proj, j1.runId);

  fs.rmSync(path.join(bundle, 'e2e-result.json')); // 关键文件缺失 → 损坏
  expect(verifyBundle(bundle, j1.inputKeyHash)).toEqual({
    complete: false, success: false, manifestOk: false, reusable: false,
  });

  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).not.toBe(j1.runId);
  expect(j2.reused).toBe(false);
  expect(fs.existsSync(path.join(bundleDirOf(proj, j2.runId), 'e2e-result.json'))).toBe(true);
});

it('红灯 bundle 不复用（exit≠0）', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(1)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(1);
  const j1 = JSON.parse(r1.stdout);
  expect(j1.exitCode).toBe(1);

  // 红灯照常落地 bundle（诊断价值），但不满足复用条件
  const bundle = bundleDirOf(proj, j1.runId);
  expect(fs.existsSync(path.join(bundle, 'e2e-result.json'))).toBe(true);
  expect(verifyBundle(bundle, j1.inputKeyHash)).toEqual({
    complete: true, success: false, manifestOk: true, reusable: false,
  });

  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(1);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).not.toBe(j1.runId);
  expect(j2.reused).toBe(false);
});

it('发布前中断不留半态：staging 残留被清理，再次 finalize 成功', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  // 预置脏 staging（模拟发布前进程中断的残留）
  const dirty = path.join(changeDirOf(proj), 'evidence', '.staging', 'interrupted-run', 'e2e-result.json');
  fs.mkdirSync(path.dirname(dirty), { recursive: true });
  fs.writeFileSync(dirty, '{"half":"written"}');

  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  expect(fs.existsSync(path.dirname(dirty))).toBe(false); // 残留被清理
  expect(fs.readdirSync(path.join(changeDirOf(proj), 'evidence', '.staging'))).toEqual([]); // 无半态
  expect(fs.existsSync(path.join(bundleDirOf(proj, j1.runId), 'e2e-result.json'))).toBe(true);

  // 再次 finalize 成功且幂等（恢复 = 复用）
  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  expect(JSON.parse(r2.stdout).runId).toBe(j1.runId);
});

it('仅元数据变化（键含元数据）→ 新 run', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);

  // 仅改 .openspec.yaml 元数据字段：业务内容指纹不变，但元数据进组合键 → 键变 → 新 run
  fs.appendFileSync(path.join(changeDirOf(proj), '.openspec.yaml'), 'created: 2026-11-26\n');
  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).not.toBe(j1.runId);
  expect(j2.reused).toBe(false);
  expect(j2.inputKeyBefore).toBe(j1.inputKeyBefore); // 业务指纹不变（openspec/changes/ 排除）
  expect(j2.planningHash).not.toBe(j1.planningHash); // .openspec.yaml 属规划面
  expect(j2.contentHash).not.toBe(j1.contentHash);   // 元数据进入内容 hash
  expect(j2.inputKeyHash).not.toBe(j1.inputKeyHash); // 组合键随之变
});

// 设计 §6.3 本地硬路径冻结：台账（tests/）与 delta（specs/）一并进组合键——
// 改台账/delta 后复用旧 bundle = 陈旧证据（E2 快照复验会漏），故必须键变不复用。
it.each([
  { label: 'tests/ 台账', rel: ['tests', 'ledger.md'] },
  { label: 'specs/ delta', rel: ['specs', 'delta.md'] },
])('规划面变化（$label 任一行）→ 指纹不变但组合键变 → 不复用旧 bundle，新 run', async ({ rel }) => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const changeDir = changeDirOf(proj);
  const target = path.join(changeDir, ...rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, 'line-1\nline-2\n');

  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  expect(j1.reused).toBe(false);
  expect(typeof j1.planningHash).toBe('string');

  // 绿 bundle 落地后修改台账/delta 任一行
  fs.writeFileSync(target, 'line-1\nline-2-modified\n');
  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).not.toBe(j1.runId);             // 键变不复用 → 新 run
  expect(j2.reused).toBe(false);
  expect(j2.inputKeyBefore).toBe(j1.inputKeyBefore); // 裸指纹不变（openspec/changes/ 被排除）
  expect(j2.planningHash).not.toBe(j1.planningHash); // 规划面入键
  expect(j2.contentHash).not.toBe(j1.contentHash);
  expect(j2.inputKeyHash).not.toBe(j1.inputKeyHash);
});

it('绿检查后移动 bundle 任一文件 → 旧检查不可放行（键含 bundle 路径外输入）', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  const bundle = bundleDirOf(proj, j1.runId);

  // 移动 bundle 内任一文件（落点仍在 change 的 evidence/ 内 → 不入键）
  fs.renameSync(
    path.join(bundle, 'e2e-result.json'),
    path.join(changeDirOf(proj), 'evidence', 'moved-e2e-result.json'),
  );
  expect(verifyBundle(bundle, j1.inputKeyHash).reusable).toBe(false); // 旧检查不可放行

  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).not.toBe(j1.runId); // 损坏 → 重建
  expect(j2.reused).toBe(false);
  // 键含 bundle 路径外输入：移动 bundle 文件本身不改变组合键
  expect(j2.inputKeyHash).toBe(j1.inputKeyHash);
});

it('两态语义：bundle 未提交 = 本地收尾完成；提交后 = 已提交待 CI 验收（复用同 run）', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  expect(j1.state).toBe('local-finalized');

  execSync('git add -A && git -c user.email=t@t -c user.name=t commit -qm finalize-bundle', { cwd: proj });
  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  const j2 = JSON.parse(r2.stdout);
  expect(j2.runId).toBe(j1.runId); // 提交不改输入键 → 复用
  expect(j2.reused).toBe(true);
  expect(j2.state).toBe('committed-pending-ci');
});

it('run lock 被持有 → finalize fail-closed exit 1 且不释放他人锁', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  fs.mkdirSync(path.dirname(lockFileOf(proj)), { recursive: true });
  fs.writeFileSync(lockFileOf(proj), 'other-process');

  const r = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r.code).toBe(1);
  expect(JSON.parse(r.stdout).error).toBe('run-locked');
  expect(fs.readFileSync(lockFileOf(proj), 'utf8')).toBe('other-process'); // 不动他人的锁

  fs.rmSync(lockFileOf(proj)); // 持有者释放后可正常收尾
  const r2 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r2.code).toBe(0);
  expect(JSON.parse(r2.stdout).reused).toBe(false);
});

it('缺 --change 的 --finalize → usage 错误 exit 2', () => {
  const proj = makeProject();
  const r = runGate(['--project', proj, '--finalize']);
  expect(r.code).toBe(2);
  expect(JSON.parse(r.stdout).error).toBe('invalid-args');
});

// ---------- bundle 台账快照（契约二：finalize 发布时 <changeDir>/tests/** 拷入 run bundle） ----------

it('finalize 发布的 bundle 内含台账快照：tests/** 逐字节拷入 + 可枚举清单', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const changeDir = changeDirOf(proj);
  fs.mkdirSync(path.join(changeDir, 'tests'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tests', 'ledger.md'), '# ledger\n');
  fs.mkdirSync(path.join(changeDir, 'tests', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(changeDir, 'tests', 'sub', 'more.md'), 'more\n');

  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  const bundle = bundleDirOf(proj, j1.runId);
  expect(fs.readFileSync(path.join(bundle, 'tests', 'ledger.md'), 'utf8')).toBe('# ledger\n'); // 台账快照随行可审计
  expect(fs.readFileSync(path.join(bundle, 'tests', 'sub', 'more.md'), 'utf8')).toBe('more\n');
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'tests', '.ledger-snapshot.json'), 'utf8'));
  expect(manifest.files).toEqual(['ledger.md', 'sub/more.md']); // 契约二：台账快照可枚举
  expect(verifyBundle(bundle, j1.inputKeyHash).reusable).toBe(true); // 快照在 → complete
});

it('无 tests/ 的 change 同样落台账快照占位（空快照清单，complete 不因缺台账而塌）', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  const bundle = bundleDirOf(proj, j1.runId);
  const manifest = JSON.parse(fs.readFileSync(path.join(bundle, 'tests', '.ledger-snapshot.json'), 'utf8'));
  expect(manifest.files).toEqual([]);
  expect(verifyBundle(bundle, j1.inputKeyHash)).toEqual({
    complete: true, success: true, manifestOk: true, reusable: true,
  });
});

it('verifyBundle：complete 判定纳入台账快照存在性（缺 tests/ 快照 = 不完整不可复用）', async () => {
  const proj = makeProject({ config: { command: 'node -e "process.exit(0)"' } });
  const r1 = await runGate(['--change', 'c1', '--project', proj, '--finalize']);
  expect(r1.code).toBe(0);
  const j1 = JSON.parse(r1.stdout);
  const bundle = bundleDirOf(proj, j1.runId);
  fs.rmSync(path.join(bundle, 'tests'), { recursive: true, force: true }); // 摘除台账快照（手工构造残缺 bundle）
  expect(verifyBundle(bundle, j1.inputKeyHash)).toEqual({
    complete: false, success: false, manifestOk: false, reusable: false,
  });
});
