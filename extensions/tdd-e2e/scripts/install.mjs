#!/usr/bin/env node
/**
 * install.mjs — tdd-e2e 扩展安装器（交付面，Task 7）。
 *
 * 用法：node install.mjs --project <root>
 *
 * 安装模型（对齐 experience-loop install.mjs 先例）：一次性完成两件落位，
 * 消费者无需 vendor 扩展目录——
 *   1. schema/ → <root>/openspec/schemas/tdd-driven/（内容一致 → 幂等跳过；
 *      已存在且内容不同 → 覆盖式刷新：schema 是扩展分发的静态面，漂移即过期，
 *      与 experience-lint"运行时唯一路径"同原则）
 *   2. scripts/{e2e-gate.mjs,e2e-lint.mjs,lib/} → <root>/openspec/tdd-e2e/（覆盖式更新）
 *   install.mjs 自身不落位（安装器不是运行时脚本）。
 * 并输出 config.yaml 建议片段（含 guidance: 层形状与"（仅 tdd-driven change 适用）"
 * 限定语，对齐设计 §6.2；不自动改 config——策展区归人）。
 *
 * fail-closed：源目录缺失（schema/ 或 scripts/ 不在）→ 报错明确、exit 1、不写任何文件。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 运行时脚本（排除安装器自身）：e2e-gate.mjs、e2e-lint.mjs 与共享 lib/。 */
const RUNTIME_FILES = [
  'e2e-gate.mjs',
  'e2e-lint.mjs',
  'lib/bundle.mjs',
  'lib/config.mjs',
  'lib/fingerprint.mjs',
];

const GUIDANCE = [
  '建议粘贴进 openspec/config.yaml（人工策展，install 不自动改 config）：',
  '',
  'operations:',
  '  apply:',
  '    guidance:',
  '      - （仅 tdd-driven change 适用）任务全勾后运行 node openspec/tdd-e2e/e2e-gate.mjs --finalize --change <name>，红灯不得宣告完成',
  '  archive:',
  '    guidance:',
  '      - （仅 tdd-driven change 适用）归档走受管入口 node openspec/tdd-e2e/e2e-lint.mjs --archive-gate --change <name> --execute，未过判定不得归档',
  '',
  '提示：config.yaml 注入不按 schema 过滤——guidance 会进入所有 change 的 apply/archive 流程，',
  '故每条文本以"（仅 tdd-driven change 适用）"开头；主承载在 tdd-driven schema instruction。',
].join('\n');

function parseArgs(argv) {
  const out = { project: undefined };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') {
      out.project = argv[++i];
      if (out.project === undefined) {
        console.error('install: --project 需要一个值');
        process.exit(2);
      }
    } else {
      console.error(`install: 未知参数 ${a}`);
      process.exit(2);
    }
  }
  return out;
}

async function exists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

async function listFiles(dir, prefix = '') {
  const out = new Map();
  for (const e of await fs.readdir(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.isDirectory()) {
      for (const [k, v] of await listFiles(path.join(dir, e.name), rel)) out.set(k, v);
    } else {
      out.set(rel, path.join(dir, e.name));
    }
  }
  return out;
}

async function dirEquals(a, b) {
  if (!(await exists(b))) return false;
  const fa = await listFiles(a);
  const fb = await listFiles(b);
  if (fa.size !== fb.size) return false;
  for (const [rel, pa] of fa) {
    const pb = fb.get(rel);
    if (pb === undefined) return false;
    if ((await fs.readFile(pa, 'utf-8')) !== (await fs.readFile(pb, 'utf-8'))) return false;
  }
  return true;
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  for (const [rel, pa] of await listFiles(src)) {
    const pb = path.join(dest, rel);
    await fs.mkdir(path.dirname(pb), { recursive: true });
    await fs.copyFile(pa, pb);
  }
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const root = path.resolve(opt.project ?? process.cwd());

  // 源守卫（fail-closed）：schema/ 与运行时脚本必须齐，缺任一 → 报错明确、不写任何文件
  const schemaSrc = path.join(extRoot, 'schema');
  const scriptsSrc = path.join(extRoot, 'scripts');
  if (!(await exists(schemaSrc))) {
    console.error(`install: 源目录缺失：${schemaSrc}（扩展包不完整：schema/ 不存在）`);
    process.exit(1);
  }
  const missingScripts = [];
  for (const f of RUNTIME_FILES) {
    if (!(await exists(path.join(scriptsSrc, f)))) missingScripts.push(f);
  }
  if (missingScripts.length > 0) {
    console.error(`install: 源目录缺失：${scriptsSrc} 下缺 ${missingScripts.join(', ')}（扩展包不完整）`);
    process.exit(1);
  }

  // 1. schema → openspec/schemas/tdd-driven/
  const schemaDest = path.join(root, 'openspec', 'schemas', 'tdd-driven');
  if (await dirEquals(schemaSrc, schemaDest)) {
    console.log('schema: 已是最新，跳过');
  } else {
    await fs.rm(schemaDest, { recursive: true, force: true });
    await copyDir(schemaSrc, schemaDest);
    console.log('schema: 已安装到 openspec/schemas/tdd-driven/');
  }

  // 2. 运行时脚本 → openspec/tdd-e2e/（覆盖式更新；install.mjs 自身不落位）
  const scriptsDest = path.join(root, 'openspec', 'tdd-e2e');
  await fs.mkdir(scriptsDest, { recursive: true });
  for (const f of RUNTIME_FILES) {
    await fs.mkdir(path.dirname(path.join(scriptsDest, f)), { recursive: true });
    await fs.copyFile(path.join(scriptsSrc, f), path.join(scriptsDest, f));
  }
  console.log('scripts: 已安装到 openspec/tdd-e2e/（e2e-gate.mjs、e2e-lint.mjs、lib/，覆盖式更新）');

  // 3. config 建议片段（不自动改 config）
  console.log('\n' + GUIDANCE);
}

main();
