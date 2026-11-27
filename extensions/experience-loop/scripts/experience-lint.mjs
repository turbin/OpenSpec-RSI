#!/usr/bin/env node
/**
 * experience-lint — openspec/experience/ 经验库的执法与度量脚本（零运行时依赖）。
 *
 * 用法：node experience-lint.mjs --project <root> [--change <name>] [--report]
 *
 * 模式：
 * - 归档前模式（--change <name>）：对该 change 执行 ①，并执行全局经验库校验 ②-⑥。
 * - 默认模式（CI 兜底）：不对 active change 查 retro；① 仅对 changes/archive/ 归档集合执行；②-⑥ 全局执行。
 * - --report：只统计、恒 exit 0、不做违规判定；与 --change 同给时 report 优先生效。
 *
 * 校验项：
 *   ① retro 存在性（仅对显式声明 schema: experience-loop 的 change；蕴含式 + stub 规则）
 *   ② frontmatter 八字段 / id / date / status
 *   ③ INDEX.md 与文件逐列比对（双向映射）
 *   ④ capability 有效性（仅 active；--change 额外接受该 change delta 声明的待同步 capability）
 *   ⑤ 重复检测（双 active 同 capability 同教训；直接 supersede 配对豁免）
 *   ⑥ supersede 链完整性（目标存在 / 禁自指 / 禁环 / 旧条必 superseded）
 */
import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseRecheck, resolveDisposition } from './recheck.mjs';

export const EXPERIENCE_FIELDS = ['id', 'date', 'source_change', 'capability', 'tags', 'status', 'supersedes', 'verification'];
const REQUIRED_FIELDS = EXPERIENCE_FIELDS.filter((f) => f !== 'supersedes');
const STATUSES = new Set(['active', 'ineffective', 'superseded', 'expired']);
const STUB_CONTENT = 'skipped: x-skip-retro';
const LESSON_NAME_RE = /^exp-([0-9]{8})-[a-z0-9-]+$/;
const REF_ID_RE = /\bexp-[0-9]{8}-[a-z0-9-]+\b/g;
const JUDGMENT_RE = /^- \[经验 (exp-[0-9]{8}-[a-z0-9-]+)\] 判定: (生效|不生效|不适用)/gm;

const normalize = (s) => s.replace(/\s+/g, '').toLowerCase();

/** 极简 YAML 子集解析：key: value 标量、key: [a, b] 数组；其余形态报错（fail-loud）。 */
function parseSimple(text, label, { allowBlocks = false, allowComments = false } = {}) {
  const out = new Map();
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    i += 1;
    if (line.trim() === '') continue;
    if (allowComments && line.trimStart().startsWith('#')) continue;
    const m = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!m) throw new Error(`${label}: 无法解析的元数据行 "${line.trim()}"`);
    const key = m[1];
    const value = m[2].trim();
    if (allowBlocks && /^\|[+-]?$/.test(value)) {
      while (i < lines.length && (lines[i].trim() === '' || /^\s+/.test(lines[i]))) i += 1;
      out.set(key, '');
      continue;
    }
    const arr = value.match(/^\[([^\]]*)\]$/);
    if (arr) {
      out.set(key, arr[1].split(',').map((s) => s.trim()).filter((s) => s !== ''));
      continue;
    }
    out.set(key, value);
  }
  return out;
}

async function readOptional(p) {
  try {
    return await fs.readFile(p, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') return undefined;
    throw e;
  }
}

async function isDir(p) {
  try {
    return (await fs.stat(p)).isDirectory();
  } catch {
    return false;
  }
}

function parseFrontmatter(content, label) {
  const m = content.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) throw new Error(`${label}: 缺少 frontmatter`);
  const fm = parseSimple(m[1], label);
  return { fm, body: m[2] };
}

function lessonFirstLine(body) {
  const lines = body.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === '## 教训');
  if (idx === -1) return undefined;
  for (let i = idx + 1; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (t !== '' && !t.startsWith('#')) return t;
  }
  return undefined;
}

function parseIndex(text, label) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!line.startsWith('|') || !line.endsWith('|')) throw new Error(`${label}: 无法解析的 INDEX 行 "${line}"`);
    const cols = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cols.length !== 5) throw new Error(`${label}: INDEX 行应为 5 列，实为 ${cols.length} 列 "${line}"`);
    rows.push({ id: cols[0], capability: cols[1], tags: cols[2], status: cols[3], lesson: cols[4] });
  }
  return rows;
}

/** 解析 change 元数据：ENOENT 视为未声明；解析失败或非法值抛错（fail-loud）。 */
async function readMeta(changeDir) {
  const p = path.join(changeDir, '.openspec.yaml');
  const text = await readOptional(p);
  if (text === undefined) return { declared: false };
  const meta = parseSimple(text, p, { allowBlocks: true, allowComments: true });
  return { declared: true, meta };
}

async function collectLessons(root) {
  const dir = path.join(root, 'openspec', 'experience');
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    if (e.code === 'ENOENT') return { lessons: [], errors: [] };
    throw e;
  }
  const lessons = [];
  const errors = [];
  for (const name of names.filter((n) => n.startsWith('exp-') && n.endsWith('.md')).sort()) {
    try {
      const content = await fs.readFile(path.join(dir, name), 'utf-8');
      const { fm, body } = parseFrontmatter(content, name);
      lessons.push({ name, id: name.slice(0, -3), fm, body, firstLine: lessonFirstLine(body) });
    } catch (e) {
      errors.push(String(e.message ?? e));
    }
  }
  return { lessons, errors };
}

/** 文件级写入边界（P1#1/#2）：经验目录及其祖先不得为链接；库内条目一律拒链接（拒链接/无法确认归属）。 */
async function checkBoundary(root, violations) {
  const dir = path.join(root, 'openspec', 'experience');
  let dirStat;
  try {
    dirStat = await fs.lstat(dir);
  } catch {
    return; // 无经验目录 → 无从校验
  }
  // 目录本身或任一祖先为链接 / 无法解析 → 无法确认归属
  let realDir = null;
  try {
    realDir = await fs.realpath(dir);
  } catch {
    /* 无法解析 */
  }
  if (realDir === null || realDir !== dir) {
    violations.push('openspec/experience: 目录本身或祖先为链接/无法解析（拒绝链接/无法确认归属）');
    return;
  }
  if (!dirStat.isDirectory()) {
    violations.push('openspec/experience: 不是普通目录（拒绝链接/无法确认归属）');
    return;
  }
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch (e) {
    violations.push(`openspec/experience: 无法读取目录（${e.message ?? e}）`);
    return;
  }
  for (const name of names) {
    const p = path.join(dir, name);
    let st;
    try {
      st = await fs.lstat(p);
    } catch (e) {
      violations.push(`${name}: 无法确认归属（lstat 失败：${e.message ?? e}）`);
      continue;
    }
    if (st.isSymbolicLink()) {
      violations.push(`${name}: 链接（拒绝链接/无法确认归属）`);
    }
  }
}

/** ① retro 存在性（范围限定 + 蕴含式 + stub 规则）。 */
async function checkRetro(changeDir, label, violations) {
  let meta;
  try {
    meta = await readMeta(changeDir);
  } catch (e) {
    violations.push(`${label}: ${e.message ?? e}`);
    return;
  }
  if (!meta.declared) return; // 未声明 ⇒ 不执法
  const schema = meta.meta.get('schema');
  if (schema !== undefined && typeof schema !== 'string') {
    violations.push(`${label}: .openspec.yaml 的 schema 值非法`);
    return;
  }
  if (schema !== 'experience-loop') return; // 显式其它 schema ⇒ 不执法

  let exempt = false;
  if (meta.meta.has('x-skip-retro')) {
    const v = meta.meta.get('x-skip-retro');
    if (v !== 'true' && v !== 'false') {
      violations.push(`${label}: x-skip-retro 值必须为布尔 true/false（期望键名 x-skip-retro）`);
      return;
    }
    exempt = v === 'true';
  }

  const retroPath = path.join(changeDir, 'retro.md');
  const content = await readOptional(retroPath);
  // 近似豁免键诊断：拼错键名时点名期望键（fail-closed 不变，但避免误导）
  const typoKeys = [...meta.meta.keys()].filter((k) => {
    const n = k.toLowerCase().replace(/[-_]/g, '');
    return k !== 'x-skip-retro' && n.includes('skip') && n.includes('retro');
  });
  const typoHint = typoKeys.length > 0
    ? `（检测到近似键 ${typoKeys.join(', ')} —— 是否想用 x-skip-retro？）`
    : '';
  if (exempt) {
    if (content === undefined) {
      violations.push(`${label}: x-skip-retro: true 仍须保留 stub retro.md（恰为一行 "${STUB_CONTENT}"）`);
    }
    return;
  }
  if (content === undefined) {
    violations.push(`${label}: 缺 retro.md（无豁免时必须有真实 retro）${typoHint}`);
  } else if (content.trim() === STUB_CONTENT) {
    violations.push(`${label}: 无豁免不得使用 stub retro.md${typoHint}`);
  }
}

/** 已审写入计划（P1#2/#3b）：严格契约（必填 from/target/supersedes/contentHash/done）；归档前拒"有计划未结案"；done:true 核实际目标态/取代边(含预期无边)/内容摘要。 */
async function checkPlan(changeDir, root, label, violations) {
  const text = await readOptional(path.join(changeDir, '.recheck-plan.json'));
  if (text === undefined) return;
  let plan;
  try {
    plan = JSON.parse(text);
  } catch (e) {
    violations.push(`${label}: .recheck-plan.json 解析失败（${e.message ?? e}）`);
    return;
  }
  if (!Array.isArray(plan)) {
    violations.push(`${label}: .recheck-plan.json 应为条目数组`);
    return;
  }
  const REQUIRED = ['id', 'from', 'target', 'supersedes', 'contentHash', 'done'];
  for (const entry of plan) {
    if (entry == null || typeof entry !== 'object') {
      violations.push(`${label}: 计划条目非法`);
      continue;
    }
    const missing = REQUIRED.filter((f) => !(f in entry));
    if (missing.length > 0) {
      violations.push(`${label}: 计划条目缺必填字段（${missing.join(', ')}）`);
      continue;
    }
    if (entry.done !== true && entry.done !== false) {
      violations.push(`${label}: 计划条目 done 必须为布尔`);
      continue;
    }
    if (entry.done === false) {
      violations.push(`${label}: 有计划未结案（${entry.id}）`);
      continue;
    }
    const p = path.join(root, 'openspec', 'experience', `${entry.id}.md`);
    const content = await readOptional(p);
    if (content === undefined) {
      violations.push(`${label}: 计划已结案但经验 ${entry.id} 不存在`);
      continue;
    }
    let fm;
    try {
      fm = parseFrontmatter(content, entry.id).fm;
    } catch {
      violations.push(`${label}: ${entry.id} frontmatter 解析失败`);
      continue;
    }
    if (fm.get('status') !== entry.target) {
      violations.push(`${label}: 计划 ${entry.id} 目标态不符（期望 ${entry.target} 实际 ${fm.get('status')}）`);
    }
    const actualSup = fm.get('supersedes') ?? null;
    if (actualSup !== entry.supersedes) {
      violations.push(`${label}: 计划 ${entry.id} 取代边不符（期望 ${entry.supersedes ?? '无'} 实际 ${actualSup ?? '无'}）`);
    }
    const hash = createHash('sha256').update(content).digest('hex');
    if (hash !== entry.contentHash) {
      violations.push(`${label}: 计划 ${entry.id} 内容摘要不符`);
    }
  }
}

/** D1 资格（Critical）：proposal 每条规范引用恰有 1 个绑定 [经验 <id>] 任务；判定集 = 引用集（精确）。 */
async function checkD1(changeDir, label, violations) {
  const proposal = (await readOptional(path.join(changeDir, 'proposal.md'))) ?? '';
  if (!proposal.includes('## 经验引用')) return;
  const retro = (await readOptional(path.join(changeDir, 'retro.md'))) ?? '';
  const tasks = (await readOptional(path.join(changeDir, 'tasks.md'))) ?? '';
  let refs, judgments;
  try {
    refs = parseRecheck(proposal);
  } catch (e) {
    violations.push(`${label}: proposal 解析失败（${e.message ?? e}）`);
    return;
  }
  try {
    judgments = parseRecheck(retro);
  } catch (e) {
    violations.push(`${label}: retro 解析失败（${e.message ?? e}）`);
    return;
  }
  const taskCounts = new Map();
  for (const m of tasks.matchAll(/\[经验 (exp-\d{8}-[a-z0-9-]+)\]/g)) {
    taskCounts.set(m[1], (taskCounts.get(m[1]) ?? 0) + 1);
  }
  const refIds = new Set(refs.refs.map((r) => r.id));
  for (const id of refIds) {
    const c = taskCounts.get(id) ?? 0;
    if (c !== 1) violations.push(`${label}: 引用 ${id} 绑定任务数为 ${c}（须恰 1）`);
  }
  const judIds = new Set(judgments.judgments.map((j) => j.id));
  for (const id of refIds) {
    if (!judIds.has(id)) violations.push(`${label}: 引用 ${id} 缺判定`);
  }
  for (const id of judIds) {
    if (!refIds.has(id)) violations.push(`${label}: 判定 ${id} 不在引用集`);
  }
}

/** 纠错扫描（P1#3）：active 条目若有未撤销负判定（已归档 + 已结案未归档 change）→ 应为 ineffective。 */
async function checkCorrection(root, lessons, violations) {
  const activeIds = new Set(lessons.filter((l) => l.fm.get('status') === 'active').map((l) => l.id));
  if (activeIds.size === 0) return;
  // 资格（P1#2）：由实际经验目录归属推导 isLocal，不靠调用方布尔
  const dir = path.join(root, 'openspec', 'experience');
  let isLocal = false;
  try {
    isLocal = (await fs.realpath(dir)) === dir;
  } catch {
    isLocal = false;
  }
  const unrevoked = new Set();
  const negativeKeys = new Set();
  const revokedKeys = new Set();
  for (const base of [path.join(root, 'openspec', 'changes'), path.join(root, 'openspec', 'changes', 'archive')]) {
    let entries = [];
    try {
      entries = await fs.readdir(base);
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      const cdir = path.join(base, e);
      if (!(await isDir(cdir))) continue;
      let meta;
      try {
        meta = await readMeta(cdir);
      } catch {
        continue;
      }
      if (!(meta.declared && meta.meta.get('schema') === 'experience-loop')) continue;
      const retro = (await readOptional(path.join(cdir, 'retro.md'))) ?? '';
      // 负判定按稳定键 `${change}/${id}/不生效` 聚合（跨 change）
      for (const m of retro.matchAll(JUDGMENT_RE)) {
        if (m[2] === '不生效') negativeKeys.add(`${e}/${m[1]}/不生效`);
      }
      // 撤销按同一稳定键解析，全局生效（后续 change 可撤销前一 change 的判定）
      for (const line of retro.split(/\r?\n/)) {
        if (line.includes('已撤销')) {
          for (const km of line.matchAll(/(\w[\w-]*)\/(exp-\d{8}-[a-z0-9-]+)\/(生效|不生效|不适用)/g)) {
            revokedKeys.add(`${km[1]}/${km[2]}/${km[3]}`);
          }
        }
      }
    }
  }
  for (const key of negativeKeys) {
    if (!revokedKeys.has(key)) unrevoked.add(key.split('/')[1]);
  }
  for (const id of activeIds) {
    if (unrevoked.has(id)) {
      const disp = resolveDisposition({ verdict: '不生效', targetState: 'active', isLocal, revoked: false });
      if (disp === '已应用') {
        violations.push(`${id}.md: 应为 ineffective（存在未撤销的负判定，阻恢复 active）`);
      }
    }
  }
}

async function checkStore(root, lessons, errors, changeDirForPending, violations) {
  violations.push(...errors.map((e) => `经验条目: ${e}`));
  const byId = new Map();

  // ② 字段 / id / date / status
  for (const l of lessons) {
    const m = l.id.match(LESSON_NAME_RE);
    if (!m) {
      violations.push(`${l.name}: 文件名不符合 exp-YYYYMMDD-<slug>.md`);
      continue;
    }
    for (const f of REQUIRED_FIELDS) {
      if (!l.fm.has(f)) violations.push(`${l.name}: frontmatter 缺字段 ${f}`);
    }
    if (l.fm.get('id') !== l.id) violations.push(`${l.name}: id 与文件名不一致`);
    const date = l.fm.get('date');
    if (typeof date === 'string' && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      violations.push(`${l.name}: date 不是 YYYY-MM-DD`);
    } else if (typeof date === 'string' && date.replace(/-/g, '') !== m[1]) {
      violations.push(`${l.name}: date 与文件名内嵌日期不一致`);
    }
    const status = l.fm.get('status');
    if (typeof status !== 'string' || !STATUSES.has(status)) {
      violations.push(`${l.name}: status 必须为 active|ineffective|superseded|expired`);
    }
    if (l.firstLine === undefined) violations.push(`${l.name}: 缺「## 教训」首行`);
    byId.set(l.id, l);
  }

  // ③ INDEX 逐列比对（双向映射）
  const indexText = await readOptional(path.join(root, 'openspec', 'experience', 'INDEX.md'));
  let rows = [];
  if (indexText !== undefined) {
    try {
      rows = parseIndex(indexText, 'INDEX.md');
    } catch (e) {
      violations.push(`INDEX.md: ${e.message ?? e}`);
    }
  }
  const rowById = new Map();
  for (const row of rows) {
    if (rowById.has(row.id)) violations.push(`INDEX.md: ${row.id} 重复行`);
    rowById.set(row.id, row);
    if (!byId.has(row.id)) violations.push(`INDEX.md: ${row.id} 无对应经验文件`);
  }
  for (const l of lessons) {
    const row = rowById.get(l.id);
    if (!row) {
      violations.push(`${l.name}: INDEX.md 缺对应行`);
      continue;
    }
    if (row.capability !== l.fm.get('capability')) violations.push(`${l.name}: INDEX capability 列不一致`);
    const rowTags = row.tags.split(',').map((s) => s.trim()).filter(Boolean).sort().join(',');
    const fmTags = (Array.isArray(l.fm.get('tags')) ? l.fm.get('tags') : []).map(String).sort().join(',');
    if (rowTags !== fmTags) violations.push(`${l.name}: INDEX tags 列不一致`);
    if (row.status !== l.fm.get('status')) violations.push(`${l.name}: INDEX status 列不一致`);
    if (normalize(row.lesson) !== normalize(l.firstLine ?? '')) violations.push(`${l.name}: INDEX 教训列与「## 教训」首行不一致`);

    // ④ capability（仅 active）
    if (l.fm.get('status') === 'active') {
      const cap = l.fm.get('capability');
      if (cap !== 'general' && typeof cap === 'string') {
        const main = await isDir(path.join(root, 'openspec', 'specs', cap));
        const pending = changeDirForPending
          ? await isDir(path.join(changeDirForPending, 'specs', cap))
          : false;
        if (!main && !pending) {
          violations.push(`${l.name}: capability "${cap}" 不存在于主 specs${changeDirForPending ? ' 或该 change 的 delta specs' : ''}（active 条目；退役/改名请改标 general 或 expired）`);
        }
      }
    }
  }

  // ⑤ 重复检测（双 active 同 capability 同教训；直接 supersede 配对豁免）
  const groups = new Map();
  for (const l of lessons) {
    if (l.fm.get('status') !== 'active' || l.firstLine === undefined) continue;
    const key = `${l.fm.get('capability')}::${normalize(l.firstLine)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(l);
  }
  for (const [key, group] of groups) {
    if (group.length < 2) continue;
    const linked =
      group.length === 2 &&
      (group[0].fm.get('supersedes') === group[1].id || group[1].fm.get('supersedes') === group[0].id);
    if (!linked) {
      violations.push(`重复经验（同 capability 同教训）: ${group.map((l) => l.id).join(', ')} —— 建议 supersede 取代而非并存`);
    }
  }

  // ⑥ supersede 链完整性（无前提检查）
  for (const l of lessons) {
    const sup = l.fm.get('supersedes');
    if (sup === undefined || sup === '') continue;
    if (sup === l.id) {
      violations.push(`${l.name}: supersedes 禁止自指`);
      continue;
    }
    const target = byId.get(sup);
    if (!target) {
      violations.push(`${l.name}: supersedes 目标 "${sup}" 不存在（拼错或已删除）`);
      continue;
    }
    if (target.fm.get('status') !== 'superseded') {
      violations.push(`${l.name}: supersedes 目标 "${sup}" 的 status 应为 superseded（补改旧条 status: superseded）`);
    }
    // 环检测：沿链下行
    const seen = new Set([l.id]);
    let cur = target;
    while (cur.fm.get('supersedes')) {
      if (seen.has(cur.id)) {
        violations.push(`${l.name}: supersede 链成环（${[...seen, cur.id].join(' -> ')}）`);
        break;
      }
      seen.add(cur.id);
      const next = byId.get(cur.fm.get('supersedes'));
      if (!next) break;
      cur = next;
    }
  }

  // 反向映射（P1#2）：每个 superseded 恰有一个入边；缺边/多入边 → 替代关系异常，不编 ID。
  const inEdges = new Map();
  for (const l of lessons) {
    const sup = l.fm.get('supersedes');
    if (sup) {
      if (!inEdges.has(sup)) inEdges.set(sup, []);
      inEdges.get(sup).push(l.id);
    }
  }
  for (const l of lessons) {
    if (l.fm.get('status') === 'superseded') {
      const ins = inEdges.get(l.id) || [];
      if (ins.length !== 1) {
        violations.push(`${l.name}: 已过时，替代关系异常（superseded ${ins.length === 0 ? '缺入边' : '多入边'}）`);
      }
    }
  }
}

async function resolveChange(root, name) {
  const changes = path.join(root, 'openspec', 'changes');
  const direct = path.join(changes, name);
  if (await isDir(direct)) return direct;
  const archive = path.join(changes, 'archive');
  const exact = path.join(archive, name);
  if (await isDir(exact)) return exact;
  let entries = [];
  try {
    entries = await fs.readdir(archive);
  } catch {
    /* 无 archive 目录 */
  }
  const matches = entries.filter((e) => e === name || e.endsWith(`-${name}`));  if (matches.length === 1) return path.join(archive, matches[0]);
  return null;
}

function percent(x, n) {
  return n === 0 ? 'n/a' : `${Math.round((x / n) * 100)}%`;
}

function proposalRefs(text) {
  const lines = text.split(/\r?\n/);
  const idx = lines.findIndex((l) => l.trim() === '## 经验引用');
  if (idx === -1) return [];
  const ids = new Set();
  for (let i = idx + 1; i < lines.length; i += 1) {
    if (lines[i].startsWith('## ')) break;
    for (const m of lines[i].matchAll(REF_ID_RE)) ids.add(m[0]);
  }
  return [...ids];
}

function judgmentIds(text) {
  const ids = new Set();
  for (const m of text.matchAll(JUDGMENT_RE)) ids.add(m[1]);
  return ids;
}

async function report(root, lessons) {
  const storeIds = new Set(lessons.map((l) => l.id));
  const changes = [];
  for (const base of [path.join(root, 'openspec', 'changes'), path.join(root, 'openspec', 'changes', 'archive')]) {
    let entries = [];
    try {
      entries = await fs.readdir(base);
    } catch {
      continue;
    }
    for (const e of entries.sort()) {
      const dir = path.join(base, e);
      if (!(await isDir(dir))) continue;
      try {
        const meta = await readMeta(dir);
        if (meta.declared && meta.meta.get('schema') === 'experience-loop') changes.push(dir);
      } catch {
        /* report 不判违规：元数据不可读的 change 不计入分母 */
      }
    }
  }

  let refChanges = 0;
  let dangling = 0;
  let pairs = 0;
  let closedPairs = 0;
  const referencedIds = new Set();
  const judgedIds = new Set();
  let judgments = 0;
  let effective = 0;

  for (const dir of changes) {
    const proposal = (await readOptional(path.join(dir, 'proposal.md'))) ?? '';
    const retro = (await readOptional(path.join(dir, 'retro.md'))) ?? '';
    const refs = proposalRefs(proposal);
    const inStore = refs.filter((id) => storeIds.has(id));
    dangling += refs.filter((id) => !storeIds.has(id)).length;
    if (inStore.length >= 1) refChanges += 1;

    const judged = judgmentIds(retro);
    for (const id of judged) judgedIds.add(id);
    for (const m of retro.matchAll(JUDGMENT_RE)) {
      judgments += 1;
      if (m[2] === '生效') effective += 1;
    }
    for (const id of inStore) {
      referencedIds.add(id);
      pairs += 1;
      if (judged.has(id)) closedPairs += 1;
    }
  }

  const n = changes.length;
  const uidCovered = [...referencedIds].filter((id) => judgedIds.has(id)).length;
  const lines = [
    `experience-loop changes: ${n}`,
    `引用率: ${percent(refChanges, n)} (${refChanges}/${n})`,
    `引用对覆盖率: ${percent(closedPairs, pairs)} (${closedPairs}/${pairs})`,
    `唯一ID覆盖率: ${percent(uidCovered, referencedIds.size)} (${uidCovered}/${referencedIds.size})`,
    `悬空引用数: ${dangling}`,
    `生效率: ${percent(effective, judgments)} (${effective}/${judgments})`,
  ];
  process.stdout.write(lines.join('\n') + '\n');
}

async function main() {
  const argv = process.argv.slice(2);
  const opt = { project: undefined, change: undefined, report: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--project') opt.project = argv[++i];
    else if (a === '--change') opt.change = argv[++i];
    else if (a === '--report') opt.report = true;
    else if (a === '--protocol-info') {
      // 能力探针（D4）：旧 lint 无此参数（退 2）→ 调用方据此拒绝启用。
      process.stdout.write('experience-recheck-v1\n');
      process.exit(0);
    } else {
      process.stderr.write(`experience-lint: 未知参数 ${a}\n`);
      process.exit(2);
    }
  }
  if (!opt.project) {
    process.stderr.write('experience-lint: 缺少 --project <root>\n');
    process.exit(2);
  }
  const root = path.resolve(opt.project);
  const { lessons, errors } = await collectLessons(root);

  if (opt.report) {
    await report(root, lessons);
    process.exit(0);
  }

  const violations = [];
  await checkBoundary(root, violations);
  let pendingDir = null;
  if (opt.change !== undefined) {
    const resolved = await resolveChange(root, opt.change);
    if (!resolved) {
      violations.push(`change "${opt.change}": 未找到（active 或 archive 下均无唯一匹配）`);
    } else {
      pendingDir = resolved;
      await checkRetro(resolved, `change ${opt.change}`, violations);
      await checkPlan(resolved, root, `change ${opt.change}`, violations);
      await checkD1(resolved, `change ${opt.change}`, violations);
    }
  } else {
    let entries = [];
    try {
      entries = await fs.readdir(path.join(root, 'openspec', 'changes', 'archive'));
    } catch {
      /* 无归档集合 */
    }
    for (const e of entries.sort()) {
      const dir = path.join(root, 'openspec', 'changes', 'archive', e);
      if (await isDir(dir)) await checkRetro(dir, `归档 change ${e}`, violations);
    }
  }

  await checkStore(root, lessons, errors, pendingDir, violations);
  await checkCorrection(root, lessons, violations);

  if (violations.length > 0) {
    process.stdout.write(violations.join('\n') + '\n');
    process.exit(1);
  }
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
