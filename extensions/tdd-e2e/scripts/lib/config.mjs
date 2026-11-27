// extensions/tdd-e2e/scripts/lib/config.mjs
// 配置发现（任务 3）：项目级受信源加载、命令发现链（受信源优先）、
// change 元数据扁平点号键解析 + 近似键 typo 诊断。
// 零依赖：仅 node 内置模块（fs / path）。

import { readFileSync } from 'node:fs';
import path from 'node:path';

const CONFIG_FILENAME = 'tdd-e2e.config.json';
const METADATA_FILENAME = '.openspec.yaml';

/** 唯一识别的 change 级 x- 键（设计 §6.3 扁平点号键）。 */
const KNOWN_X_KEYS = ['x-tdd-e2e.command', 'x-tdd-e2e.skip', 'x-tdd-e2e.skip_reason'];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

/**
 * 读 JSON 文件：不存在 → undefined（合法缺省）；
 * 存在但不可读/坏 JSON → 抛 fail(code)（fail-closed，"配置不可读 ≠ 通过"）。
 */
function readJsonIfExists(file, errorCode) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw fail(errorCode, `${path.basename(file)} unreadable: ${e.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw fail(errorCode, `${path.basename(file)} is not valid JSON`);
  }
}

/**
 * 加载项目级 tdd-e2e.config.json。
 * 缺省全 null/false；字段类型不符 → 抛 invalid-config（fail-closed）；
 * 未知键忽略（向前兼容）。
 *
 * @param {string} projectRoot
 * @returns {{command: string|null, enforce: string|null, allowlist: string[]|null,
 *            include: string[]|null, collect: string[]|null, produces: string[]|null,
 *            skipApproved: boolean}}
 */
export function loadProjectConfig(projectRoot) {
  const parsed = readJsonIfExists(path.join(projectRoot, CONFIG_FILENAME), 'invalid-config');
  const defaults = {
    command: null,
    enforce: null,
    allowlist: null,
    include: null,
    collect: null,
    produces: null,
    skipApproved: false,
  };
  if (parsed === undefined) return defaults;
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw fail('invalid-config', 'tdd-e2e.config.json must be a JSON object');
  }

  const strOrNull = (v, key) => {
    if (v === undefined || v === null) return null;
    if (typeof v !== 'string') throw fail('invalid-config', `"${key}" must be a string`);
    return v === '' ? null : v;
  };
  const strArrayOrNull = (v, key) => {
    if (v === undefined || v === null) return null;
    if (!Array.isArray(v) || v.some((x) => typeof x !== 'string')) {
      throw fail('invalid-config', `"${key}" must be an array of strings`);
    }
    return v;
  };

  let skipApproved = false;
  if (parsed.skipApproved !== undefined && parsed.skipApproved !== null) {
    if (typeof parsed.skipApproved !== 'boolean') {
      throw fail('invalid-config', '"skipApproved" must be a boolean');
    }
    skipApproved = parsed.skipApproved;
  }

  return {
    command: strOrNull(parsed.command, 'command'),
    enforce: strOrNull(parsed.enforce, 'enforce'),
    allowlist: strArrayOrNull(parsed.allowlist, 'allowlist'),
    include: strArrayOrNull(parsed.include, 'include'),
    collect: strArrayOrNull(parsed.collect, 'collect'),
    produces: strArrayOrNull(parsed.produces, 'produces'),
    skipApproved,
  };
}

/**
 * 命令发现链（只读项目级受信源，change 级 x- 键仅作提示）：
 *   tdd-e2e.config.json 的 command > package.json scripts["test:e2e"] > x-tdd-e2e.command。
 * 全空 → { command: null, source: null }（调用方 fail-closed）。
 * changeMetadata 接受扁平值记录（parseChangeMetadata().values）或其 {values, typos} 外壳。
 *
 * @param {{projectRoot: string, changeMetadata?: Record<string, string|boolean>}} params
 * @returns {{command: string|null, source: 'config'|'package-json'|'change-metadata'|null}}
 */
export function discoverCommand({ projectRoot, changeMetadata } = {}) {
  const cfg = loadProjectConfig(projectRoot); // 坏配置 → 抛 invalid-config
  // 空白命令视为未配置（否则 shell 执行空串 exit 0 = 无测试装绿）。
  if (typeof cfg.command === 'string' && cfg.command.trim() !== '') {
    return { command: cfg.command, source: 'config' };
  }

  const pkg = readJsonIfExists(path.join(projectRoot, 'package.json'), 'invalid-package-json');
  if (pkg !== undefined && pkg !== null && typeof pkg === 'object' && !Array.isArray(pkg)) {
    const script = pkg.scripts?.['test:e2e'];
    if (script !== undefined && script !== null) {
      if (typeof script !== 'string' || script.trim() === '') {
        // 受信源形态错误 → fail-closed，不静默降级到 change 级提示。
        throw fail('invalid-package-json', 'package.json scripts["test:e2e"] must be a non-empty string');
      }
      return { command: script, source: 'package-json' };
    }
  }

  const mv = changeMetadata && typeof changeMetadata === 'object'
    && typeof changeMetadata.values === 'object' && changeMetadata.values !== null
    && Array.isArray(changeMetadata.typos)
    ? changeMetadata.values // 容错：直接传 parseChangeMetadata 的 {values, typos} 结果
    : (changeMetadata ?? {});
  const changeCmd = mv['x-tdd-e2e.command'];
  if (typeof changeCmd === 'string' && changeCmd.trim() !== '') {
    return { command: changeCmd, source: 'change-metadata' };
  }
  return { command: null, source: null };
}

// 近似键判定：我们的命名空间下的未知键 / 分隔符变体 / 裸后缀（核心键不撞车）。
function isTypoKey(key) {
  if (KNOWN_X_KEYS.includes(key)) return false;
  const lower = key.toLowerCase();
  // x-tdd-e2e.* / x-tdd-e2e_* / X_TDD_E2E.* 等命名空间变体（含拼写错误 x-tdd-e2e.comand）
  if (/^x[-_.]?tdd[-_.]?e2e/i.test(key)) return true;
  // 裸后缀近似键：skip_reason、command 等（设计 §6.3：裸 skip_reason 是 typo 诊断示例）
  if (['command', 'skip', 'skip_reason', 'skip-reason'].includes(lower)) return true;
  return false;
}

/**
 * 解析 change 目录下 .openspec.yaml 的顶层扁平标量键（零依赖最小子集）：
 * 只取非缩进的 `key: value` 行；true/false → boolean；成对引号剥离；
 * 注释/空行/文档头/嵌套行跳过。文件缺失 → 空值不抛。
 *
 * @param {string} changeDir
 * @returns {{values: Record<string, string|boolean>, typos: string[]}}
 */
export function parseChangeMetadata(changeDir) {
  const file = path.join(changeDir, METADATA_FILENAME);
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch (e) {
    if (e.code === 'ENOENT') return { values: {}, typos: [] };
    throw fail('invalid-metadata', `${METADATA_FILENAME} unreadable: ${e.message}`);
  }

  const values = {};
  const typos = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\s/.test(line)) continue; // 嵌套行：只认顶层标量
    const m = line.match(/^([A-Za-z0-9_][A-Za-z0-9_.-]*):\s*(.*)$/);
    if (!m) continue; // 非 key: value 行（如 --- 文档头）：跳过
    const key = m[1];
    const rest = m[2].trim();
    let value;
    // 引号包裹（可带行尾注释）→ 取引号内原文；裸标量 → 去行尾注释（YAML plain scalar 语义）。
    const quoted = /^(['"])([\s\S]*?)\1(?:\s+#.*)?$/.exec(rest);
    if (quoted) {
      value = quoted[2];
    } else {
      const plain = rest.replace(/\s+#.*$/, '').trimEnd();
      if (plain === 'true') value = true;
      else if (plain === 'false') value = false;
      else value = plain;
    }
    values[key] = value;
    if (isTypoKey(key)) typos.push(key);
  }
  return { values, typos };
}
