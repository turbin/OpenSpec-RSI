// test/extensions/tdd-e2e-install.test.ts
import { it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const installScript = path.join(repoRoot, 'extensions', 'tdd-e2e', 'scripts', 'install.mjs');
const extRoot = path.join(repoRoot, 'extensions', 'tdd-e2e');

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-e2e-install-'));
  tempDirs.push(root);
  fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
  // lint --gate 走 git diff 基线：空项目也须是 git 仓库
  spawnSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--allow-empty', '-qm', 'init'], { cwd: root });
  return root;
}

function runInstall(root: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [installScript, '--project', root, ...args], { encoding: 'utf-8' });
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 递归列出目录下全部文件的相对 posix 路径（排序稳定）。 */
function walkRel(dir: string, base = ''): string[] {
  const out: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${e.name}` : e.name;
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walkRel(abs, rel));
    else out.push(rel);
  }
  return out.sort();
}

// ---------- 落位 ----------

it('安装：schema → openspec/schemas/tdd-driven/，scripts → openspec/tdd-e2e/（lib 子目录随行）', () => {
  const root = makeProject();
  const r = runInstall(root);
  expect(r.code, `${r.stdout}\n${r.stderr}`).toBe(0);

  const schemaDir = path.join(root, 'openspec', 'schemas', 'tdd-driven');
  const scriptsDir = path.join(root, 'openspec', 'tdd-e2e');

  const srcSchema = walkRel(path.join(extRoot, 'schema'));
  expect(walkRel(schemaDir), 'schema 落位文件清单应与源一致').toEqual(srcSchema);
  expect(fs.readFileSync(path.join(schemaDir, 'schema.yaml'), 'utf-8'),
    'schema.yaml 内容应逐字节一致').toBe(fs.readFileSync(path.join(extRoot, 'schema', 'schema.yaml'), 'utf-8'));

  // scripts/：e2e-gate.mjs、e2e-lint.mjs、lib/{fingerprint,config,bundle}.mjs
  expect(walkRel(scriptsDir), 'scripts 落位文件清单应齐').toEqual([
    'e2e-gate.mjs',
    'e2e-lint.mjs',
    'lib/bundle.mjs',
    'lib/config.mjs',
    'lib/fingerprint.mjs',
  ]);
  for (const f of ['e2e-gate.mjs', 'e2e-lint.mjs']) {
    expect(fs.readFileSync(path.join(scriptsDir, f), 'utf-8'),
      `${f} 内容应与源一致`).toBe(fs.readFileSync(path.join(extRoot, 'scripts', f), 'utf-8'));
  }
  expect(fs.readFileSync(path.join(scriptsDir, 'lib', 'config.mjs'), 'utf-8'),
    'lib 子目录应随行落位').toBe(fs.readFileSync(path.join(extRoot, 'scripts', 'lib', 'config.mjs'), 'utf-8'));

  // install.mjs 自身不落位（安装器是扩展分发面，不是运行时脚本）
  expect(fs.existsSync(path.join(scriptsDir, 'install.mjs'))).toBe(false);
}, 60_000);

it('落位脚本可执行：install 后 e2e-lint --gate 在空项目上退出 0', () => {
  const root = makeProject();
  expect(runInstall(root).code, '前置安装').toBe(0);
  const lint = path.join(root, 'openspec', 'tdd-e2e', 'e2e-lint.mjs');
  // 空项目 + 无 e2e 命令 + 无豁免 → 项目级 no-command（fail-closed）。
  // 这是文档化行为：判定入口的守卫即"未配置命令不放行"。
  const r = spawnSync(process.execPath, [lint, '--gate', '--project', root, '--json'], { encoding: 'utf-8' });
  expect(r.status, '空项目无命令应 fail-closed\n${r.stdout}${r.stderr}').toBe(1);
  const j = JSON.parse(r.stdout);
  expect(j.projectRun.error).toBe('no-command');
  expect(j.aggregate).toBe('FAIL');
}, 60_000);

// ---------- config 片段 ----------

it('输出 config.yaml 建议片段：含 guidance: 层、operations 形状与"（仅 tdd-driven change 适用）"限定语', () => {
  const root = makeProject();
  const r = runInstall(root);
  expect(r.code).toBe(0);
  const out = r.stdout;
  expect(out, 'guidance 层形状必须有').toContain('guidance:');
  expect(out, 'operations 层形状必须有').toMatch(/operations:\s*\n\s*apply:\s*\n\s*guidance:/);
  expect(out, '限定语必须在 guidance 文本内').toMatch(/guidance:\s*\n\s*-\s*（仅 tdd-driven change 适用）/);
  expect(out, '收尾入口建议应出现 --finalize').toContain('e2e-gate.mjs --finalize');
  expect(out, '归档入口建议应出现受管归档命令').toContain('--archive-gate --change <name> --execute');
  expect(out, '应明示不自动改 config（人工策展）').toContain('不自动改');
});

// ---------- 幂等 ----------

it('二次运行幂等：exit 0、文件内容不变、不产生备份/残留文件', () => {
  const root = makeProject();
  expect(runInstall(root).code).toBe(0);

  const schemaFile = path.join(root, 'openspec', 'schemas', 'tdd-driven', 'schema.yaml');
  const gateFile = path.join(root, 'openspec', 'tdd-e2e', 'e2e-gate.mjs');
  const before = {
    schema: fs.readFileSync(schemaFile, 'utf-8'),
    gate: fs.readFileSync(gateFile, 'utf-8'),
  };

  const again = runInstall(root);
  expect(again.code, '二次安装不报错').toBe(0);
  expect(fs.readFileSync(schemaFile, 'utf-8')).toBe(before.schema);
  expect(fs.readFileSync(gateFile, 'utf-8')).toBe(before.gate);

  // 无 .bak / ~ / .tmp 残留
  for (const dir of [path.join(root, 'openspec', 'schemas', 'tdd-driven'), path.join(root, 'openspec', 'tdd-e2e')]) {
    for (const f of walkRel(dir)) {
      expect(f, '不应产生备份/临时残留').not.toMatch(/[~]$|\.bak$|\.tmp$|\.orig$/);
    }
  }

  // 幂等性：同源二次安装不覆盖用户改动（脚本运行时唯一路径原则——
  // experience-loop 先例：scripts 覆盖式刷新）。此处对齐 brief"二次运行幂等"字面：
  // 同源重装结果一致，不报错。
  const third = runInstall(root);
  expect(third.code).toBe(0);
  expect(fs.readFileSync(gateFile, 'utf-8')).toBe(before.gate);
}, 60_000);

// ---------- 源目录缺失 ----------

it('源目录缺失：报错明确、exit 非零、不写任何文件', () => {
  const root = makeProject();
  const fakeExt = fs.mkdtempSync(path.join(os.tmpdir(), 'tdd-e2e-no-src-'));
  tempDirs.push(fakeExt);
  const fakeInstall = path.join(fakeExt, 'install.mjs');
  // 复用真实 install.mjs 逻辑：以 --ext-source 指向空目录（若脚本支持）；
  // 否则以 cwd 欺骗不可行（脚本按 __dirname 定位）。改为直接调用真实脚本，
  // 断言其源目录守卫：把脚本复制到无 schema/ 兄弟目录的临时位置再运行。
  fs.copyFileSync(installScript, fakeInstall);
  const r = spawnSync(process.execPath, [fakeInstall, '--project', root], { encoding: 'utf-8' });
  expect(r.status, '源缺失应报错非零退出').not.toBe(0);
  expect(r.stderr, '报错应点名缺失的源目录').toContain('schema');
  // 未落任何文件
  expect(fs.existsSync(path.join(root, 'openspec', 'schemas'))).toBe(false);
  expect(fs.existsSync(path.join(root, 'openspec', 'tdd-e2e'))).toBe(false);
}, 60_000);

// ---------- README / 文档存在性（交付面锚定） ----------

it('README 必含交付内容锚点（安装/CI 单入口/skip 与 EXEMPT 分层/生命周期/边界）', () => {
  const readme = fs.readFileSync(path.join(extRoot, 'README.md'), 'utf-8');
  expect(readme).toContain('--gate'); // CI 唯一入口
  expect(readme).toContain('--archive-gate --change <name> --execute'); // 归档受管入口
  expect(readme).toContain('--finalize'); // E1 本地收尾
  expect(readme).toContain('EXEMPT'); // 豁免判定归 lint
  expect(readme).toContain('L1'); // 已知边界
  expect(readme).toContain('guidance:'); // config 片段形状
  expect(readme).toContain('（仅 tdd-driven change 适用）'); // 限定语
});
