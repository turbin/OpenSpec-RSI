import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LINT = path.join(REPO, 'extensions', 'experience-loop', 'scripts', 'experience-lint.mjs');

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-recheck-'));
  fs.mkdirSync(path.join(root, 'openspec', 'experience'), { recursive: true });
  return root;
}

interface LessonSpec {
  id: string;
  status?: string;
  supersedes?: string;
  capability?: string;
  tags?: string;
  lesson?: string;
  date?: string;
}

function writeLesson(root: string, l: LessonSpec): void {
  const {
    id, status = 'active', supersedes, capability = 'general',
    tags = '[t1]', lesson = '教训文本', date = '2026-11-20',
  } = l;
  const lines = [
    '---', `id: ${id}`, `date: ${date}`, 'source_change: demo',
    `capability: ${capability}`, `tags: ${tags}`, `status: ${status}`,
  ];
  if (supersedes !== undefined) lines.push(`supersedes: ${supersedes}`);
  lines.push('verification: v', '---', '## 教训', lesson);
  fs.writeFileSync(path.join(root, 'openspec', 'experience', `${id}.md`), lines.join('\n'));

  const idx = path.join(root, 'openspec', 'experience', 'INDEX.md');
  const row = `| ${id} | ${capability} | ${tags.replace(/[[\]]/g, '')} | ${status} | ${lesson} |`;
  const existing = fs.existsSync(idx) ? fs.readFileSync(idx, 'utf-8') : '# header\n';
  fs.writeFileSync(idx, existing + row + '\n');
}

function writeChange(
  root: string,
  name: string,
  opts: { meta?: string; retro?: string; plan?: unknown } = {},
): void {
  const dir = path.join(root, 'openspec', 'changes', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, '.openspec.yaml'),
    opts.meta ?? 'schema: experience-loop\nx-skip-retro: true\n',
  );
  fs.writeFileSync(path.join(dir, 'retro.md'), opts.retro ?? 'skipped: x-skip-retro');
  if (opts.plan !== undefined) {
    fs.writeFileSync(path.join(dir, '.recheck-plan.json'), JSON.stringify(opts.plan));
  }
}

function lessonHash(root: string, id: string): string {
  const content = fs.readFileSync(path.join(root, 'openspec', 'experience', `${id}.md`), 'utf-8');
  return createHash('sha256').update(content).digest('hex');
}

function writeProposal(root: string, name: string, proposal: string): void {
  const dir = path.join(root, 'openspec', 'changes', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'proposal.md'), proposal);
}

function runLint(args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync('node', [LINT, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('experience-lint 接入 recheck', () => {
  it('status: ineffective 合法（不报"必须为 active|superseded|expired"）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-test', status: 'ineffective' });
    const r = runLint(['--project', root]);
    expect(r.stdout).not.toContain('status 必须为');
    expect(r.status).toBe(0);
  });

  it('能力检查 --protocol-info → 支持（旧 lint 无此参数退 2 → 拒绝启用）', () => {
    const r = runLint(['--protocol-info']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('experience-recheck-v1');
  });

  it('superseded 缺入边 → 报"已过时，替代关系异常"不编 ID', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-orphan', status: 'superseded' });
    const r = runLint(['--project', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('替代关系异常');
    expect(r.stdout).not.toContain('被 undefined');
  });
});

describe('P1 必验', () => {
  it('P1#1 经验文件/INDEX 软链到库外 → lint 违规，且未改外部文件', () => {
    const root = makeProject();
    const ext = path.join(os.tmpdir(), `ext-${Date.now()}-${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(ext, '# header\n');
    fs.symlinkSync(ext, path.join(root, 'openspec', 'experience', 'INDEX.md'));
    const before = fs.readFileSync(ext, 'utf-8');
    const r = runLint(['--project', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/链接|软链|归属/);
    expect(fs.readFileSync(ext, 'utf-8')).toBe(before);
  });

  it('P1#1 普通库内文件 → 通过', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-ok' });
    const r = runLint(['--project', root]);
    expect(r.status).toBe(0);
  });

  it('P1#2 计划未结案（done:false）→ 归档前拒', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-old', status: 'superseded' });
    const h = lessonHash(root, 'exp-20261120-old');
    writeChange(root, 'chg1', { plan: [{ id: 'exp-20261120-old', from: 'active', target: 'superseded', supersedes: null, contentHash: h, done: false }] });
    const r = runLint(['--project', root, '--change', 'chg1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('计划未结案');
  });

  it('P1#2 同 ID 同状态但取代边不同 → 保持未结案', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-b', status: 'superseded' });
    writeLesson(root, { id: 'exp-20261120-new', supersedes: 'exp-20261120-b' });
    const h = lessonHash(root, 'exp-20261120-new');
    writeChange(root, 'chg1', {
      plan: [{ id: 'exp-20261120-new', from: 'active', target: 'active', supersedes: 'exp-20261120-a', contentHash: h, done: true }],
    });
    const r = runLint(['--project', root, '--change', 'chg1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('取代边不符');
  });

  it('P1#2 已审计划全部达成 → 归档前通过', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-old', status: 'active' });
    const h = lessonHash(root, 'exp-20261120-old');
    writeChange(root, 'chg1', { plan: [{ id: 'exp-20261120-old', from: 'active', target: 'active', supersedes: null, contentHash: h, done: true }] });
    const r = runLint(['--project', root, '--change', 'chg1']);
    expect(r.status).toBe(0);
  });

  it('P1#3b 计划条目仅 {id}（缺必填字段）→ 违规（严格契约）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-ok' });
    writeChange(root, 'chg1', { plan: [{ id: 'exp-20261120-ok' }] });
    const r = runLint(['--project', root, '--change', 'chg1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/缺必填字段/);
  });

  it('P1#3 active 条目有未撤销负判定 → 应为 ineffective（阻恢复）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-x', status: 'active' });
    writeChange(root, 'chg1', { retro: '## 上次经验复查\n- [经验 exp-20261120-x] 判定: 不生效 — 依据 y\n' });
    const r = runLint(['--project', root, '--change', 'chg1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ineffective|未撤销/);
  });

  it('P1#3 撤销后新合格负判定 → 仍须回灌（阻恢复）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-x', status: 'active' });
    writeChange(root, 'chgA', {
      retro: '## 经验处置\n- 已撤销: chgA/exp-20261120-x/不生效\n\n## 上次经验复查\n- [经验 exp-20261120-x] 判定: 不生效 — 依据 y\n',
    });
    writeChange(root, 'chgB', { retro: '## 上次经验复查\n- [经验 exp-20261120-x] 判定: 不生效 — 依据 z\n' });
    const r = runLint(['--project', root, '--change', 'chgB']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/ineffective|未撤销/);
  });

  it('P1#3c 跨 change 按稳定键撤销前一 change 的负判定 → 允许恢复（exit 0）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-x', status: 'active' });
    // chgA 有未撤销的负判定
    writeChange(root, 'chgA', { retro: '## 上次经验复查\n- [经验 exp-20261120-x] 判定: 不生效 — 依据 y\n' });
    // 后续 chgC 显式撤销 chgA 的那个稳定键
    writeChange(root, 'chgC', { retro: '## 经验处置\n- 已撤销: chgA/exp-20261120-x/不生效\n' });
    const r = runLint(['--project', root, '--change', 'chgC']);
    expect(r.status).toBe(0);
  });

  it('P1#2b 经验目录本身为链接 → 违规（目录/祖先归属）', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-boundary-'));
    const real = fs.mkdtempSync(path.join(os.tmpdir(), 'exp-boundary-real-'));
    fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
    fs.symlinkSync(real, path.join(root, 'openspec', 'experience'));
    const r = runLint(['--project', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/目录.*链接|无法确认归属/);
  });

  it('P1#2c 经验目录内内部链接 → 违规（拒链接，不只拒外部）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-a' });
    const idx = path.join(root, 'openspec', 'experience', 'INDEX.md');
    fs.unlinkSync(idx);
    fs.symlinkSync(path.join(root, 'openspec', 'experience', 'exp-20261120-a.md'), idx);
    const r = runLint(['--project', root]);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/链接/);
  });
});

describe('Critical v1 协议接线', () => {
  it('change 引用经验但缺绑定任务/判定 → 拒（D1 资格）', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20261120-a' });
    writeChange(root, 'chg1');
    writeProposal(root, 'chg1', '## 经验引用\n- [经验 exp-20261120-a] 采用');
    const r = runLint(['--project', root, '--change', 'chg1']);
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/绑定任务/);
  });

  it('schema 声明 protocol: experience-recheck-v1', () => {
    const schemaPath = path.join(REPO, 'extensions', 'experience-loop', 'schema', 'schema.yaml');
    const schema = fs.readFileSync(schemaPath, 'utf-8');
    expect(schema).toContain('experience-recheck-v1');
  });

  it('lint 使用共享 parseRecheck / resolveDisposition', () => {
    const lintPath = path.join(REPO, 'extensions', 'experience-loop', 'scripts', 'experience-lint.mjs');
    const lint = fs.readFileSync(lintPath, 'utf-8');
    expect(lint).toMatch(/from '\.\/recheck\.mjs'/);
    expect(lint).toContain('parseRecheck');
    expect(lint).toContain('resolveDisposition');
  });
});
