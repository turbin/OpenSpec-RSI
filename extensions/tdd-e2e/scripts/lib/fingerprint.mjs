// extensions/tdd-e2e/scripts/lib/fingerprint.mjs
// 输入键 v1：git 跟踪文件 ∪ 显式 include 的内容 tree-hash（文本 EOL 归一化）。
// 零依赖：仅 node 内置模块（child_process / crypto / fs / path）。

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import path from 'node:path';

// change 内精确生成路径（相对 change 目录），对 openspec/changes/*/ 下所有 change 生效。
export const EXCLUDED_GENERATED = ['evidence/', 'deliverables/', '.staging/'];

// 规划目录前缀（相对 planningRoot）。
export const EXCLUDED_PLANNING = ['openspec/changes/', 'openspec/specs/', 'openspec/experience/'];

const TEXT_SNIFF_BYTES = 8192;

// 二进制扩展名清单（字节敏感，不做 EOL 归一化）。
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif',
  '.pdf', '.zip', '.gz', '.tgz', '.tar', '.7z', '.rar', '.bz2', '.xz',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.mp3', '.mp4', '.mov', '.avi', '.webm', '.wav', '.ogg', '.flac',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.jar', '.pyc',
  '.o', '.a', '.lib', '.bin', '.db', '.sqlite', '.sqlite3',
]);

// 文本判定：扩展名不在二进制清单，且首 8KB 无 NUL 字节。
function isTextBuffer(buf, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (BINARY_EXTENSIONS.has(ext)) return false;
  const end = Math.min(buf.length, TEXT_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (buf[i] === 0) return false;
  }
  return true;
}

// 文本 CRLF→LF；字节敏感/二进制原样返回。
export function normalizeEol(buf, filePath) {
  if (!isTextBuffer(buf, filePath)) return buf;
  if (!buf.includes(0x0d)) return buf; // 快路径：无 \r 不动
  // latin1 逐字节往返，保证除 CRLF 折叠外字节不变。
  return Buffer.from(buf.toString('latin1').replace(/\r\n/g, '\n'), 'latin1');
}

// 路径归一化为 / 分隔的相对路径（去 ./ 前缀、折叠 . 与重复分隔符）。
function normalizeRel(p) {
  const posix = p.replace(/\\/g, '/');
  const norm = path.posix.normalize(posix);
  return norm === '.' ? '' : norm;
}

// 排除判定（对单个视图路径）：规划目录前缀 + change 内精确生成路径。
function isExcludedView(viewPath) {
  for (const prefix of EXCLUDED_PLANNING) {
    if (viewPath.startsWith(prefix)) return true;
  }
  const changeRest = /^openspec\/changes\/[^/]+\/(.*)$/.exec(viewPath);
  if (changeRest) {
    const rest = changeRest[1];
    for (const generated of EXCLUDED_GENERATED) {
      const dirName = generated.replace(/\/$/, '');
      if (rest === dirName || rest.startsWith(generated)) return true;
    }
  }
  return false;
}

// 排除规则分别对两个根生效：projectRoot 视图（relPath）与 planningRoot 视图（位于 planningRoot 下时）。
function isExcluded(relPath, projectRoot, planningRoot) {
  if (isExcludedView(relPath)) return true;
  const planningAbs = path.resolve(planningRoot);
  const abs = path.resolve(projectRoot, relPath);
  const relPlanning = path.relative(planningAbs, abs);
  if (relPlanning && !relPlanning.startsWith('..') && !path.isAbsolute(relPlanning)) {
    if (isExcludedView(normalizeRel(relPlanning))) return true;
  }
  return false;
}

/**
 * 输入键 v1：{仓库根业务/测试输入，规划根排除后的 delta/元数据} 的内容 tree-hash。
 * 基集 = projectRoot 的 git tracked（工作树内容，覆盖未提交改动）∪ 显式 include（未跟踪路径）。
 * symlink（tracked 或 include 命中）默认拒绝（fail-closed）。
 */
export async function computeInputKeyV1({ projectRoot, planningRoot, include = [] }) {
  const warnings = [];
  const candidates = new Set();

  const lsOutput = execFileSync('git', ['ls-files', '-z'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  for (const entry of lsOutput.split('\0')) {
    if (entry) candidates.add(normalizeRel(entry));
  }

  for (const rawInclude of include) {
    const rel = normalizeRel(String(rawInclude));
    if (!rel) continue;
    let st = null;
    try {
      st = lstatSync(path.resolve(projectRoot, rel));
    } catch {
      // 不存在的显式 include：记 warning，不抛错。
    }
    if (!st) {
      warnings.push(`include-missing: ${rel}`);
      continue;
    }
    if (st.isSymbolicLink()) throw new Error(`symlink-not-supported: ${rel}`);
    if (!st.isFile()) {
      warnings.push(`include-not-a-file: ${rel}`);
      continue;
    }
    candidates.add(rel);
  }

  const entries = [];
  for (const rel of candidates) {
    const abs = path.resolve(projectRoot, rel);
    let st = null;
    try {
      st = lstatSync(abs);
    } catch {
      // 工作树中已删除的跟踪文件：记 warning（缺席本身已反映在 hash 中）。
    }
    if (!st) {
      warnings.push(`missing: ${rel}`);
      continue;
    }
    if (st.isSymbolicLink()) throw new Error(`symlink-not-supported: ${rel}`);
    if (!st.isFile()) {
      warnings.push(`not-a-file: ${rel}`);
      continue;
    }
    if (isExcluded(rel, projectRoot, planningRoot)) continue;
    const buf = readFileSync(abs);
    const fileHash = createHash('sha256').update(normalizeEol(buf, rel)).digest('hex');
    entries.push([rel, fileHash]);
  }

  // 稳定排序：按 relPath 码元序（locale 无关，跨平台确定）。
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));

  const tree = createHash('sha256');
  for (const [rel, fileHash] of entries) {
    tree.update(rel, 'utf8');
    tree.update('\0', 'utf8');
    tree.update(fileHash, 'utf8');
  }

  return {
    version: 1,
    hash: tree.digest('hex'),
    fileCount: entries.length,
    warnings,
  };
}
