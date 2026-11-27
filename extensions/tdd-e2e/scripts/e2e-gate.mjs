#!/usr/bin/env node
/**
 * e2e-gate — TDD e2e 运行协议（设计 §6.3）。
 *
 * 用法：node e2e-gate.mjs --change <name> [--project <root>] [--finalize] [--rerun]
 *                        [--authority ci|local|pre-commit] [--json] [--timeout <ms>]
 *
 * 运行协议顺序：发现命令（全空且无豁免 → no-command fail-closed）→ 前指纹
 * computeInputKeyV1 → spawn（shell 命令、超时 kill 进程组 → 124 红）→ 后指纹
 * （不一致 → stale-inputs 作废）→ 写 evidence/.staging/<run-id>/e2e-result.json
 * → 绿则按 collect 生成制品清单（文件名+sha256+大小）→ --json 输出。
 *
 * authority 仅记录执行环境（ci/local/pre-commit），永不参与判定（gpt P2-2）。
 * 退出码 = 测试退出码；门禁级失败 = 1；用法错误 = 2。
 * --finalize 为幂等收尾入口（Task 4，设计 §6.3 收尾入口幂等）：持 run lock、
 * 同组合键＋完整＋成功＋清单校验通过的绿 bundle 直接复用（不重跑不重发）；
 * 否则运行协议 → staging → 原子发布 evidence/runs/<runId>/ → evidence.md 人读投影。
 */
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';
import { computeInputKeyV1 } from './lib/fingerprint.mjs';
import { discoverCommand, loadProjectConfig, parseChangeMetadata } from './lib/config.mjs';
import {
  acquireRunLock,
  combineInputKey,
  computeContentHash,
  computePlanningHash,
  createRunId,
  publishBundle,
  releaseRunLock,
  stageDir,
  verifyBundle,
} from './lib/bundle.mjs';

const EXIT_TIMEOUT = 124;
const DEFAULT_TIMEOUT_MS = 600_000;
const VALID_AUTHORITIES = new Set(['ci', 'local', 'pre-commit']);
const KNOWN_ERROR_CODES = new Set([
  'invalid-args',
  'invalid-config',
  'invalid-package-json',
  'invalid-metadata',
  'change-not-found',
  'no-command',
  'staging-failed',
  'fingerprint-failed',
  'stale-inputs',
  'missing-produces',
  'timeout',
  'run-locked',
  'publish-failed',
]);

class UsageError extends Error {}

function parseArgs(argv) {
  const opts = {
    change: null,
    project: process.cwd(),
    finalize: false,
    rerun: false,
    authority: null,
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
      case '--change': opts.change = need(a); break;
      case '--project': opts.project = need(a); break;
      case '--finalize': opts.finalize = true; break;
      case '--rerun': opts.rerun = true; break;
      case '--authority': opts.authority = need(a); break;
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
  if (opts.authority !== null && !VALID_AUTHORITIES.has(opts.authority)) {
    throw new UsageError('--authority must be one of ci|local|pre-commit');
  }
  return opts;
}

/** authority 仅记录：显式 --authority > env.CI 为真 > local。永不参与判定。 */
function resolveAuthority(explicit) {
  if (explicit) return explicit;
  const ci = process.env.CI;
  if (ci !== undefined && ci !== '' && ci !== 'false' && ci !== '0') return 'ci';
  return 'local';
}

function validChangeName(name) {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

/** 策略版本 hash（裁定 2）：按命令发现链命中的源读策略文件；change-metadata / 读不到 → null。 */
function computePolicyVersion(projectRoot, source) {
  const file = source === 'config' ? 'tdd-e2e.config.json'
    : source === 'package-json' ? 'package.json'
      : null;
  if (!file) return null;
  try {
    return createHash('sha256').update(readFileSync(path.join(projectRoot, file))).digest('hex');
  } catch {
    return null;
  }
}

// ---------- --finalize 幂等收尾（Task 4，E1 本地收尾） ----------

/** 清理发布前中断残留的 staging（持锁期间执行；run lock 在 evidence/ 根，不在此列）。 */
function cleanStaleStaging(changeDir) {
  const stagingRoot = path.join(changeDir, 'evidence', '.staging');
  let names;
  try {
    names = readdirSync(stagingRoot);
  } catch {
    return; // 尚无 staging → 无残留
  }
  for (const name of names) rmSync(path.join(stagingRoot, name), { recursive: true, force: true });
}

/** 扫描 evidence/runs/ 找同组合键可复用 bundle（run-id 时间戳倒序，最新优先）。 */
function findReusableBundle(changeDir, inputKeyHash) {
  const runsDir = path.join(changeDir, 'evidence', 'runs');
  let entries;
  try {
    entries = readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return null; // 尚无 bundle → 无候选
  }
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => e.name).sort().reverse();
  for (const name of dirs) {
    const dir = path.join(runsDir, name);
    if (!verifyBundle(dir, inputKeyHash).reusable) continue;
    try {
      const record = JSON.parse(readFileSync(path.join(dir, 'e2e-result.json'), 'utf8'));
      return { record, bundleDir: dir };
    } catch {
      /* verify 通过但读失败 → 跳过（fail-closed 不复用） */
    }
  }
  return null;
}

/** 两态（设计 §6.3）：bundle 已入 HEAD = 已提交待 CI 验收（E3 后）；否则 = 本地收尾完成（E1）。 */
function bundleState(projectRoot, changeDir, runId) {
  const rel = path.relative(projectRoot, path.join(changeDir, 'evidence', 'runs', runId)).replace(/\\/g, '/');
  try {
    const out = execFileSync('git', ['ls-tree', '--name-only', 'HEAD', '--', rel], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return out.trim() !== '' ? 'committed-pending-ci' : 'local-finalized';
  } catch {
    return 'local-finalized'; // 无 HEAD / 非 git → 未提交
  }
}

function relPosix(projectRoot, abs) {
  return path.relative(projectRoot, abs).replace(/\\/g, '/');
}

/** evidence.md 人读投影：五节模板对齐 schema/templates/evidence.md；内容全由 run 记录导出（幂等字节稳定）。 */
function renderEvidenceProjection(record, { projectRoot, bundleAbs }) {
  const green = record.exitCode === 0;
  const artifacts = Array.isArray(record.artifacts) ? record.artifacts : [];
  const artifactLines = artifacts.length > 0
    ? artifacts.map((a) => `- \`${a.file}\` — sha256 \`${a.sha256}\`（${a.size} bytes）`)
    : ['- 无（未配置 collect 或本次无制品）'];
  return [
    '# Evidence',
    '',
    '<!-- 由 e2e-gate --finalize 生成的人读投影（非权威）：引用本次 run bundle；放行以判定进程链内独立重跑为准。 -->',
    '',
    '## 台账回填',
    '',
    `<!-- 投影自 run \`${record.runId}\`；台账状态以 tests.md 实际回填为准，本文件不改写台账。 -->`,
    '',
    `- run: \`${record.runId}\`（${green ? '绿' : '红'}，exit ${record.exitCode}）`,
    `- bundle: \`${relPosix(projectRoot, bundleAbs)}\``,
    '',
    '## e2e 摘要',
    '',
    `- 命令: \`${record.command ?? '-'}\`（source: ${record.commandSource ?? '-'}）`,
    `- 退出码: ${record.exitCode} — ${record.summary}`,
    `- 输入键: \`${record.inputKeyHash ?? '-'}\`（内容 \`${record.contentHash ?? '-'}\` = 指纹 \`${record.inputKeyBefore}\` ⊕ 规划面 \`${record.planningHash ?? '-'}\`，⊕ 策略 \`${record.policyVersion ?? 'null'}\`）`,
    `- 权威记录: authority=${record.authority}（仅记录，不参与判定）`,
    `- 时间: ${record.timestamp}`,
    '',
    '## 失败清单',
    '',
    green
      ? '- 无（本次运行绿，exit 0）'
      : `- exit ${record.exitCode}: ${record.summary}（处置：修复后重跑 \`--finalize\` 重建 bundle）`,
    '',
    '## 制品清单',
    '',
    ...artifactLines,
    '',
    '## 豁免标记',
    '',
    '- 无',
    '',
  ].join('\n');
}

/**
 * 执行 shell 命令：detached 进程组，超时 kill 整组 → 124。
 * 子进程输出转发到 stderr，保持 stdout 只有 gate 自身输出（--json 可解析）。
 */
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
        process.kill(-child.pid, 'SIGKILL'); // 杀整个进程组（shell + 孙进程）
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
      // 兜底：孙进程若持有 stdio 管道，close 不触发会挂死 gate —— 2s 后强制关流。
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

// ---------- collect 制品清单（零依赖最小 glob：** / * / ?） ----------

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
      else if (e.isFile() && re.test(childRel)) out.push(childRel); // symlink 不跟随
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

function collectArtifacts(projectRoot, patterns) {
  const files = new Set();
  for (const pat of patterns) for (const f of globMatches(projectRoot, pat)) files.add(f);
  return [...files].sort().map((file) => {
    const buf = readFileSync(path.join(projectRoot, file));
    return { file, sha256: createHash('sha256').update(buf).digest('hex'), size: buf.length };
  });
}

// ---------- 输出 ----------

function humanLine(obj) {
  if (obj.error && !obj.runId) return `e2e-gate: FAIL error=${obj.error}${obj.message ? ` — ${obj.message}` : ''}`;
  if (obj.status === 'skipped') return `e2e-gate: SKIPPED exempt:${obj.skipSource}`;
  const verdict = obj.exitCode === 0 ? 'PASS' : 'FAIL';
  return `e2e-gate: ${verdict} exit=${obj.exitCode} run=${obj.runId ?? '-'}${obj.error ? ` error=${obj.error}` : ''}`;
}

async function emit(opts, obj, code) {
  const text = opts.json ? `${JSON.stringify(obj)}\n` : `${humanLine(obj)}\n`;
  await new Promise((resolve) => process.stdout.write(text, resolve));
  return code;
}

// ---------- 运行协议 ----------

async function runGate(opts) {
  const projectRoot = path.resolve(opts.project);
  const changeDir = path.join(projectRoot, 'openspec', 'changes', opts.change);
  const authority = resolveAuthority(opts.authority);

  // ① 项目级配置（坏配置 fail-closed）
  let cfg;
  try {
    cfg = loadProjectConfig(projectRoot);
  } catch (e) {
    return emit(opts, { error: e.code ?? 'invalid-config', message: e.message, authority }, 1);
  }

  // ② change 目录存在性（fail-closed，不隐式创建 change）
  if (!existsSync(changeDir) || !statSync(changeDir).isDirectory()) {
    return emit(opts, { error: 'change-not-found', change: opts.change, authority }, 1);
  }

  if (!opts.finalize) {
    return runProtocol(opts, projectRoot, changeDir, authority, cfg);
  }

  // --finalize：单写者 run lock 全程持锁（EEXIST 即忙 → fail-closed），finally 释放
  try {
    acquireRunLock(changeDir);
  } catch (e) {
    return emit(opts, { error: e.code ?? 'staging-failed', message: e.message, change: opts.change, authority }, 1);
  }
  try {
    cleanStaleStaging(changeDir); // 发布前中断残留清理（失败重试不留半态）
    return await runProtocol(opts, projectRoot, changeDir, authority, cfg);
  } finally {
    releaseRunLock(changeDir);
  }
}

/** 运行协议 ③→⑪（设计 §6.3）；--finalize 在⑥后做复用判定、⑩后原子发布 bundle 与人读投影。 */
async function runProtocol(opts, projectRoot, changeDir, authority, cfg) {
  // ③ change 元数据 + ④ 命令发现链
  let meta;
  let disc;
  try {
    meta = parseChangeMetadata(changeDir);
    disc = discoverCommand({ projectRoot, changeMetadata: meta.values });
  } catch (e) {
    return emit(opts, { error: e.code ?? 'invalid-metadata', message: e.message, authority }, 1);
  }

  // ⑤ 全空 → 豁免判定（skipApproved / change 级 skip+reason）→ 否则 fail-closed
  if (!disc.command) {
    const skipRaw = meta.values['x-tdd-e2e.skip'];
    const skipReason = meta.values['x-tdd-e2e.skip_reason'];
    const changeSkip = (skipRaw === true || skipRaw === 'true')
      && typeof skipReason === 'string' && skipReason.trim() !== '';
    if (cfg.skipApproved || changeSkip) {
      return emit(opts, {
        status: 'skipped',
        skipSource: cfg.skipApproved ? 'config' : 'change-metadata',
        change: opts.change,
        authority,
        summary: 'exempt: e2e skipped',
      }, 0);
    }
    return emit(opts, {
      error: 'no-command',
      change: opts.change,
      authority,
      message: 'command discovery chain empty and no exemption declared',
    }, 1);
  }

  const policyVersion = computePolicyVersion(projectRoot, disc.source);
  const fpArgs = { projectRoot, planningRoot: projectRoot, include: cfg.include ?? [] };

  // ⑥ 前指纹
  let before;
  try {
    before = await computeInputKeyV1(fpArgs);
  } catch (e) {
    return emit(opts, { error: 'fingerprint-failed', message: e.message, authority }, 1);
  }

  // ⑥′ --finalize：组合键 = sha256(内容 hash + policyVersion)，内容 hash = 指纹 ⊕ 规划面
  //    （设计 §6.3 本地硬路径冻结：运行输入、台账、.openspec.yaml 元数据、策略标识一并入键）
  //    → 复用判定：同组合键 ＋ 完整 ＋ 成功 ＋ 通过清单校验 → 复用，不重跑不重发
  let contentHash = null;
  let inputKeyHash = null;
  let planningHash = null;
  if (opts.finalize) {
    try {
      planningHash = computePlanningHash(changeDir);
    } catch (e) {
      return emit(opts, { error: e.code ?? 'fingerprint-failed', message: e.message, authority }, 1);
    }
    contentHash = computeContentHash(before.hash, planningHash);
    inputKeyHash = combineInputKey(contentHash, policyVersion);
    const reusable = findReusableBundle(changeDir, inputKeyHash);
    if (reusable) {
      const stored = reusable.record;
      const out = {
        ...stored,
        change: opts.change,
        status: 'pass',
        reused: true,
        state: bundleState(projectRoot, changeDir, stored.runId),
        bundle: relPosix(projectRoot, reusable.bundleDir),
        evidenceMd: relPosix(projectRoot, path.join(changeDir, 'evidence.md')),
        planningHash,
        contentHash,
        inputKeyHash,
      };
      // 人读投影幂等重写（内容全由存储记录导出 → 字节稳定；修复缺失的投影）
      try {
        writeFileSync(
          path.join(changeDir, 'evidence.md'),
          renderEvidenceProjection(stored, { projectRoot, bundleAbs: reusable.bundleDir }),
        );
      } catch (e) {
        return emit(opts, { error: 'staging-failed', message: e.message, runId: stored.runId, authority }, 1);
      }
      return emit(opts, out, 0);
    }
  }

  // ⑦ spawn（超时 → 124 红）
  const run = await runCommand(disc.command, projectRoot, opts.timeoutMs);

  // ⑧ 后指纹
  let after;
  try {
    after = await computeInputKeyV1(fpArgs);
  } catch (e) {
    return emit(opts, { error: 'fingerprint-failed', message: e.message, authority }, 1);
  }

  // ⑨ 判定（authority 不参与）：timeout > stale > 测试退出码 > produces
  let exitCode;
  let error = null;
  let status;
  let summary;
  let missing = null;
  if (run.timedOut) {
    exitCode = EXIT_TIMEOUT;
    error = 'timeout';
    status = 'timeout';
    summary = `timeout after ${opts.timeoutMs}ms`;
  } else if (before.hash !== after.hash) {
    exitCode = 1;
    error = 'stale-inputs';
    status = 'stale-inputs';
    summary = 'stale-inputs: input fingerprint changed during run';
  } else if (run.exitCode !== 0) {
    exitCode = run.exitCode;
    status = 'fail';
    summary = `failed (exit ${run.exitCode})`;
  } else {
    missing = missingProduces(projectRoot, cfg.produces);
    if (missing.length > 0) {
      exitCode = 1;
      error = 'missing-produces';
      status = 'missing-produces';
      summary = `missing produces: ${missing.join(', ')}`;
    } else {
      exitCode = 0;
      status = 'pass';
      summary = 'passed';
    }
  }

  const runId = createRunId();
  const record = {
    runId,
    exitCode,
    summary,
    inputKeyBefore: before.hash,
    inputKeyAfter: after.hash,
    authority,
    commandSource: disc.source,
    timestamp: new Date().toISOString(),
    timeoutMs: opts.timeoutMs,
    policyVersion,
  };
  if (opts.finalize) {
    // bundle 输入键投影（裁定 2：记录存三段 hash —— 指纹 inputKeyBefore、规划面 planningHash、
    // 内容段 contentHash ⊕ policyVersion，复用比对组合键 inputKeyHash）
    record.planningHash = planningHash;
    record.contentHash = contentHash;
    record.inputKeyHash = inputKeyHash;
    record.command = disc.command;
  }
  // 绿则按 collect 生成制品清单（入记录 → staging → bundle，清单校验的依据）
  if (exitCode === 0 && cfg.collect?.length) record.artifacts = collectArtifacts(projectRoot, cfg.collect);

  // ⑩ staging 记录（红灯也照常写入，诊断价值）
  const evidenceDir = path.join(changeDir, 'evidence');
  const stagingDir = stageDir(changeDir, runId);
  try {
    if (existsSync(evidenceDir) && !statSync(evidenceDir).isDirectory()) {
      throw new Error(`${path.join(opts.change, 'evidence')} exists and is not a directory`);
    }
    mkdirSync(stagingDir, { recursive: true });
    writeFileSync(path.join(stagingDir, 'e2e-result.json'), `${JSON.stringify(record, null, 2)}\n`);
  } catch (e) {
    return emit(opts, { error: 'staging-failed', message: e.message, runId, authority }, 1);
  }

  // ⑪ 输出（finalize 附 bundle 落地信息）
  const out = { ...record, change: opts.change, command: disc.command, status };
  if (error) out.error = error;
  if (missing) out.missing = missing;

  // ⑩′ --finalize：bundle 内人读报告 → 原子发布 → 顶层 evidence.md 人读投影
  if (opts.finalize) {
    const bundleAbs = path.join(changeDir, 'evidence', 'runs', runId);
    const projection = renderEvidenceProjection(record, { projectRoot, bundleAbs });
    try {
      writeFileSync(path.join(stagingDir, 'evidence.md'), projection);
      publishBundle({ stagingDir, bundleDir: bundleAbs });
    } catch (e) {
      return emit(opts, { error: e.code ?? 'publish-failed', message: e.message, runId, change: opts.change, authority }, 1);
    }
    try {
      writeFileSync(path.join(changeDir, 'evidence.md'), projection);
    } catch (e) {
      return emit(opts, { error: 'staging-failed', message: e.message, runId, change: opts.change, authority }, 1);
    }
    out.reused = false;
    out.state = bundleState(projectRoot, changeDir, runId);
    out.bundle = relPosix(projectRoot, bundleAbs);
    out.evidenceMd = relPosix(projectRoot, path.join(changeDir, 'evidence.md'));
  }
  return emit(opts, out, exitCode);
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

  // --finalize 幂等收尾入口在 runGate 内分支（需先过 --change 校验，用法错误统一 exit 2）
  if (!opts.change) {
    return emit(opts, { error: 'invalid-args', message: '--change <name> is required' }, 2);
  }
  if (!validChangeName(opts.change)) {
    return emit(opts, { error: 'invalid-args', message: `invalid --change name: ${opts.change}` }, 2);
  }

  try {
    return await runGate(opts);
  } catch (e) {
    const code = KNOWN_ERROR_CODES.has(e?.code) ? e.code : 'internal-error';
    return emit(opts, { error: code, message: e?.message ?? String(e) }, 1);
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((e) => {
  process.stderr.write(`e2e-gate: internal error: ${e?.stack ?? e}\n`);
  process.exitCode = 1;
});
