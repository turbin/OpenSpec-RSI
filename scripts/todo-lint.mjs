// todo-lint — issue/ 待办队列的执法脚本（零运行时依赖，同步 API 供测试直接调用）。
// 用法：node scripts/todo-lint.mjs [--project <root>]（默认 cwd）
// 干净 exit 0；有违规 exit 1 并逐条打印。
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const STATUSES = new Set(['未开始', '进行中', '已完成', '受阻']);

function parseFrontmatter(text) {
  const m = text.match(/^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return undefined;
  const fm = new Map();
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) fm.set(kv[1], kv[2].trim());
  }
  return { fm, body: m[2] };
}

function parseIndex(text) {
  const rows = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    if (!line.startsWith('|') || !line.endsWith('|')) throw new Error(`无法解析的 INDEX 行 "${line}"`);
    const cols = line.slice(1, -1).split('|').map((c) => c.trim());
    if (cols.length !== 4) throw new Error(`INDEX 行应为 4 列，实为 ${cols.length} "${line}"`);
    rows.push({ id: cols[0], title: cols[1], status: cols[2], summary: cols[3] });
  }
  return rows;
}

/**
 * 校验 <root>/issue/ 与 <root>/issue/INDEX.md 双向一致。
 * 返回 { violations: string[] }（空数组 = 干净）。
 */
export function runLint(root) {
  const violations = [];
  const dir = path.join(root, 'issue');
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return { violations }; // 无 issue 目录 → 干净
  }

  // 解析 issue/<id>.md（排除 INDEX.md 本身）
  const files = new Map();
  for (const name of names.filter((n) => n.endsWith('.md') && n !== 'INDEX.md').sort()) {
    try {
      const content = readFileSync(path.join(dir, name), 'utf-8');
      const parsed = parseFrontmatter(content);
      if (!parsed) {
        violations.push(`${name}: 缺 frontmatter`);
        continue;
      }
      const id = parsed.fm.get('id');
      // 文件名与 frontmatter id 必须一致
      if (name !== `${id}.md`) violations.push(`${name}: 文件名与 id 不符（id=${id}）`);
      // 状态四态
      if (!STATUSES.has(parsed.fm.get('status'))) violations.push(`${name}: 状态不在四态（${parsed.fm.get('status')}）`);
      // summary 禁 | 或换行（否则破坏 INDEX 表格解析）
      const summary = parsed.fm.get('summary') ?? '';
      if (summary.includes('|') || summary.includes('\n')) violations.push(`${name}: summary 含 | 或换行（破坏 INDEX 解析）`);
      files.set(id, { name, fm: parsed.fm });
    } catch (e) {
      violations.push(`${name}: 读取失败（${e.message}）`);
    }
  }

  // 解析 INDEX.md
  let rows = [];
  const idxPath = path.join(dir, 'INDEX.md');
  if (existsSync(idxPath)) {
    try {
      rows = parseIndex(readFileSync(idxPath, 'utf-8'));
    } catch (e) {
      violations.push(`INDEX.md: ${e.message}`);
    }
  }
  const rowById = new Map();
  const idCounts = new Map();
  for (const row of rows) {
    idCounts.set(row.id, (idCounts.get(row.id) ?? 0) + 1);
    rowById.set(row.id, row);
  }
  // 重复 id → 违规（不静默去重；矛盾行会让 lint 误判"干净"）
  for (const [id, count] of idCounts) {
    if (count > 1) violations.push(`INDEX.md: ${id} 重复出现 ${count} 次`);
  }

  // 文件存在但 INDEX 无对应行 → 缺索引行
  for (const [id, f] of files) {
    if (!rowById.has(id)) violations.push(`${f.name}: INDEX 缺对应行（${id}）`);
  }
  // INDEX 有行、无对应文件 → 孤儿索引行
  for (const [id, row] of rowById) {
    if (!files.has(id)) violations.push(`INDEX.md: ${id} 无对应文件`);
  }
  // 列漂移：INDEX 行与文件 frontmatter 不一致
  for (const [id, f] of files) {
    const row = rowById.get(id);
    if (!row) continue;
    if (
      row.title !== (f.fm.get('title') ?? '') ||
      row.status !== (f.fm.get('status') ?? '') ||
      row.summary !== (f.fm.get('summary') ?? '')
    ) {
      violations.push(`${f.name}: INDEX 行与文件 frontmatter 不一致（${id}）`);
    }
  }

  return { violations };
}

function main() {
  const argv = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--project') root = path.resolve(argv[++i]);
  }
  const { violations } = runLint(root);
  if (violations.length > 0) {
    process.stderr.write(violations.join('\n') + '\n');
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
