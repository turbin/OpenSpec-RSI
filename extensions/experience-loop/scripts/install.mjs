#!/usr/bin/env node
/**
 * install.mjs — experience-loop 扩展安装器。
 *
 * 用法：node install.mjs [--project <root>] [--force]
 *
 * 安装模型：一次性完成三件落位，消费者无需 vendor 扩展目录——
 *   1. schema/ → <root>/openspec/schemas/experience-loop/（已存在且内容不同则跳过覆盖，--force 强制覆盖）
 *   2. experience-store/{README.md,_template.md,INDEX.md} → <root>/openspec/experience/（已存在则跳过）
 *   3. scripts/experience-lint.mjs → <root>/openspec/experience/experience-lint.mjs（运行时唯一路径，覆盖式更新）
 * 并输出 config guidance 建议片段（不自动改 config——策展区归人）。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const extRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const out = { project: undefined, force: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') out.project = argv[++i];
    else if (a === '--force') out.force = true;
    else {
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

const GUIDANCE = [
  '建议粘贴进 openspec/config.yaml（人工策展，install 不自动改 config）：',
  '',
  'operations:',
  '  archive:',
  '    guidance:',
  '      - 归档前运行 node openspec/experience/experience-lint.mjs --project <root> --change <name>，非零退出则停止归档；输出向用户展示，不写入任何工件',
].join('\n');

async function main() {
  const opt = parseArgs(process.argv.slice(2));
  const root = path.resolve(opt.project ?? process.cwd());

  // 1. schema
  const schemaSrc = path.join(extRoot, 'schema');
  const schemaDest = path.join(root, 'openspec', 'schemas', 'experience-loop');
  if (await dirEquals(schemaSrc, schemaDest)) {
    console.log('schema: 已是最新，跳过');
  } else if (await exists(schemaDest)) {
    if (opt.force) {
      await fs.rm(schemaDest, { recursive: true, force: true });
      await copyDir(schemaSrc, schemaDest);
      console.log('schema: 已覆盖（--force）');
    } else {
      console.log('schema: 目标已存在且内容不同 — 跳过覆盖（--force 可覆盖）');
    }
  } else {
    await copyDir(schemaSrc, schemaDest);
    console.log('schema: 已安装到 openspec/schemas/experience-loop/');
  }

  // 2. 经验库文件（已存在则跳过）
  const expDir = path.join(root, 'openspec', 'experience');
  await fs.mkdir(expDir, { recursive: true });
  for (const f of ['README.md', '_template.md', 'INDEX.md']) {
    const dest = path.join(expDir, f);
    if (await exists(dest)) {
      console.log(`experience: ${f} 已存在，跳过`);
    } else {
      await fs.copyFile(path.join(extRoot, 'experience-store', f), dest);
      console.log(`experience: ${f} 已初始化`);
    }
  }

  // 3. lint 脚本（覆盖式更新，运行时唯一路径）
  await fs.copyFile(
    path.join(extRoot, 'scripts', 'experience-lint.mjs'),
    path.join(expDir, 'experience-lint.mjs')
  );
  console.log('lint: 已安装到 openspec/experience/experience-lint.mjs（覆盖式更新）');
  // 3b. recheck.mjs（lint 依赖的共享机制模块；缺则已装 lint import 崩）
  await fs.copyFile(
    path.join(extRoot, 'scripts', 'recheck.mjs'),
    path.join(expDir, 'recheck.mjs')
  );
  console.log('recheck: 已安装到 openspec/experience/recheck.mjs');

  // 4. guidance 建议片段
  console.log('\n' + GUIDANCE);
}

main();
