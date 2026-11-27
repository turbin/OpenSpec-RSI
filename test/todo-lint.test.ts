import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLint } from '../scripts/todo-lint.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(REPO, 'scripts', 'todo-lint.mjs');

function mkRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'todo-lint-'));
  fs.mkdirSync(path.join(root, 'issue'), { recursive: true });
  return root;
}

function writeTodo(
  root: string,
  id: string,
  opts: { status?: string; title?: string; summary?: string } = {},
): void {
  const { status = '未开始', title = `标题 ${id}`, summary = `摘要 ${id}` } = opts;
  const fm = ['---', `id: ${id}`, `title: ${title}`, `status: ${status}`, `summary: ${summary}`, '---', '正文'].join('\n');
  fs.writeFileSync(path.join(root, 'issue', `${id}.md`), fm);
}

function writeIndex(root: string, rows: string[]): void {
  fs.writeFileSync(path.join(root, 'issue', 'INDEX.md'), '# header\n' + (rows.length ? rows.join('\n') + '\n' : ''));
}

describe('todo-lint', () => {
  it('文件无对应 INDEX 行 → 违规', () => {
    const root = mkRoot();
    writeTodo(root, 'todo-001');
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('todo-001') && v.includes('缺'))).toBe(true);
  });

  it('孤儿索引行：INDEX 有行、无对应文件 → 违规', () => {
    const root = mkRoot();
    writeIndex(root, ['| todo-ghost | 标题 | 未开始 | 摘要 |']);
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('todo-ghost') && v.includes('无对应'))).toBe(true);
  });

  it('列漂移：INDEX 行与文件 frontmatter 不一致 → 违规', () => {
    const root = mkRoot();
    writeTodo(root, 'todo-001', { summary: '真实摘要' });
    writeIndex(root, ['| todo-001 | 标题 todo-001 | 未开始 | 漂移的摘要 |']);
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('todo-001') && v.includes('不一致'))).toBe(true);
  });

  it('干净态：文件与 INDEX 一致 → violations 为空', () => {
    const root = mkRoot();
    writeTodo(root, 'todo-001', { summary: '一致摘要' });
    writeIndex(root, ['| todo-001 | 标题 todo-001 | 未开始 | 一致摘要 |']);
    const { violations } = runLint(root);
    expect(violations).toEqual([]);
  });

  it('空 issue/ 目录 → violations 为空（不崩溃）', () => {
    const root = mkRoot();
    const { violations } = runLint(root);
    expect(violations).toEqual([]);
  });

  it('状态不在四态 → 违规', () => {
    const root = mkRoot();
    writeTodo(root, 'todo-001', { status: '进行中ing' });
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('todo-001') && v.includes('状态'))).toBe(true);
  });

  it('文件名-id 不符 → 违规', () => {
    const root = mkRoot();
    const fm = ['---', 'id: bar', 'title: t', 'status: 未开始', 'summary: s', '---', 'x'].join('\n');
    fs.writeFileSync(path.join(root, 'issue', 'foo.md'), fm);
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('foo.md') && v.includes('id'))).toBe(true);
  });

  it('summary 含 | 或换行 → 违规（不静默错解）', () => {
    const root = mkRoot();
    writeTodo(root, 'todo-001', { summary: '含|竖线' });
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('todo-001') && v.includes('summary'))).toBe(true);
  });

  it('CLI 退出码：干净→0，违规→1 且 stderr 含违规', () => {
    const clean = mkRoot();
    writeTodo(clean, 'todo-001');
    writeIndex(clean, ['| todo-001 | 标题 todo-001 | 未开始 | 摘要 todo-001 |']);
    const ok = spawnSync('node', [CLI, '--project', clean], { encoding: 'utf-8' });
    expect(ok.status).toBe(0);

    const bad = mkRoot();
    writeTodo(bad, 'todo-001');
    const r = spawnSync('node', [CLI, '--project', bad], { encoding: 'utf-8' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('缺');
  });

  it('INDEX 重复 id（矛盾行）→ 违规（不静默去重）', () => {
    const root = mkRoot();
    writeTodo(root, 'todo-001', { status: '已完成' });
    writeIndex(root, [
      '| todo-001 | 标题 todo-001 | 未开始 | 摘要 todo-001 |',
      '| todo-001 | 标题 todo-001 | 已完成 | 摘要 todo-001 |',
    ]);
    const { violations } = runLint(root);
    expect(violations.some((v) => v.includes('todo-001') && v.includes('重复'))).toBe(true);
  });
});
