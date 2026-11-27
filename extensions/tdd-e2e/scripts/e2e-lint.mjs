#!/usr/bin/env node
/**
 * e2e-lint — `--gate` 权威判定（设计 §6.3 判定表；本扩展安全核心，发布资格判定唯一权威入口）
 * ＋ `--archive-gate --execute` 受管归档（契约三 · 归档契约"已同步后移动"）。
 *
 * 用法：node e2e-lint.mjs --gate [--change <name>] [--project <root>] [--base <ref>]
 *                        [--policy-ref <ref>] [--schema <name>] [--json] [--timeout <ms>]
 *       node e2e-lint.mjs --archive-gate --change <name> --execute [--project <root>]
 *                        [--base <ref>] [--policy-ref <ref>] [--json] [--timeout <ms>]
 *
 * 发布资格 = 受信执行成功 ∧ 快照绑定一致 ∧ 台账/发布契约通过（§6.3 判定语义）。
 * 判定顺序（控制器裁定 5）：①有效 schema 解析（元数据无效 = FAIL 独立错误路径）
 * → ②受检集合（diff 涉及 change 身份决策：新增/迁移按迁移后身份/删除须确认清理完整/空集合）
 * → ③EXEMPT 授权（受信授权记录：身份＋受审快照 hash＋范围＋批准人；glob 只筛候选不作授权）
 * → ④项目级重跑（docs-only 记 SKIP-EXEC 免重跑但非 PASS；code-only 必跑；
 *   裁定 1：权威重跑只接受 trusted 源命令，只落 change-metadata → FAIL no-trusted-command）
 * → ⑤逐 change 快照绑定（从最终候选重算组合键 v1 与 bundle 记录比对，不一致 = stale = FAIL）
 * → ⑥台账对账（specs delta requirement 下任意 h4 子标题 = 场景；台账逐场景覆盖、
 *   拒未知引用/重名；无 delta/零场景按 skip_specs 判 NOT_APPLICABLE 或 FAIL）
 * → ⑦发布契约（produces 齐全、制品清单内容复验）→ 聚合取最差项。
 *
 * 三态输出分离（裁定 8）：stdout JSON = { aggregate, projectRun, changes: [{name,status,reason}] }；
 * 退出码 0 ∈ {PASS, EXEMPT, NOT_APPLICABLE}，1 = FAIL（元数据无效、no-trusted-command、
 * stale、对账失败、发布契约不满足等），2 = 用法错误。"未执行"永不记 PASS。
 * authority 不参与判定（本 CLI 不设 authority 面）；staging 记录 commandSource 仅信息性。
 * 元数据近似键 typo 诊断（设计 §6.3）走顶层 warnings（不拦截判定）。
 *
 * 受信策略 ref（契约一）：--policy-ref 缺省 = origin/main（可解析时），不可解析回退
 * working-tree 并记 warning；命令发现、policyVersion、enforce/allowlist 解析全部走该
 * 受信 ref（`git show <ref>:…`），被测代码/指纹/规划面仍取 working tree（候选 checkout
 * 只提供被测代码与测试）。显式 ref 不可解析 = 用法错误 exit 2。
 *
 * `--archive-gate --execute`（契约三：语义 = "已同步后移动"，非 `openspec archive` 语义等价物）：
 * ①完整判定（含重跑，复用 --gate 单 change 路径；判定红 = 拒绝不移动）→ ②快照复验（受测快照 ==
 * 当前受检树，重算组合键 v1 比对，防判定后编辑）→ ③sync 完整性校验（specs delta 已合入主 spec 或
 * 显式 skip_specs；部分完成 = error:'sync-incomplete' 不移动——sync 是 agent 前置工作，这里只读校验）
 * → ④移动阶段无半态：目标预检 / 同文件系统 rename / no-clobber / 日期前缀 `YYYY-MM-DD-<name>`
 * （已带前缀不重复加，对齐 src/core/archive.ts 先例）/ 复验到移动间持 run lock / 失败回退（源目录完整）。
 * 退出码 0 = 归档完成；EXEMPT 归档可继续，但 evidence/archive-record.json 必带豁免标记与授权引用。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { computeInputKeyV1 } from './lib/fingerprint.mjs';
import { computePolicyVersion, discoverCommand, loadProjectConfig, parseChangeMetadata } from './lib/config.mjs';
import {
  acquireRunLock,
  combineInputKey,
  computeContentHash,
  computePlanningHash,
  releaseRunLock,
  verifyBundle,
} from './lib/bundle.mjs';

const EXIT_TIMEOUT = 124;
const DEFAULT_TIMEOUT_MS = 600_000;
const VALID_ENFORCE = new Set(['tdd-driven-only', 'all-changes']);

class UsageError extends Error {}

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------- CLI ----------

function parseArgs(argv) {
  const opts = {
    gate: false,
    archiveGate: false,
    execute: false,
    change: null,
    project: process.cwd(),
    base: null,
    policyRef: null,
    schema: null,
    json: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const need = (flag) => {
      i += 1;
      if (i >= argv.length) throw new UsageError(`${flag} requires a value`);
      return argv[i];
    };
    switch (a) {
      case '--gate': opts.gate = true; break;
      case '--archive-gate': opts.archiveGate = true; break;
      case '--execute': opts.execute = true; break;
      case '--change': opts.change = need(a); break;
      case '--project': opts.project = need(a); break;
      case '--base': opts.base = need(a); break;
      case '--policy-ref': opts.policyRef = need(a); break;
      case '--schema': opts.schema = need(a); break;
      case '--json': opts.json = true; break;
      case '--timeout': {
        const v = Number(need(a));
        if (!Number.isInteger(v) || v <= 0) throw new UsageError('--timeout must be a positive integer (ms)');
        opts.timeoutMs = v;
        break;
      }
      default: throw new UsageError(`unknown argument: ${a}`);
    }
  }
  if (!opts.gate && !opts.archiveGate) {
    throw new UsageError('--gate or --archive-gate is required (e2e-lint.mjs --gate | --archive-gate --change <name> --execute)');
  }
  if (opts.gate && opts.archiveGate) throw new UsageError('--gate and --archive-gate are mutually exclusive');
  if (opts.execute && !opts.archiveGate) throw new UsageError('--execute requires --archive-gate');
  if (opts.archiveGate) {
    if (!opts.execute) throw new UsageError('--archive-gate requires --execute');
    if (opts.change === null) throw new UsageError('--archive-gate requires --change <name>');
    if (opts.change.includes('/')) {
      throw new UsageError(`--archive-gate moves a flat change directory (no '/'): ${opts.change}`);
    }
  }
  if (opts.change !== null && !validChangeName(opts.change)) {
    throw new UsageError(`invalid --change name: ${opts.change}`);
  }
  return opts;
}

/** change 名（可含 archive/<date-name> 两段式迁移后身份）；禁止 `..` 与空段。 */
function validChangeName(name) {
  if (name.includes('..')) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*(\/[A-Za-z0-9][A-Za-z0-9._-]*)?$/.test(name);
}

// ---------- 输出 ----------

function emit(opts, obj, code) {
  const text = opts.json ? `${JSON.stringify(obj)}\n` : `${humanLine(obj)}\n`;
  process.stdout.write(text);
  return code;
}

function humanLine(obj) {
  if (obj.archive !== undefined) {
    return obj.error
      ? `e2e-lint: ARCHIVE=FAIL change=${obj.change ?? '-'} error=${obj.error}`
      : `e2e-lint: ARCHIVE=done change=${obj.change} as=${obj.archivedAs} judgment=${obj.judgment?.status ?? '-'}`;
  }
  const changes = (obj.changes ?? []).map((c) => `${c.name}: ${c.status}`).join(', ') || '-';
  return `e2e-lint: AGGREGATE=${obj.aggregate ?? obj.error ?? 'FAIL'} project=${obj.projectRun?.status ?? '-'} changes=[${changes}]`;
}

function hardFail(error, message, warnings = []) {
  return {
    error,
    message,
    aggregate: 'FAIL',
    projectRun: { status: 'FAIL', error, reason: message },
    changes: [],
    warnings,
  };
}

// ---------- 文档路径与生成路径（受检集合分类用） ----------

// 文档扩展名白名单（fail-closed，裁定：白名单外——.ts/.js/.yml/无扩展名等——一律不算文档）。
const DOC_EXTENSIONS = new Set([
  '.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.pdf',
]);

/**
 * 文档路径（docs-only 判定，fail-closed 宁可多跑不可漏跑）：
 * openspec/ 下的规划面不算文档（触碰 change 必须收门禁）；仅**第一路径段**为
 * docs/ 或 docs-lab/（深层 src/docs/ 永不算）且扩展名 ∈ 白名单的文件才是文档——
 * 代码不得经目录命名/扩展名规避强制重跑。
 */
function isDocPath(p) {
  if (p.startsWith('openspec/')) return false;
  const parts = p.split('/');
  if (parts[0] !== 'docs' && parts[0] !== 'docs-lab') return false;
  return DOC_EXTENSIONS.has(path.posix.extname(parts[parts.length - 1]).toLowerCase());
}

/** 路径 → change 身份（openspec/changes/<name>/ 或 openspec/changes/archive/<dir>/）；无关返回 null。 */
function changeNameOf(relPosix) {
  const parts = relPosix.split('/');
  if (parts[0] !== 'openspec' || parts[1] !== 'changes') return null;
  if (parts.length < 3) return null;
  if (parts[2] === 'archive') {
    if (parts.length < 4) return null;
    return `archive/${parts[3]}`;
  }
  return parts[2];
}

function changeDirOf(projectRoot, name) {
  return path.join(projectRoot, 'openspec', 'changes', ...name.split('/'));
}

/** change 内精确生成路径（evidence/、deliverables/、.staging/、evidence.md 投影）——不作触碰判定。 */
function isGeneratedChangePath(relPosix, name) {
  const prefix = `openspec/changes/${name}/`;
  if (!relPosix.startsWith(prefix)) return false;
  const rest = relPosix.slice(prefix.length);
  return rest === 'evidence.md' || /^(evidence|deliverables|\.staging)(\/|$)/.test(rest);
}

// ---------- diff 基线（裁定 2） ----------

function gitOut(projectRoot, args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/** `git diff --name-status -z <base>` 的 token 流：status\0path\0（R/C 为 status\0old\0new\0）。 */
function parseNameStatusZ(out) {
  const tokens = out.split('\0');
  const entries = [];
  let i = 0;
  while (i < tokens.length) {
    const status = tokens[i];
    if (!status) { i += 1; continue; }
    const letter = status[0];
    if (letter === 'R' || letter === 'C') {
      const from = tokens[i + 1];
      const to = tokens[i + 2];
      if (from !== undefined && to !== undefined) {
        if (letter === 'R') entries.push({ status: 'D', path: from });
        entries.push({ status: 'A', path: to });
      }
      i += 3;
    } else {
      const p = tokens[i + 1];
      if (p !== undefined) entries.push({ status: letter, path: p });
      i += 2;
    }
  }
  return entries;
}

/**
 * diff 基线：显式 --base（CI 传目标分支/合成结果）> git merge-base HEAD origin/main
 * > HEAD~1（记 warning）> 全部文件视为变更（fail-closed）。
 * diff 面 = base 对工作树（含未提交改动）∪ 未跟踪文件（git ls-files --others）。
 */
function resolveDiff(projectRoot, baseOpt) {
  const warnings = [];
  let base = null;
  if (baseOpt !== null) {
    try {
      base = gitOut(projectRoot, ['rev-parse', '--verify', '--quiet', `${baseOpt}^{commit}`]).trim();
    } catch {
      throw new UsageError(`--base ref not resolvable: ${baseOpt}`);
    }
  } else {
    try {
      base = gitOut(projectRoot, ['merge-base', 'HEAD', 'origin/main']).trim();
    } catch {
      try {
        base = gitOut(projectRoot, ['rev-parse', '--verify', '--quiet', 'HEAD~1^{commit}']).trim();
        warnings.push('no origin/main: diff base fell back to HEAD~1');
      } catch {
        base = null;
        warnings.push('no diff base (no origin/main, no HEAD~1): treating all tracked files as changed');
      }
    }
  }

  const entries = [];
  if (base !== null) {
    entries.push(...parseNameStatusZ(gitOut(projectRoot, ['diff', '--name-status', '-z', base])));
  } else {
    for (const p of gitOut(projectRoot, ['ls-files', '-z']).split('\0')) {
      if (p) entries.push({ status: 'A', path: p });
    }
  }
  // 未跟踪未忽略文件并入（本地 fail-closed：新 change 目录未提交也算触碰）
  const seen = new Set(entries.map((e) => e.path));
  for (const p of gitOut(projectRoot, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0')) {
    if (p && !seen.has(p)) entries.push({ status: 'A', path: p });
  }
  return { base, warnings, entries };
}

/** 受检集合（裁定 5）：diff 涉及 change 的身份决策。生成路径只用于"清理残片"判定，不作触碰。 */
function buildInspectionSet(projectRoot, diff, forcedChange) {
  const names = new Set();
  const forced = forcedChange !== null;
  if (forced) names.add(forcedChange);

  for (const e of diff.entries) {
    const name = changeNameOf(e.path);
    if (name !== null) names.add(name);
  }

  const set = [];
  for (const name of [...names].sort()) {
    const dir = changeDirOf(projectRoot, name);
    const current = [];
    walkFiles(dir, `openspec/changes/${name}`, current);
    const nonGenerated = current.filter((p) => !isGeneratedChangePath(p, name));
    const deleted = diff.entries.some((e) => e.status === 'D' && changeNameOf(e.path) === name);
    const touched = diff.entries
      .filter((e) => changeNameOf(e.path) === name && !isGeneratedChangePath(e.path, name))
      .map((e) => e.path);

    let kind;
    if (nonGenerated.length > 0) kind = 'current'; // 新增/触碰/迁移后身份（按当前名受判）
    else if (current.length > 0) kind = 'deleted-incomplete'; // 只剩生成记录残片 → 清理不完整
    else if (deleted || forced) kind = 'deleted-clean';
    else kind = 'current';

    set.push({ name, kind, touched, forced: forced && touched.length === 0 });
  }
  return set;
}

function walkFiles(dir, relBase, out) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of entries) {
    const rel = relBase ? `${relBase}/${d.name}` : d.name;
    const abs = path.join(dir, d.name);
    if (d.isDirectory()) walkFiles(abs, rel, out);
    else if (d.isFile()) out.push(rel);
  }
}

// ---------- 元数据 / 有效 schema（①） ----------

/** 顶层标量键抽取（与 config.mjs parseChangeMetadata 同语义的最小子集，用于基线对比）。 */
function extractMetaScalars(text) {
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue;
    const m = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    const quoted = /^(['"])([\s\S]*?)\1(?:\s+#.*)?$/.exec(rest);
    values[m[1]] = quoted ? quoted[2] : rest.replace(/\s+#.*$/, '').trimEnd();
  }
  return values;
}

function gitShow(projectRoot, base, relPath) {
  if (base === null) return null;
  try {
    return gitOut(projectRoot, ['show', `${base}:${relPath}`]);
  } catch {
    return null; // 基线中不存在（新建 change 自带元数据 = 合法）
  }
}

/** 项目默认 schema：openspec/config.yaml 顶层 `schema:` 标量（缺失 → spec-driven）。 */
function projectDefaultSchema(projectRoot) {
  try {
    const raw = readFileSync(path.join(projectRoot, 'openspec', 'config.yaml'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      if (/^\s/.test(line) || line.trimStart().startsWith('#')) continue;
      const m = line.match(/^schema:\s*(.*)$/);
      if (m) {
        const rest = m[1].trim();
        const quoted = /^(['"])([\s\S]*?)\1(?:\s+#.*)?$/.exec(rest);
        const v = quoted ? quoted[2] : rest.replace(/\s+#.*$/, '').trimEnd();
        if (v) return v;
      }
    }
  } catch {
    /* 无项目配置 → 默认 */
  }
  return 'spec-driven';
}

// ---------- 受信授权记录（③ EXEMPT，裁定 4） ----------

/** allowlist 条目 = JSON 对象字符串：{change, snapshot, scope[], approver}。裸 glob/名称只筛候选，不作授权。 */
function parseAuthRecord(entry) {
  if (typeof entry !== 'string' || !entry.trim().startsWith('{')) return null;
  let obj;
  try {
    obj = JSON.parse(entry);
  } catch {
    return null;
  }
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
  const { change, snapshot, scope, approver } = obj;
  if (typeof change !== 'string' || change === '') return null;
  if (typeof snapshot !== 'string' || !/^[0-9a-f]{64}$/.test(snapshot)) return null;
  if (!Array.isArray(scope) || scope.length === 0 || scope.some((s) => typeof s !== 'string' || s === '')) return null;
  if (typeof approver !== 'string' || approver.trim() === '') return null;
  return { change, snapshot, scope, approver: approver.trim() };
}

function globToRegex(glob) {
  let re = '';
  let i = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 3; }
      else { re += '.*'; i += 2; }
    } else if (c === '*') {
      re += '[^/]*'; i += 1;
    } else if (c === '?') {
      re += '[^/]'; i += 1;
    } else {
      re += /[\\^$.|+(){}[\]]/.test(c) ? `\\${c}` : c;
      i += 1;
    }
  }
  return new RegExp(`^${re}$`);
}

/** 范围只筛候选：change 的触碰路径须全部落在 scope glob 内（空触碰 → 视为覆盖）。 */
function scopeCovers(scope, touchedPaths) {
  if (touchedPaths.length === 0) return true;
  const regs = scope.map(globToRegex);
  return touchedPaths.every((p) => regs.some((re) => re.test(p)));
}

/**
 * 授权校验：身份＋受审快照 hash（= change 规划面 computePlanningHash）＋范围＋批准人四项齐全才授权。
 * 快照与当前不符 = 授权失效（含改豁免原因 = 新授权才有效）；无身份命中 → {ok:false}（glob 不授权）。
 * ok 时返回受信授权记录全项（归档记录的授权引用来源）。
 */
function checkAuthorization(allowlist, name, changeDir, touchedPaths) {
  if (!Array.isArray(allowlist)) return { ok: false, stale: false };
  const named = allowlist.map(parseAuthRecord).filter((r) => r !== null && r.change === name);
  if (named.length === 0) return { ok: false, stale: false };
  let snapshot = null;
  try {
    snapshot = computePlanningHash(changeDir);
  } catch {
    return { ok: false, stale: true };
  }
  for (const r of named) {
    if (r.snapshot !== snapshot) continue;
    if (!scopeCovers(r.scope, touchedPaths)) continue;
    return { ok: true, change: r.change, approver: r.approver, snapshot: r.snapshot, scope: r.scope };
  }
  return { ok: false, stale: true };
}

// ---------- 受信执行（④ 项目级重跑，裁定 1） ----------

/** shell 命令执行：detached 进程组，超时 kill 整组 → 124 红；输出转 stderr 保持 stdout 干净。 */
function runCommand(command, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ exitCode: 127, timedOut: false });
      return;
    }
    let timedOut = false;
    let settled = false;
    let safety = null;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* 已退出 */ }
      }
    }, timeoutMs);
    const forward = (chunk) => { process.stderr.write(chunk); };
    child.stdout?.on('data', forward);
    child.stderr?.on('data', forward);
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(safety);
      resolve({ exitCode: 127, timedOut: false });
    });
    child.on('exit', () => {
      safety = setTimeout(() => {
        child.stdout?.destroy();
        child.stderr?.destroy();
      }, 2000);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(safety);
      if (timedOut) resolve({ exitCode: EXIT_TIMEOUT, timedOut: true });
      else resolve({ exitCode: code === null ? 1 : code, timedOut: false });
    });
  });
}

// ---------- 发布契约辅助（⑦） ----------

function isGlob(p) {
  return /[*?]/.test(p);
}

function globMatches(projectRoot, pattern) {
  const re = globToRegex(pattern);
  const out = [];
  const walk = (dir, rel) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.name === '.git' || e.name === 'node_modules') continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(path.join(dir, e.name), childRel);
      else if (e.isFile() && re.test(childRel)) out.push(childRel);
    }
  };
  walk(projectRoot, '');
  return out.sort();
}

function missingProduces(projectRoot, produces) {
  if (!produces?.length) return [];
  const missing = [];
  for (const p of produces) {
    if (isGlob(p)) {
      if (globMatches(projectRoot, p).length === 0) missing.push(p);
    } else {
      let st = null;
      try { st = statSync(path.join(projectRoot, p)); } catch { /* 缺失 */ }
      if (!st || !st.isFile()) missing.push(p);
    }
  }
  return missing;
}

// ---------- ⑤ 快照绑定（从最终候选重算组合键 v1） ----------

function findBoundBundle(changeDir, inputKeyHash) {
  const runsDir = path.join(changeDir, 'evidence', 'runs');
  let names = [];
  try {
    names = readdirSync(runsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
      .reverse(); // run-id 时间戳倒序，最新优先
  } catch {
    return { ok: false, reason: 'no-evidence: no finalized run bundle' };
  }
  for (const name of names) {
    const dir = path.join(runsDir, name);
    const v = verifyBundle(dir, inputKeyHash);
    if (!v.reusable) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(dir, 'e2e-result.json'), 'utf8'));
      return { ok: true, record, bundleDir: dir };
    } catch {
      /* 结构校验过但读失败 → 继续找（fail-closed 不放行） */
    }
  }
  // 无可用 bundle：按最新 bundle 的失配形态给出诊断（stale-inputs 是裁定 3 的权威口径）
  const newest = names.length > 0 ? path.join(runsDir, names[0]) : null;
  if (newest === null) return { ok: false, reason: 'no-evidence: no finalized run bundle' };
  const v = verifyBundle(newest, inputKeyHash);
  if (!v.complete) return { ok: false, reason: 'evidence-incomplete: bundle missing key files' };
  if (!v.success) return { ok: false, reason: `evidence-red: latest bundle exitCode=${v.exitCode ?? '?'}` };
  if (!v.manifestOk) return { ok: false, reason: 'manifest-invalid: artifact manifest malformed' };
  return { ok: false, reason: 'stale-inputs: bundle input key does not match the final candidate' };
}

// ---------- ⑥ 台账对账（场景 = requirement 下 h4 子标题，与 requirement-blocks.ts 语义一致） ----------

function buildFenceMask(lines) {
  const mask = new Array(lines.length).fill(false);
  let open = null;
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trimStart();
    if (open !== null) {
      mask[i] = true;
      if (t.startsWith(open)) open = null;
    } else if (t.startsWith('```') || t.startsWith('~~~')) {
      mask[i] = true;
      open = t.slice(0, 3);
    }
  }
  return mask;
}

/** h 标题文本规范化：去 ATX 闭合 # 串（前面有空格才算闭合）、去 Scenario: 前缀、trim。 */
function headerText(text) {
  return text
    .replace(/[ \t]+#+[ \t]*$/, '')
    .replace(/^Scenario:\s*/i, '')
    .trim();
}

/** specs delta 场景全集：每个 `### Requirement:` 块下任意非围栏 `#### ` 子标题（不限字面 Scenario:）。 */
function collectScenarios(changeDir) {
  const scenarios = [];
  const specsRoot = path.join(changeDir, 'specs');
  const files = [];
  walkFiles(specsRoot, '', files); // rel 相对 specs/
  for (const rel of files.sort()) {
    if (!rel.endsWith('.md')) continue;
    const capability = path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel);
    const text = readFileSync(path.join(specsRoot, rel), 'utf8');
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const mask = buildFenceMask(lines);
    let req = null;
    for (let i = 0; i < lines.length; i++) {
      if (mask[i]) continue;
      const line = lines[i];
      if (/^#{1,3}\s/.test(line)) {
        if (/^###\s+Requirement:\s*/i.test(line)) {
          req = headerText(line.replace(/^###\s+Requirement:\s*/i, ''));
        } else {
          req = null; // 其他 h1-h3 标题结束当前 requirement 块
        }
        continue;
      }
      if (req !== null && /^####\s+/.test(line)) {
        scenarios.push({ capability, requirement: req, name: headerText(line.replace(/^####\s*/, '')) });
      }
    }
  }
  return scenarios;
}

const LEDGER_COLUMNS = ['能力', '需求', '场景', '用例', '测试路径', '状态'];

function splitRow(line) {
  const trimmed = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return trimmed.split('|').map((c) => c.trim());
}

function stripCell(cell) {
  return cell.trim().replace(/^`(.*)`$/, '$1').trim();
}

/** 台账行（tests/ 下的 .md 表格）：能力/需求/场景/用例/测试路径/状态 六列。 */
function collectLedgerRows(changeDir) {
  const rows = [];
  const testsRoot = path.join(changeDir, 'tests');
  const files = [];
  walkFiles(testsRoot, '', files);
  for (const rel of files.sort()) {
    if (!rel.endsWith('.md')) continue;
    const lines = readFileSync(path.join(testsRoot, rel), 'utf8').replace(/\r\n?/g, '\n').split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].includes('|')) continue;
      const cells = splitRow(lines[i]).map(stripCell);
      if (cells.length !== LEDGER_COLUMNS.length) continue;
      if (LEDGER_COLUMNS.some((c, idx) => cells[idx] !== c)) continue;
      i += 1; // 跳过分隔行
      if (i < lines.length && /^\|[\s:|-]+\|$/.test(lines[i].trim())) i += 1;
      while (i < lines.length && lines[i].includes('|')) {
        const raw = splitRow(lines[i]).map(stripCell);
        if (raw.length !== LEDGER_COLUMNS.length || raw.every((c) => c === '')) break;
        const [cap, reqCell, scenarioCell, , , status] = raw;
        let reqRef = null;
        let scenarioName = scenarioCell;
        const slash = scenarioCell.lastIndexOf('/');
        if (slash >= 0) {
          reqRef = scenarioCell.slice(0, slash).replace(/^#/, '').trim();
          scenarioName = scenarioCell.slice(slash + 1).trim();
        }
        rows.push({
          cap,
          req: headerText(reqCell.replace(/^###\s*Requirement:\s*/i, '')),
          reqRef: reqRef === null ? null : headerText(reqRef),
          scenarioName: headerText(scenarioName),
          scenarioCell,
          status,
          file: rel,
        });
        i += 1;
      }
      i -= 1;
    }
  }
  return rows;
}

/**
 * 覆盖对账：逐场景映射完整（一场景一条目、条目内允许多用例）、拒未知引用、拒同名场景。
 * 返回 {verdict: 'ok'|'na'|'fail', failures, diagnostics}。
 */
function reconcileLedger(changeDir, skipSpecs) {
  const failures = [];
  const diagnostics = [];
  const scenarios = collectScenarios(changeDir);
  const rows = collectLedgerRows(changeDir);

  if (skipSpecs) {
    if (scenarios.length > 0) {
      return {
        verdict: 'fail',
        failures: ['skip-specs-conflict: skip_specs is set but the specs delta carries scenarios'],
        diagnostics,
      };
    }
    return { verdict: 'na', failures, diagnostics }; // 零场景 + skip_specs → NOT_APPLICABLE
  }
  if (scenarios.length === 0) {
    return {
      verdict: 'fail',
      failures: ['no-scenarios: specs delta carries no requirement scenarios (set skip_specs if intentional)'],
      diagnostics,
    };
  }

  // 同名场景（同一 capability+requirement 下）= FAIL + 诊断（v1 不引入稳定 ID，fail-closed）
  const seen = new Map();
  for (const s of scenarios) {
    const key = `${s.capability}\u0000${s.requirement}\u0000${s.name}`;
    if (seen.has(key)) {
      failures.push(`duplicate-scenario: "${s.requirement} / ${s.name}" appears more than once (capability ${s.capability || 'root'})`);
      diagnostics.push(`duplicate scenario name "${s.name}" under requirement "${s.requirement}"`);
    } else {
      seen.set(key, s);
    }
  }

  const matches = (s, row) =>
    s.name === row.scenarioName
    && (row.reqRef === null || row.reqRef === s.requirement)
    && (row.req === '' || row.req === s.requirement)
    && (row.cap === '' || row.cap === s.capability);

  for (const row of rows) {
    if (!scenarios.some((s) => matches(s, row))) {
      failures.push(`ledger-unknown-scenario: "${row.scenarioCell}" (tests/${row.file}) matches no scenario in the specs delta`);
      diagnostics.push(`unknown scenario reference "${row.scenarioCell}" in tests/${row.file}`);
    }
  }
  for (const s of scenarios) {
    if (!rows.some((row) => matches(s, row))) {
      failures.push(`ledger-unmapped-scenario: "${s.requirement} / ${s.name}" has no ledger entry`);
      diagnostics.push(`unmapped scenario "${s.requirement} / ${s.name}"`);
    }
  }
  return { verdict: failures.length > 0 ? 'fail' : 'ok', failures, diagnostics };
}

// ---------- 逐 change 判定 ----------

const PROTECTED_META_KEYS = ['schema', 'skip_specs', 'x-tdd-e2e.skip', 'x-tdd-e2e.skip_reason'];

/**
 * ①②③ 前段判定：身份决策 → 元数据有效性 / 编辑授权 → 有效 schema / 执法范围 → EXEMPT。
 * 返回 {name, status?, reason?, diagnostics, meta, pending}；pending 者进入 ⑤⑥⑦ 电池。
 */
function preJudge(c, projectRoot, opts, cfg, diff) {
  const dir = changeDirOf(projectRoot, c.name);
  const out = {
    name: c.name,
    status: null,
    reason: '',
    diagnostics: [],
    meta: null,
    pending: false,
    effective: null,
    auth: null, // EXEMPT 的受信授权记录（归档记录授权引用）
    touched: c.touched,
    inputKeyHash: null, // ⑤ 快照绑定的组合键 v1（--archive-gate 快照复验比对基准）
    boundBundle: null,
    typos: [], // 元数据近似键诊断（设计 §6.3：warning 不拦截，发布进 warnings 通道）
  };

  if (c.kind === 'deleted-clean') {
    out.status = 'NOT_APPLICABLE';
    out.reason = 'deleted-clean: change removed with no leftovers';
    return out;
  }
  if (c.kind === 'deleted-incomplete') {
    out.status = 'FAIL';
    out.reason = 'incomplete-deletion: generated leftovers remain after the change was deleted';
    return out;
  }

  let meta;
  try {
    meta = parseChangeMetadata(dir);
  } catch (e) {
    out.status = 'FAIL';
    out.reason = `invalid-metadata: ${e.message}`;
    return out;
  }
  out.meta = meta;
  out.typos = meta.typos;

  // 元数据编辑规则：新建 change 自带 schema/元数据合法；修改既有 change 的
  // schema/豁免字段 = 须授权记录，未授权 = FAIL（在执法范围判定之前，防脱管）。
  const baseMetaText = gitShow(projectRoot, diff.base, `openspec/changes/${c.name}/.openspec.yaml`);
  if (baseMetaText !== null) {
    const baseVals = extractMetaScalars(baseMetaText);
    const edited = PROTECTED_META_KEYS.some((k) => String(baseVals[k] ?? '') !== String(meta.values[k] ?? ''));
    if (edited) {
      const auth = checkAuthorization(cfg.allowlist, c.name, dir, c.touched);
      if (!auth.ok) {
        out.status = 'FAIL';
        out.reason = 'unauthorized-metadata-edit: schema/exemption fields changed without a trusted authorization record';
        return out;
      }
    }
  }

  const schemaVal = meta.values['schema'];
  if (schemaVal !== undefined && (typeof schemaVal !== 'string' || schemaVal.trim() === '')) {
    out.status = 'FAIL';
    out.reason = 'invalid-metadata: schema must be a non-empty string';
    return out;
  }
  if (schemaVal === undefined && cfg.enforce === 'tdd-driven-only') {
    out.status = 'FAIL';
    out.reason = 'schema-bypass: metadata schema missing under enforce=tdd-driven-only';
    return out;
  }

  // 显式覆盖（--schema，受信输入）> change 元数据 > 项目默认 > spec-driven
  const effective = opts.schema
    ?? (typeof schemaVal === 'string' && schemaVal.trim() !== '' ? schemaVal.trim() : projectDefaultSchema(projectRoot));
  out.effective = effective;

  if (!(effective === 'tdd-driven' || cfg.enforce === 'all-changes')) {
    out.status = 'NOT_APPLICABLE';
    out.reason = `out-of-scope: effective schema "${effective}", enforce "${cfg.enforce ?? 'none'}"`;
    return out;
  }

  // ③ EXEMPT：skip + reason 声明 → 须受信授权记录；glob 只筛候选不作授权
  const skipRaw = meta.values['x-tdd-e2e.skip'];
  const skipReason = meta.values['x-tdd-e2e.skip_reason'];
  const skipDeclared = (skipRaw === true || skipRaw === 'true')
    && typeof skipReason === 'string' && skipReason.trim() !== '';
  if (skipDeclared) {
    const auth = checkAuthorization(cfg.allowlist, c.name, dir, c.touched);
    if (auth.ok) {
      out.status = 'EXEMPT';
      out.auth = auth;
      out.reason = `exempt: authorized by ${auth.approver} (reviewed snapshot ${auth.snapshot.slice(0, 12)}…, skip "${skipReason.trim()}")`;
      return out;
    }
    out.status = 'FAIL';
    out.reason = auth.stale
      ? 'authorization-stale: reviewed snapshot hash mismatch or scope not covered (authorization invalidated)'
      : 'unauthorized-skip: skip declared without a trusted authorization record (globs do not authorize)';
    return out;
  }

  out.pending = true;
  return out;
}

/**
 * ⑤⑥⑦ 电池：快照绑定（组合键 v1 重算比对）→ 台账对账 → 发布契约（produces＋清单内容复验）。
 * 未执行永不记 PASS；全过且对账适用 → PASS，零场景 skip_specs → NOT_APPLICABLE，否则 FAIL。
 */
function finishJudge(p, projectRoot, cfg, fpHash, policyVersion) {
  const dir = changeDirOf(projectRoot, p.name);
  const failures = [];
  const diagnostics = [];

  // ⑤ 快照绑定（裁定 3：内容复验在本层，verifyBundle 只做结构校验）
  let bound = { ok: false, reason: 'fingerprint-failed: planning hash unavailable' };
  try {
    const planningHash = computePlanningHash(dir);
    const contentHash = computeContentHash(fpHash, planningHash);
    const inputKeyHash = combineInputKey(contentHash, policyVersion);
    p.inputKeyHash = inputKeyHash;
    bound = findBoundBundle(dir, inputKeyHash);
    p.boundBundle = bound.ok ? bound.bundleDir : null;
  } catch (e) {
    bound = { ok: false, reason: `fingerprint-failed: ${e.message}` };
    p.boundBundle = null;
  }
  if (!bound.ok) failures.push(bound.reason);

  // ⑥ 台账对账（skip_specs 只免场景对账，不免项目级 e2e；
  // enforce: all-changes = 全员收测试门禁，但不强求无 tests 工件的 schema 补台账）
  const skipSpecs = p.meta.values['skip_specs'] === true || p.meta.values['skip_specs'] === 'true';
  const ledgerOwed = p.effective === 'tdd-driven';
  const ledger = ledgerOwed
    ? reconcileLedger(dir, skipSpecs)
    : { verdict: 'na', failures: [], diagnostics: [] };
  failures.push(...ledger.failures);
  diagnostics.push(...ledger.diagnostics);
  // 台账全绿 ⇔ evidence 绿（绿 bundle 下仍有计划/红 → FAIL）
  if (bound.ok && ledgerOwed) {
    for (const row of collectLedgerRows(dir)) {
      if (row.status !== '绿') {
        failures.push(`ledger-not-green: row "${row.scenarioCell}" has status "${row.status}" (green run requires a green ledger)`);
      }
    }
  }

  // ⑦ 发布契约：produces 齐全 + 制品清单内容复验
  if (bound.ok) {
    const missing = missingProduces(projectRoot, cfg.produces);
    if (missing.length > 0) failures.push(`missing-produces: ${missing.join(', ')}`);
    const artifacts = Array.isArray(bound.record.artifacts) ? bound.record.artifacts : [];
    for (const a of artifacts) {
      let buf;
      try {
        buf = readFileSync(path.join(projectRoot, a.file));
      } catch {
        failures.push(`manifest-mismatch: ${a.file} missing`);
        diagnostics.push(`artifact ${a.file} listed in the manifest is gone`);
        continue;
      }
      const sha = createHash('sha256').update(buf).digest('hex');
      if (sha !== a.sha256 || buf.length !== a.size) {
        failures.push(`manifest-mismatch: ${a.file} content differs from the manifest`);
        diagnostics.push(`artifact ${a.file} sha256/size no longer matches the run manifest`);
      }
    }
  }

  p.diagnostics.push(...diagnostics);
  if (failures.length > 0) {
    p.status = 'FAIL';
    p.reason = failures.join('; ');
    return;
  }
  if (ledgerOwed && ledger.verdict === 'na') {
    p.status = 'NOT_APPLICABLE';
    p.reason = 'no-scenarios with skip_specs: reconciliation not applicable (evidence bound, contract satisfied)';
    return;
  }
  p.status = 'PASS';
  p.reason = ledgerOwed
    ? 'green: trusted execution + snapshot bound + ledger reconciled + release contract satisfied'
    : 'green: trusted execution + snapshot bound + release contract satisfied (no tests artifact: ledger not demanded)';
}

// ---------- ④ 项目级重跑决策与执行 ----------

/** docs-only（diff ⊂ 文档路径）→ 免重跑（SKIP-EXEC，非 PASS）；全部在范围 change EXEMPT 且非文档触碰均在豁免 change 内 → 免重跑。 */
function decideRerun(diff, judged) {
  const classified = diff.entries.filter((e) => !isGeneratedChangePath(e.path, changeNameOf(e.path) ?? ''));
  const docsOnly = classified.every((e) => isDocPath(e.path));
  if (docsOnly) return { demand: false, why: 'docs-only diff — rerun waived (SKIP-EXEC, never PASS)' };
  const nonDoc = classified.filter((e) => !isDocPath(e.path));
  const exemptNames = new Set(judged.filter((p) => p.status === 'EXEMPT').map((p) => p.name));
  const allExempt = judged.length > 0 && judged.every((p) => p.status === 'EXEMPT');
  const nonDocInsideExempt = nonDoc.every((e) => {
    const n = changeNameOf(e.path);
    return n !== null && exemptNames.has(n);
  });
  if (allExempt && nonDocInsideExempt) {
    return { demand: false, why: 'all in-scope changes EXEMPT (authorized) — rerun waived' };
  }
  return { demand: true, why: '' };
}

/**
 * 权威重跑（裁定 1）：只接受 trusted 源命令（config → package-json）；发现链只落到
 * change-metadata → FAIL no-trusted-command（staging 记录 commandSource 仅信息性，不作信任）。
 * 契约一：policyRef 设置时命令发现与 policyVersion 全部读自受信 ref，工作树不参与策略解析。
 * 前后指纹不一致 → stale-inputs 作废；超时 = 红。
 */
async function executeProjectRun(opts, projectRoot, cfg, demand, judged, fpArgs, policyRef) {
  const base = { status: null, reason: '', fpHash: null, policyFile: null, policyRef };
  const merged = {};
  for (const p of judged) {
    if (p.meta && p.meta.values) Object.assign(merged, p.meta.values);
  }
  const disc = discoverCommand({ projectRoot, changeMetadata: merged, policyRef });
  const policyFile = (() => {
    const file = disc.source === 'config' ? 'tdd-e2e.config.json'
      : disc.source === 'package-json' ? 'package.json' : null;
    return file;
  })();
  base.policyFile = policyFile;
  base.policySource = disc.policySource;
  const policyVersion = disc.policyVersion ?? null;

  if (!demand) {
    let fp;
    try {
      fp = await computeInputKeyV1(fpArgs);
    } catch (e) {
      return { ...base, status: 'FAIL', error: 'fingerprint-failed', reason: `fingerprint-failed: ${e.message}`, policyVersion };
    }
    return {
      ...base,
      status: 'SKIP-EXEC',
      reason: opts.rerunWaivedWhy ?? 'rerun waived',
      fpHash: fp.hash,
      policyVersion,
    };
  }

  if (disc.source === 'change-metadata') {
    return {
      ...base,
      status: 'FAIL',
      error: 'no-trusted-command',
      reason: 'no-trusted-command: only change-level x-tdd-e2e.command found; CI never executes change-metadata commands',
      policyVersion,
    };
  }
  if (!disc.command) {
    return {
      ...base,
      status: 'FAIL',
      error: 'no-command',
      reason: 'no-command: command discovery chain empty and no exemption declared',
      policyVersion,
    };
  }

  let before;
  try {
    before = await computeInputKeyV1(fpArgs);
  } catch (e) {
    return { ...base, status: 'FAIL', error: 'fingerprint-failed', reason: `fingerprint-failed: ${e.message}`, policyVersion };
  }
  const run = await runCommand(disc.command, projectRoot, opts.timeoutMs);
  let after;
  try {
    after = await computeInputKeyV1(fpArgs);
  } catch (e) {
    return { ...base, status: 'FAIL', error: 'fingerprint-failed', reason: `fingerprint-failed: ${e.message}`, policyVersion };
  }

  const out = { ...base, command: disc.command, commandSource: disc.source, exitCode: run.exitCode, policyVersion };
  if (run.timedOut) {
    out.status = 'FAIL';
    out.error = 'timeout';
    out.reason = `timeout: rerun exceeded ${opts.timeoutMs}ms (timeout = red)`;
  } else if (before.hash !== after.hash) {
    out.status = 'FAIL';
    out.error = 'stale-inputs';
    out.reason = 'stale-inputs: input fingerprint changed during the authoritative rerun';
  } else if (run.exitCode !== 0) {
    out.status = 'FAIL';
    out.error = 'test-failed';
    out.reason = `test-failed: rerun exited ${run.exitCode}`;
  } else {
    out.status = 'PASS';
    out.reason = 'rerun passed (exit 0)';
  }
  out.fpHash = after.hash;
  return out;
}

// ---------- 聚合（裁定 8：最差项；未执行永不记 PASS） ----------

function aggregateOf(projectRun, judged) {
  const statuses = judged.map((p) => p.status);
  if (projectRun.status === 'FAIL' || statuses.includes('FAIL')) return 'FAIL';
  if (statuses.includes('EXEMPT')) return 'EXEMPT'; // 豁免是独立结果，不与测试绿混记
  if (projectRun.status === 'PASS') return 'PASS';
  return 'NOT_APPLICABLE'; // SKIP-EXEC + 无 FAIL/EXEMPT 项（含空集合）
}

// ---------- 主流程 ----------

/**
 * 完整判定（--gate 与 --archive-gate 共用的判定路径；①→⑦ 全链见文件头）。
 * 返回 {obj, code}（runLint 原样输出，保持 --gate 输出不变）；成功路径附 ctx 供受管归档复用。
 */
async function judgeAll(opts) {
  const projectRoot = path.resolve(opts.project);

  // 受信策略 ref（契约一）：显式 --policy-ref 不可解析 = 用法错误；缺省默认 origin/main
  // （可解析时），不可解析回退 working-tree 并记 warning（本地 advisory 语义）。
  let policyRef = opts.policyRef;
  const policyWarnings = [];
  if (policyRef !== null) {
    try {
      gitOut(projectRoot, ['rev-parse', '--verify', '--quiet', `${policyRef}^{commit}`]);
    } catch {
      return { obj: { error: 'invalid-args', message: `--policy-ref ref not resolvable: ${policyRef}` }, code: 2 };
    }
  } else {
    try {
      gitOut(projectRoot, ['rev-parse', '--verify', '--quiet', 'origin/main^{commit}']);
      policyRef = 'origin/main';
    } catch {
      policyRef = null;
      policyWarnings.push(
        'policy-ref: default origin/main not resolvable — command/policy discovery fell back to the working tree (advisory)',
      );
    }
  }

  let cfg;
  try {
    cfg = loadProjectConfig(projectRoot, { policyRef });
  } catch (e) {
    return { obj: hardFail(e.code ?? 'invalid-config', e.message, policyWarnings), code: 1 };
  }
  if (cfg.enforce !== null && !VALID_ENFORCE.has(cfg.enforce)) {
    return { obj: hardFail('invalid-config', `invalid enforce value: ${cfg.enforce} (expected tdd-driven-only | all-changes)`), code: 1 };
  }

  let diff;
  try {
    diff = resolveDiff(projectRoot, opts.base);
  } catch (e) {
    if (e instanceof UsageError) return { obj: { error: 'invalid-args', message: e.message }, code: 2 };
    return { obj: hardFail('diff-failed', e.message, policyWarnings), code: 1 };
  }

  const set = buildInspectionSet(projectRoot, diff, opts.change);
  if (opts.change !== null && !existsSync(changeDirOf(projectRoot, opts.change))) {
    return { obj: hardFail('change-not-found', `change not found: ${opts.change}`, [...policyWarnings, ...diff.warnings]), code: 1 };
  }

  // ①②③
  const judged = set.map((c) => preJudge(c, projectRoot, opts, cfg, diff));

  // ④ 项目级重跑（docs-only / 全 EXEMPT 免重跑；裁定 1 的 trusted 源执法点）
  const decision = decideRerun(diff, judged);
  opts.rerunWaivedWhy = decision.why;
  const fpArgs = { projectRoot, planningRoot: projectRoot, include: cfg.include ?? [] };
  const projectRun = await executeProjectRun(opts, projectRoot, cfg, decision.demand, judged, fpArgs, policyRef);
  const projectRunOut = {
    status: projectRun.status,
    reason: projectRun.reason,
    policySource: projectRun.policySource,
    policyVersion: projectRun.policyVersion ?? null,
  };
  if (projectRun.error) projectRunOut.error = projectRun.error;
  if (projectRun.command !== undefined) {
    projectRunOut.command = projectRun.command;
    projectRunOut.commandSource = projectRun.commandSource;
    projectRunOut.exitCode = projectRun.exitCode;
  }

  // ⑤⑥⑦（对 pending 的在范围 change；EXEMPT/身份决策已终局）
  for (const p of judged) {
    if (!p.pending) continue;
    if (projectRun.status === 'FAIL' && (projectRun.error === 'fingerprint-failed')) {
      p.status = 'FAIL';
      p.reason = projectRun.reason;
      continue;
    }
    finishJudge(p, projectRoot, cfg, projectRun.fpHash ?? (await computeInputKeyV1(fpArgs)).hash, projectRun.policyVersion ?? null);
  }

  const changes = judged.map((p) => {
    const entry = { name: p.name, status: p.status, reason: p.reason };
    if (p.diagnostics.length > 0) entry.diagnostics = p.diagnostics;
    return entry;
  });

  const aggregate = aggregateOf(projectRun, judged);
  // 元数据近似键 typo 诊断（设计 §6.3：lint 报诊断，warning 不拦截判定）
  const typoWarnings = judged.flatMap((p) =>
    p.typos.map((k) => `metadata-typo: change "${p.name}" carries near-miss key "${k}" (did you mean the x-tdd-e2e.* namespace?)`));
  return {
    obj: {
      aggregate,
      projectRun: projectRunOut,
      changes,
      base: diff.base,
      warnings: [...policyWarnings, ...diff.warnings, ...typoWarnings],
    },
    code: aggregate === 'FAIL' ? 1 : 0,
    ctx: { projectRoot, cfg, diff, set, judged, projectRun, projectRunOut, fpArgs },
  };
}

async function runLint(opts) {
  const { obj, code } = await judgeAll(opts);
  return emit(opts, obj, code);
}

// ---------- 受管归档（--archive-gate --execute，契约三"已同步后移动"） ----------

/** 归档日期前缀（本地时区 YYYY-MM-DD，对齐 src/core/archive.ts formatLocalDate）。 */
function formatLocalDate(d = new Date()) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 已带 YYYY-MM-DD- 前缀的 change 名不再重复加（对齐 src/core/archive.ts #1309 先例）。
const ARCHIVE_DATE_PREFIX_PATTERN = /^\d{4}-\d{2}-\d{2}-/;

function relPosix(projectRoot, abs) {
  return path.relative(projectRoot, abs).split(path.sep).join('/');
}

/** 当前策略版本 hash（与判定/收尾同口径：sha256(策略文件内容)；policyRef 设置时取受信 ref 版本）。 */
function currentPolicyVersion(projectRoot, policyFile, policyRef) {
  return computePolicyVersion(
    projectRoot,
    policyFile === 'tdd-e2e.config.json' ? 'config' : policyFile === 'package.json' ? 'package-json' : null,
    policyRef ?? null,
  );
}

/**
 * ② 快照复验（契约三）：受测快照 == 当前受检树，防判定后编辑——重算组合键 v1 与判定绑定比对。
 * 已绑定 bundle（PASS / skip_specs NOT_APPLICABLE）= 组合键重算一致 ∧ bundle 仍可复用；
 * EXEMPT = 受信授权仍有效（受审快照 == 当前规划面）；out-of-scope 无受测快照 → 空过。
 */
async function reverifySnapshot({ projectRoot, changeDir, p, cfg, fpArgs, projectRun }) {
  if (p.boundBundle !== null) {
    let inputKeyHash;
    try {
      const fp = await computeInputKeyV1(fpArgs);
      const planningHash = computePlanningHash(changeDir);
      inputKeyHash = combineInputKey(
        computeContentHash(fp.hash, planningHash),
        currentPolicyVersion(projectRoot, projectRun.policyFile, projectRun.policyRef),
      );
    } catch (e) {
      return { ok: false, reason: `snapshot-recheck: ${e.message}` };
    }
    if (inputKeyHash !== p.inputKeyHash) {
      return {
        ok: false,
        reason: 'snapshot-recheck: combined input key recomputed after the judgment no longer matches the bound snapshot (post-judgment edit detected)',
      };
    }
    if (!verifyBundle(p.boundBundle, inputKeyHash).reusable) {
      return { ok: false, reason: 'snapshot-recheck: the bound run bundle is no longer reusable' };
    }
    return { ok: true, inputKeyHash, bundle: path.relative(changeDir, p.boundBundle).split(path.sep).join('/') };
  }
  if (p.auth) {
    const auth = checkAuthorization(cfg.allowlist, p.name, changeDir, p.touched ?? []);
    if (!auth.ok || auth.snapshot !== p.auth.snapshot) {
      return {
        ok: false,
        reason: 'snapshot-recheck: EXEMPT authorization no longer matches the current planning surface (post-judgment edit detected)',
      };
    }
    return { ok: true, inputKeyHash: null, bundle: null };
  }
  return { ok: true, inputKeyHash: null, bundle: null }; // out-of-scope：无受测快照可比
}

/** 去 ATX 闭合 # 串后 trim（requirement 头/节名归一化，对齐核心 normalizeRequirementName）。 */
function stripClose(text) {
  return text.replace(/[ \t]+#+[ \t]*$/, '').trim();
}

const DELTA_SECTION_RE = /^(ADDED|MODIFIED|REMOVED|RENAMED)\s+Requirements$/i;
const REQUIREMENT_HEADER_RE = /^###\s*Requirement:\s*(.+)$/i;
const REMOVED_BULLET_RE = /^\s*[-*+]\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;
const FROM_LINE_RE = /^\s*[-*+]?\s*FROM:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;
const TO_LINE_RE = /^\s*[-*+]?\s*TO:\s*`?###\s*Requirement:\s*(.+?)`?\s*$/;

/**
 * delta 节解析（只读子集，对齐 src/core/parsers/requirement-blocks.ts 语义）：
 * ADDED/MODIFIED = `### Requirement:` 头；REMOVED = 头或 bullet 形式；RENAMED = FROM:/TO: 配对。
 * 非 delta 节下的 requirement 不是操作（核心同判：orphaned 不应用）。
 */
function parseDeltaSections(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mask = buildFenceMask(lines);
  const out = { added: [], modified: [], removed: [], renamed: [], hasDelta: false };
  let section = null;
  let pendingFrom = null;
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const line = lines[i];
    const h2 = /^##\s+(.+)$/.exec(line);
    if (h2) {
      const m = DELTA_SECTION_RE.exec(stripClose(h2[1]));
      section = m ? m[1].toUpperCase() : null;
      if (m) out.hasDelta = true;
      pendingFrom = null;
      continue;
    }
    if (section === null) continue;
    if (section === 'ADDED' || section === 'MODIFIED' || section === 'REMOVED') {
      const req = REQUIREMENT_HEADER_RE.exec(line);
      const bullet = section === 'REMOVED' ? REMOVED_BULLET_RE.exec(line) : null;
      const name = req ? stripClose(req[1]) : bullet ? stripClose(bullet[1]) : null;
      if (name !== null) {
        if (section === 'ADDED') out.added.push(name);
        else if (section === 'MODIFIED') out.modified.push(name);
        else out.removed.push(name);
      }
      continue;
    }
    const from = FROM_LINE_RE.exec(line);
    const to = TO_LINE_RE.exec(line);
    if (from) pendingFrom = stripClose(from[1]);
    else if (to && pendingFrom !== null) {
      out.renamed.push({ from: pendingFrom, to: stripClose(to[1]) });
      pendingFrom = null;
    }
  }
  return out;
}

/** 主 spec 的 requirement 头全集（围栏外 `### Requirement:` 头，归一化名）。 */
function collectRequirementNames(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const mask = buildFenceMask(lines);
  const names = new Set();
  for (let i = 0; i < lines.length; i++) {
    if (mask[i]) continue;
    const m = REQUIREMENT_HEADER_RE.exec(lines[i]);
    if (m) names.add(stripClose(m[1]));
  }
  return names;
}

/**
 * ③ sync 完整性校验（契约三）：delta→主 spec 的同步是 agent 前置工作，此处只读校验——
 * ADDED/MODIFIED（与 RENAMED TO）的 requirement 头须已存在于主 spec，REMOVED（与 RENAMED FROM）
 * 须已消失（"requirement 头文本是否存在/一致"）；显式 skip_specs 跳过。
 * 部分完成/未完成 = error:'sync-incomplete'，不移动。
 */
function checkSyncCompleteness(projectRoot, changeDir, meta) {
  const skipSpecs = meta?.values?.['skip_specs'] === true || meta?.values?.['skip_specs'] === 'true';
  if (skipSpecs) return { ok: true, reason: '' };
  const missing = [];
  const lingering = [];
  const files = [];
  walkFiles(path.join(changeDir, 'specs'), '', files); // rel 相对 specs/
  for (const rel of files.sort()) {
    if (!rel.endsWith('.md')) continue;
    const plan = parseDeltaSections(readFileSync(path.join(changeDir, 'specs', rel), 'utf8'));
    if (!plan.hasDelta) continue;
    let mainNames = new Set();
    try {
      mainNames = collectRequirementNames(readFileSync(path.join(projectRoot, 'openspec', 'specs', rel), 'utf8'));
    } catch {
      /* 主 spec 缺失 → 空集（全部未合入） */
    }
    for (const name of [...plan.added, ...plan.modified, ...plan.renamed.map((r) => r.to)]) {
      if (!mainNames.has(name)) missing.push(name);
    }
    for (const name of [...plan.removed, ...plan.renamed.map((r) => r.from)]) {
      if (mainNames.has(name)) lingering.push(name);
    }
  }
  if (missing.length === 0 && lingering.length === 0) return { ok: true, reason: '' };
  const parts = [];
  if (missing.length > 0) parts.push(`not merged into main specs: ${missing.join(', ')}`);
  if (lingering.length > 0) parts.push(`still present in main specs (removal/rename not applied): ${lingering.join(', ')}`);
  return {
    ok: false,
    reason: `sync-incomplete: specs delta is not fully synced (${parts.join('; ')}); sync before archiving (or set skip_specs)`,
  };
}

/**
 * 归档记录（可审计）：写入 change 目录 evidence/archive-record.json，随移动原子落入归档目录。
 * EXEMPT 判定必带豁免标记与授权引用（身份＋受审快照＋范围＋批准人）。
 */
function buildArchiveRecord({ change, archiveName, projectRoot, dest, p, recheck }) {
  return {
    recordType: 'tdd-e2e-archive-record',
    version: 1,
    change,
    archivedAs: archiveName,
    target: relPosix(projectRoot, dest),
    archivedAt: new Date().toISOString(),
    judgment: { status: p.status, reason: p.reason },
    exemption: p.status === 'EXEMPT'
      ? {
          exempt: true,
          skipReason: String(p.meta?.values?.['x-tdd-e2e.skip_reason'] ?? ''),
          authorization: p.auth
            ? { change: p.auth.change, snapshot: p.auth.snapshot, scope: p.auth.scope, approver: p.auth.approver }
            : null,
        }
      : null,
    snapshot: recheck.inputKeyHash ? { inputKeyHash: recheck.inputKeyHash, bundle: recheck.bundle } : null,
  };
}

function writeArchiveRecord(changeDir, record) {
  const file = path.join(changeDir, 'evidence', 'archive-record.json');
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(record, null, 2)}\n`);
    return file;
  } catch (e) {
    throw fail('record-failed', `archive record write failed: ${e.message}`);
  }
}

/**
 * ④ 移动（对齐核心 rename 回退先例 src/core/archive.ts moveDirectory）：先 rename 到私有兄弟名，
 * 再 rename 落目标；第二步失败则 rename 回退（源目录必须完整），回退失败则明示保留路径。
 * 同文件系统 rename（无复制半态）；目标被并发占用（ENOTEMPTY/EEXIST）→ archive-target-exists。
 */
function moveChangeDir(src, dest) {
  const staged = path.join(path.dirname(src), `.e2e-move-${randomBytes(4).toString('hex')}`);
  try {
    renameSync(src, staged);
  } catch (e) {
    throw fail('move-failed', `move failed before staging (${e.message}); source left intact`);
  }
  try {
    renameSync(staged, dest);
  } catch (e) {
    // 第二步失败 → rename 回退（源目录必须完整）；回退失败 → 明示保留路径供恢复
    const isTargetTaken = e.code === 'ENOTEMPTY' || e.code === 'EEXIST';
    try {
      renameSync(staged, src);
    } catch (rollbackError) {
      throw fail('move-failed', `move failed (${e.message}) and rollback failed (${rollbackError.message}); source retained at ${staged}`);
    }
    throw fail(
      isTargetTaken ? 'archive-target-exists' : 'move-failed',
      isTargetTaken ? `archive target appeared while moving: ${dest}` : `move failed (${e.message}); rolled back, source intact`,
    );
  }
}

/**
 * 受管归档（契约三）：①完整判定（含重跑，复用 --gate 单 change 路径；判定红 = 拒绝）
 * → ②快照复验 → ③sync 完整性校验 → ④移动（预检/no-clobber/日期前缀/持锁/失败回退）。
 * 退出码 0 = 归档完成；任何失败即退出不留半态。
 */
async function runArchive(opts) {
  const change = opts.change;
  const res = await judgeAll(opts);
  const failArchive = (code, error, message, extra = {}) =>
    emit(opts, { archive: 'FAIL', change, error, message, ...extra }, code);

  if (!res.ctx) {
    return failArchive(res.code, res.obj.error, res.obj.message);
  }

  const { projectRoot, cfg, judged, projectRun, projectRunOut, fpArgs } = res.ctx;
  const p = judged.find((x) => x.name === change);
  const judgment = p ? { name: p.name, status: p.status, reason: p.reason } : null;

  // ① 判定红 → 不移动（完整判定含重跑：重跑红同样拦）
  if (!p || p.status === 'FAIL' || projectRun.status === 'FAIL') {
    const why = !p
      ? 'change judgment missing'
      : p.status === 'FAIL'
        ? `change judgment red: ${p.reason}`
        : `authoritative rerun red: ${projectRun.reason}`;
    return failArchive(1, 'judgment-red', `refusing to archive: ${why}`, { judgment, projectRun: projectRunOut });
  }

  const changeDir = changeDirOf(projectRoot, change);
  const archiveDir = path.join(projectRoot, 'openspec', 'changes', 'archive');
  const archiveName = ARCHIVE_DATE_PREFIX_PATTERN.test(change) ? change : `${formatLocalDate()}-${change}`;
  const dest = path.join(archiveDir, archiveName);

  let lockPath = null;
  let recordWritten = false;
  let moved = false;
  try {
    // 复验到移动间持 run lock（防并发写入；EEXIST 即忙）
    try {
      lockPath = acquireRunLock(changeDir);
    } catch (e) {
      return failArchive(1, e.code ?? 'run-locked', e.message, { judgment });
    }

    // ② 快照复验（受测快照 == 当前受检树，重算组合键比对）
    const recheck = await reverifySnapshot({ projectRoot, changeDir, p, cfg, fpArgs, projectRun });
    if (!recheck.ok) return failArchive(1, 'snapshot-recheck-failed', recheck.reason, { judgment });

    // ③ sync 完整性（已同步后移动；部分完成即中止）
    const sync = checkSyncCompleteness(projectRoot, changeDir, p.meta);
    if (!sync.ok) return failArchive(1, 'sync-incomplete', sync.reason, { judgment });

    // ④ 移动阶段无半态：目标预检 → 归档记录 → rename（失败回退）
    if (existsSync(dest)) {
      return failArchive(1, 'archive-target-exists', `archive target already exists: ${relPosix(projectRoot, dest)}`, { judgment });
    }
    mkdirSync(archiveDir, { recursive: true });
    const record = buildArchiveRecord({ change, archiveName, projectRoot, dest, p, recheck });
    writeArchiveRecord(changeDir, record);
    recordWritten = true;
    moveChangeDir(changeDir, dest);
    moved = true;

    return emit(opts, {
      archive: 'done',
      change,
      archivedAs: archiveName,
      target: relPosix(projectRoot, dest),
      record: `${relPosix(projectRoot, dest)}/evidence/archive-record.json`,
      judgment,
      projectRun: projectRunOut,
      exemption: record.exemption,
      warnings: res.obj.warnings,
    }, 0);
  } catch (e) {
    // 失败即退出不留半态：回退后的源目录移除归档记录残片（源目录完整）
    if (recordWritten && !moved && existsSync(changeDir)) {
      try {
        rmSync(path.join(changeDir, 'evidence', 'archive-record.json'), { force: true });
      } catch {
        /* 尽力清理 */
      }
    }
    return failArchive(1, e.code ?? 'internal-error', e.message, { judgment });
  } finally {
    if (lockPath !== null) {
      releaseRunLock(changeDir);
      if (moved) releaseRunLock(dest); // 锁文件随移动落入目标，一并释放
    }
  }
}

async function main() {
  const argv = process.argv.slice(2);
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    const json = argv.includes('--json');
    return emit({ json }, { error: 'invalid-args', message: e.message }, 2);
  }
  try {
    return opts.archiveGate ? await runArchive(opts) : await runLint(opts);
  } catch (e) {
    return emit(opts, hardFail(e?.code ?? 'internal-error', e?.message ?? String(e)), 1);
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  process.stderr.write(`e2e-lint: internal error: ${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
