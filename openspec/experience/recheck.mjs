// 负面经验回灌 · 纯机制逻辑（状态迁移表）。
// 状态四态；"未列事件"= 本功能自动写入一律不写（返回 null）。
// 迁移表见 docs/superpowers/specs/2026-11-20-negative-experience-reinjection-design.md。

export const STATUSES = new Set(['active', 'ineffective', 'superseded', 'expired']);

/**
 * 给定当前状态与事件，返回迁移后的状态；返回 null = 本功能不自动写。
 * ev.kind: 'negative'(合格负判定) | 'negative-unqualified' | 'supersede' |
 *          'retire' | 'effective' | 'na'
 */
export function nextStatus(current, ev) {
  if (!STATUSES.has(current)) return null;
  const k = ev && ev.kind;
  if (k === 'effective' || k === 'na' || k === 'negative-unqualified') return null;
  if (k === 'negative') {
    // active → ineffective；ineffective 幂等自环；superseded/expired 终态优先不变。
    return current === 'active' ? 'ineffective' : current;
  }
  if (k === 'supersede') {
    // active/ineffective/expired → superseded（expired 为允许的人工处置）；
    // superseded 未列 → 不写。
    if (current === 'active' || current === 'ineffective' || current === 'expired') return 'superseded';
    return null;
  }
  if (k === 'retire') {
    // active → expired（允许的人工处置）；其余不变（ineffective 不自动过期）。
    return current === 'active' ? 'expired' : current;
  }
  return null; // 未知事件 → 不写
}

// ── 三段解析（D1）──
// 只读唯一顶层二级段 `## 经验引用`/`## 经验警示`/`## 上次经验复查`，
// 跳过注释与围栏；形似规范行但 ID 非法 → 抛错（不静默跳过）。
const ID = 'exp-\\d{8}-[a-z0-9-]+';
const RE_IDVAL = new RegExp(`^${ID}$`);
const RE_REF = new RegExp(`^- \\[经验 (${ID})\\]`);
const RE_WARN = new RegExp(`^- \\[警示 (${ID})\\][\\s\\S]*?直接替代 (${ID})`);
// 判定：verdict 后不得紧跟字母/数字/CJK（防"不生效了"被截成"不生效"）
const RE_JUDGE = new RegExp(`^- \\[经验 (${ID})\\] 判定: (生效|不生效|不适用)(?![0-9A-Za-z\\u4e00-\\u9fff])`);
const RE_LOOKS = /^- \[(?:经验|警示) /;
const TARGETS = new Set(['经验引用', '经验警示', '上次经验复查']);

/**
 * 解析三段规范行。返回 { refs, warnings, judgments }。
 * warnings[].replaces（替代 ID）永不进入 refs。
 * 围栏内（含标题）与 HTML 注释内均不计；形似规范行但缺括号/ID 非法/尾随字/目标段重复 → 抛错。
 */
export function parseRecheck(md) {
  const refs = [], warnings = [], judgments = [];
  const lines = String(md).split(/\r?\n/);
  let section = null, inFence = false, inHtmlComment = false;
  const seen = new Set();
  for (const line of lines) {
    // 围栏优先：围栏内的标题/内容一律不处理
    if (/^```/.test(line)) { inFence = !inFence; continue; }
    if (inFence) continue;
    // HTML 注释块
    if (inHtmlComment) { if (line.includes('-->')) inHtmlComment = false; continue; }
    if (line.includes('<!--')) { if (!line.includes('-->')) inHtmlComment = true; continue; }
    const h = line.match(/^##\s+(.*)$/);
    if (h) {
      const title = h[1].trim();
      if (TARGETS.has(title)) {
        if (seen.has(title)) throw new Error(`recheck: 目标段重复 "${title}"`);
        seen.add(title);
      }
      section = title;
      continue;
    }
    if (!section || !TARGETS.has(section)) continue;
    if (/^#/.test(line)) continue;
    const lm = line.match(/^- \[(?:经验|警示) ([^\]]*)\]/);
    if (RE_LOOKS.test(line)) {
      if (!lm) throw new Error(`recheck: 规范行缺右括号 "${line.trim()}"`);
      if (!RE_IDVAL.test(lm[1].trim())) throw new Error(`recheck: 规范行 ID 非法 "${lm[1]}"`);
    }
    if (section === '经验引用') {
      const m = line.match(RE_REF); if (m) refs.push({ id: m[1] });
    } else if (section === '经验警示') {
      const m = line.match(RE_WARN);
      if (m) warnings.push({ id: m[1], replaces: m[2] });
      else if (lm) throw new Error('recheck: 警示行格式错（缺「直接替代」ID）');
    } else if (section === '上次经验复查') {
      const m = line.match(RE_JUDGE);
      if (m) judgments.push({ id: m[1], verdict: m[2] });
      else if (lm) throw new Error('recheck: 判定行格式错');
    }
  }
  return { refs, warnings, judgments };
}

/**
 * 处置决议（D2/D3）。按四义决议表：
 * 资格：isLocal=false（共享/未授权根）→ 仅记录；
 * 目标已 superseded/expired → 终态无需改；
 * revoked（显式纠错）→ 已撤销；否则 → 已应用。
 */
export function resolveDisposition(input) {
  const { targetState, isLocal, revoked } = input || {};
  if (!isLocal) return '仅记录';
  if (targetState === 'superseded' || targetState === 'expired') return '终态无需改';
  if (revoked) return '已撤销';
  return '已应用';
}
