// extensions/tdd-e2e/scripts/lib/bundle.mjs
// run bundle 生命周期（设计 §6.3 契约二 / 收尾入口幂等，Task 4）：
// run-id、staging 路径、原子发布（rename，跨设备 copy+unlink 回退，失败清理）、
// 复用校验（同组合键＋完整＋成功＋清单校验通过才可复用）、单写者 run lock（EEXIST 即忙）。
// 输入键 = 指纹（业务/测试输入）＋ change 规划面（specs/、tests/、.openspec.yaml）＋ 策略版本。
// 零外部依赖：仅 node 内置模块（crypto / fs / path）＋ 同库 fingerprint.mjs 的 normalizeEol。

import { createHash, randomBytes } from 'node:crypto';
import {
  closeSync,
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { normalizeEol } from './fingerprint.mjs';

/** bundle 关键文件（缺一即"不完整"，不可复用）。 */
const RESULT_FILE = 'e2e-result.json';
const REPORT_FILE = 'evidence.md';
const LOCK_FILE = '.run-lock';

/** 台账快照（契约二）：change tests/** 拷入 bundle 的 tests/ 子目录 + 可枚举清单（占位保 git 存续）。 */
const LEDGER_SNAPSHOT_DIR = 'tests';
const LEDGER_SNAPSHOT_MANIFEST = '.ledger-snapshot.json';

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/** 运行身份 run-id：UTC 时间戳（文件系统安全化）+ 随机后缀。 */
export function createRunId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${randomBytes(3).toString('hex')}`;
}

/**
 * staging 路径（change 相对，对齐 gate 运行协议）：
 * <changeDir>/evidence/.staging/<runId>/。
 */
export function stageDir(changeDir, runId) {
  return path.join(changeDir, 'evidence', '.staging', runId);
}

/**
 * change 规划面内容 hash（裁定：设计 §6.3"本地硬路径冻结"——台账与 delta 一并进输入键）：
 * `<changeDir>` 下 `specs/**`、`tests/**`、`.openspec.yaml` 三者，EOL 归一化后逐文件 hash
 * 再按相对路径码元序聚合（口径与 computeInputKeyV1 的 tree-hash 一致）。
 * 缺席（目录/元数据不存在）→ 不入列，稳定反映在 hash 中；symlink → fail-closed 抛错。
 *
 * @param {string} changeDir change 目录绝对路径
 * @returns {string} 规划面 sha256 hex
 */
export function computePlanningHash(changeDir) {
  const entries = [];

  const addFile = (abs, rel) => {
    let st = null;
    try {
      st = lstatSync(abs);
    } catch {
      return; // 缺席本身稳定反映在 hash 中
    }
    if (st.isSymbolicLink()) throw fail('fingerprint-failed', `symlink-not-supported: ${rel}`);
    if (!st.isFile()) return;
    const fileHash = createHash('sha256').update(normalizeEol(readFileSync(abs), rel)).digest('hex');
    entries.push([rel, fileHash]);
  };

  const walk = (dir, relBase) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 目录缺席 → 无条目（稳定）
    }
    for (const d of dirents) {
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) throw fail('fingerprint-failed', `symlink-not-supported: ${rel}`);
      if (d.isDirectory()) walk(abs, rel);
      else if (d.isFile()) addFile(abs, rel);
    }
  };

  for (const root of ['specs', 'tests']) {
    const abs = path.join(changeDir, root);
    let st = null;
    try {
      st = lstatSync(abs);
    } catch {
      continue; // 目录缺席 → 无条目（稳定）
    }
    if (st.isSymbolicLink()) throw fail('fingerprint-failed', `symlink-not-supported: ${root}`);
    if (st.isDirectory()) walk(abs, root);
  }
  addFile(path.join(changeDir, '.openspec.yaml'), '.openspec.yaml');

  // 稳定排序：按相对路径码元序（locale 无关，跨平台确定）。
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const tree = createHash('sha256');
  for (const [rel, fileHash] of entries) {
    tree.update(rel, 'utf8');
    tree.update('\0', 'utf8');
    tree.update(fileHash, 'utf8');
  }
  return tree.digest('hex');
}

/**
 * 内容 hash（组合键的内容段）= 前后指纹（须一致）⊕ change 规划面（specs/、tests/、.openspec.yaml）。
 * 设计 §6.3 输入键 v1 的内容输入 = {仓库根业务/测试输入，规划根 delta/台账/元数据}：
 * 业务/测试输入由 computeInputKeyV1 给出（其排除 openspec/changes/），delta/台账/元数据在组合层
 * 由 computePlanningHash 并入，故"改台账/delta/元数据 → 键变"（三者缺席 → 空口径，稳定）。
 */
export function computeContentHash(fingerprintHash, planningHash) {
  return createHash('sha256')
    .update(String(fingerprintHash ?? ''))
    .update('\0')
    .update(String(planningHash ?? ''))
    .digest('hex');
}

/**
 * 组合键 v1 = sha256(内容 hash + policyVersion)
 * （设计 §6.3 输入键 v1 = {内容输入，策略版本 hash}，本地硬路径冻结三段 =
 * 指纹 hash ⊕ 规划面 hash ⊕ policyVersion；复用判定比对组合键，
 * 同键 = 同内容 hash（含规划面）且同 policyVersion）。
 */
export function combineInputKey(contentHash, policyVersion) {
  return createHash('sha256')
    .update(String(contentHash ?? ''))
    .update('\0')
    .update(String(policyVersion ?? ''))
    .digest('hex');
}

/** 清单（制品清单）结构校验：未配置 collect（无 artifacts 字段）→ 真；形态不齐 → 假。 */
function manifestOk(record) {
  const artifacts = record.artifacts;
  if (artifacts === undefined || artifacts === null) return true;
  if (!Array.isArray(artifacts)) return false;
  return artifacts.every(
    (a) => a !== null && typeof a === 'object'
      && typeof a.file === 'string' && a.file !== ''
      && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256)
      && Number.isInteger(a.size) && a.size >= 0,
  );
}

/**
 * 台账快照（契约二）：把 `<changeDir>/tests/**` 拷入 staging 的 `tests/` 子目录，
 * 作为 run bundle 枚举的"台账快照"。快照清单（.ledger-snapshot.json）恒写入：
 * 空快照时占位保目录在 git 提交/检出后存续，同时给出可枚举文件清单。
 * symlink → fail-closed 抛错（与指纹口径一致）。
 *
 * @param {string} changeDir
 * @param {string} stagingDir
 * @returns {string[]} 快照内相对路径清单（码元序）
 */
export function copyLedgerSnapshot(changeDir, stagingDir) {
  const src = path.join(changeDir, LEDGER_SNAPSHOT_DIR);
  const dest = path.join(stagingDir, LEDGER_SNAPSHOT_DIR);
  const files = [];
  mkdirSync(dest, { recursive: true });

  const walk = (dir, relBase) => {
    let dirents;
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // 无 tests/ → 空快照（清单占位）
    }
    for (const d of dirents) {
      const rel = relBase ? `${relBase}/${d.name}` : d.name;
      const abs = path.join(dir, d.name);
      if (d.isSymbolicLink()) throw fail('staging-failed', `symlink-not-supported: ${rel}`);
      if (d.isDirectory()) {
        walk(abs, rel);
      } else if (d.isFile()) {
        const outAbs = path.join(dest, ...rel.split('/'));
        mkdirSync(path.dirname(outAbs), { recursive: true });
        copyFileSync(abs, outAbs);
        files.push(rel);
      }
    }
  };
  walk(src, '');

  files.sort();
  writeFileSync(
    path.join(dest, LEDGER_SNAPSHOT_MANIFEST),
    `${JSON.stringify({ snapshotType: 'tdd-e2e-ledger-snapshot', version: 1, source: `${LEDGER_SNAPSHOT_DIR}/`, files }, null, 2)}\n`,
  );
  return files;
}

/**
 * bundle 复用校验（复用条件四要素）：
 * 完整（e2e-result.json + evidence.md 关键文件齐且记录可解析，**且台账快照 tests/ 在场**）
 * ∧ 成功（exit 0）∧ 通过清单校验 ∧ 同组合键（记录 contentHash/policyVersion 重算 == 给定键；
 * contentHash 为完整内容段：指纹 ⊕ 规划面 specs/tests/.openspec.yaml）。
 * 红灯 / 损坏 / 键变 → reusable=false（不复用，新 run 或修复重建）。
 *
 * @param {string} bundleDir evidence/runs/<runId>/
 * @param {string} inputKeyHash 组合键（当前候选树）
 * @returns {{complete: boolean, success: boolean, manifestOk: boolean, reusable: boolean}}
 */
export function verifyBundle(bundleDir, inputKeyHash) {
  const out = { complete: false, success: false, manifestOk: false, reusable: false };
  let record;
  try {
    record = JSON.parse(readFileSync(path.join(bundleDir, RESULT_FILE), 'utf8'));
  } catch {
    return out; // 缺失或坏 JSON → 不完整
  }
  if (!existsSync(path.join(bundleDir, REPORT_FILE))) return out; // 关键文件不齐
  let snapshot = false;
  try {
    snapshot = lstatSync(path.join(bundleDir, LEDGER_SNAPSHOT_DIR)).isDirectory();
  } catch {
    /* 台账快照缺失 → 不完整 */
  }
  if (!snapshot) return out; // 契约二：台账快照存在性入 complete 判定
  out.complete = true;
  out.success = record.exitCode === 0;
  out.manifestOk = manifestOk(record);
  out.reusable = out.complete && out.success && out.manifestOk
    && typeof record.contentHash === 'string'
    && combineInputKey(record.contentHash, record.policyVersion) === inputKeyHash;
  return out;
}

/**
 * 原子发布 staging → bundle（设计 §6.3：校验后一次 rename 落地 evidence/runs/<runId>/）。
 * 同文件系统 rename；跨设备（EXDEV）回退 copy+unlink；失败清理（半成品 bundle 移除，不留半态；
 * staging 残留由下次 finalize 的 stale-staging 清理接管）。
 *
 * @param {{stagingDir: string, bundleDir: string}} p
 */
export function publishBundle({ stagingDir, bundleDir }) {
  if (existsSync(bundleDir)) {
    throw fail('publish-failed', `bundle already exists: ${bundleDir}`);
  }
  mkdirSync(path.dirname(bundleDir), { recursive: true });
  try {
    renameSync(stagingDir, bundleDir);
    return;
  } catch (e) {
    if (e.code !== 'EXDEV') {
      rmSync(bundleDir, { recursive: true, force: true });
      throw fail('publish-failed', `publish rename failed: ${e.message}`);
    }
  }
  try {
    cpSync(stagingDir, bundleDir, { recursive: true }); // 跨设备回退：copy
    rmSync(stagingDir, { recursive: true, force: true }); // + unlink
  } catch (e) {
    rmSync(bundleDir, { recursive: true, force: true });
    throw fail('publish-failed', `publish copy failed: ${e.message}`);
  }
}

/**
 * 获取单写者 run lock（fs lock 文件，EEXIST 即忙 → 抛 code=run-locked）。
 * 锁文件：<changeDir>/evidence/.run-lock（在 .staging 之外，staging 清理不会误删）。
 *
 * @param {string} changeDir
 * @returns {string} 锁文件路径
 */
export function acquireRunLock(changeDir) {
  const lockPath = path.join(changeDir, 'evidence', LOCK_FILE);
  try {
    mkdirSync(path.dirname(lockPath), { recursive: true });
  } catch (e) {
    throw fail('staging-failed', `run lock setup failed: ${e.message}`);
  }
  let fd;
  try {
    fd = openSync(lockPath, 'wx');
  } catch (e) {
    if (e.code === 'EEXIST') throw fail('run-locked', `e2e run lock busy: ${lockPath}`);
    throw fail('staging-failed', `run lock acquire failed: ${e.message}`);
  }
  closeSync(fd);
  return lockPath;
}

/**
 * 释放 run lock（仅释放自己持有的：调用方以 acquired 标志守卫）。
 * 不存在/已释放 → 静默（幂等）。
 *
 * @param {string} changeDir
 */
export function releaseRunLock(changeDir) {
  try {
    unlinkSync(path.join(changeDir, 'evidence', LOCK_FILE));
  } catch {
    /* 已释放或不存在 */
  }
}
