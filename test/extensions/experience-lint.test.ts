import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const lintScript = path.join(repoRoot, 'extensions', 'experience-loop', 'scripts', 'experience-lint.mjs');
const templatePath = path.join(repoRoot, 'extensions', 'experience-loop', 'experience-store', '_template.md');

function runLint(root: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [lintScript, '--project', root, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-exp-lint-'));
  fs.mkdirSync(path.join(root, 'openspec', 'changes'), { recursive: true });
  fs.mkdirSync(path.join(root, 'openspec', 'specs'), { recursive: true });
  fs.mkdirSync(path.join(root, 'openspec', 'experience'), { recursive: true });
  return root;
}

interface ChangeOpts {
  meta?: string | null; // .openspec.yaml 全文；null 表示不创建
  retro?: string | null; // retro.md 全文；null 表示不创建
  specs?: string[]; // 该 change delta 声明的 capability 目录
  archived?: boolean;
}

function writeChange(root: string, name: string, opts: ChangeOpts = {}): string {
  const dir = opts.archived
    ? path.join(root, 'openspec', 'changes', 'archive', `2026-01-02-${name}`)
    : path.join(root, 'openspec', 'changes', name);
  fs.mkdirSync(dir, { recursive: true });
  if (opts.meta !== null && opts.meta !== undefined) {
    fs.writeFileSync(path.join(dir, '.openspec.yaml'), opts.meta);
  } else if (opts.meta === undefined) {
    fs.writeFileSync(path.join(dir, '.openspec.yaml'), 'schema: experience-loop\n');
  }
  if (opts.retro !== undefined && opts.retro !== null) {
    fs.writeFileSync(path.join(dir, 'retro.md'), opts.retro);
  }
  for (const cap of opts.specs ?? []) {
    fs.mkdirSync(path.join(dir, 'specs', cap), { recursive: true });
    fs.writeFileSync(path.join(dir, 'specs', cap, 'spec.md'), `# ${cap}\n\n## Purpose\n\np\n\n## Requirements\n\n### Requirement: r\n\nSHALL x\n`);
  }
  return dir;
}

const REAL_RETRO = '# Retro\n\n## 声称 vs 实际\n\na\n\n## 教训\n\nl\n\n## 依据\n\nd\n\n## 经验处置\n\nn\n\n## 上次经验复查\n\n无可复查项\n';
const STUB_RETRO = 'skipped: x-skip-retro\n';

interface LessonOpts {
  id: string;
  date?: string;
  capability?: string;
  tags?: string;
  status?: string;
  supersedes?: string;
  verification?: string | null; // null = 省略该字段
  lesson?: string;
  writeIndexRow?: boolean; // 默认 true
  indexRowOverride?: string;
}

function writeLesson(root: string, opts: LessonOpts): void {
  const {
    id, date = '2026-01-01', capability = 'general', tags = '[a]', status = 'active',
    supersedes, verification = 'verify it', lesson = 'lesson text',
    writeIndexRow = true, indexRowOverride,
  } = opts;
  const lines = ['---', `id: ${id}`, `date: ${date}`, `source_change: demo`, `capability: ${capability}`, `tags: ${tags}`, `status: ${status}`];
  if (supersedes !== undefined) lines.push(`supersedes: ${supersedes}`);
  if (verification !== null) lines.push(`verification: ${verification}`);
  lines.push('---', '', '## 教训', '', lesson, '', '## 依据', '', 'because');
  fs.writeFileSync(path.join(root, 'openspec', 'experience', `${id}.md`), lines.join('\n') + '\n');
  if (writeIndexRow) {
    const row = indexRowOverride ?? `| ${id} | ${capability} | ${tags.replace(/[[\]]/g, '')} | ${status} | ${lesson} |`;
    fs.appendFileSync(path.join(root, 'openspec', 'experience', 'INDEX.md'), row + '\n');
  }
}

function writeProposal(root: string, changeName: string, body: string): void {
  fs.writeFileSync(path.join(root, 'openspec', 'changes', changeName, 'proposal.md'), body);
}

describe('experience-lint ① retro 存在性', () => {
  it('缺 retro 无豁免 → exit 1', () => {
    const root = makeProject();
    writeChange(root, 'a', { retro: null });
    const r = runLint(root, ['--change', 'a']);
    expect(r.status).toBe(1);
  });

  it('x-skip-retro: true + stub → exit 0', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'schema: experience-loop\nx-skip-retro: true\n', retro: STUB_RETRO });
    expect(runLint(root, ['--change', 'a']).status).toBe(0);
  });

  it('豁免但无 retro 文件 → exit 1', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'schema: experience-loop\nx-skip-retro: true\n', retro: null });
    const r = runLint(root, ['--change', 'a']);
    expect(r.status).toBe(1);
  });

  it('无豁免但 retro 为 stub 形态 → exit 1', () => {
    const root = makeProject();
    writeChange(root, 'a', { retro: STUB_RETRO });
    const r = runLint(root, ['--change', 'a']);
    expect(r.status).toBe(1);
  });

  it('有豁免 + 真实 retro → exit 0', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'schema: experience-loop\nx-skip-retro: true\n', retro: REAL_RETRO });
    expect(runLint(root, ['--change', 'a']).status).toBe(0);
  });

  it('x-skip-retro: yes → exit 1 且报错点名 x-skip-retro', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'schema: experience-loop\nx-skip-retro: yes\n', retro: REAL_RETRO });
    const r = runLint(root, ['--change', 'a']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('x-skip-retro');
  });

  it('豁免键拼错（x_skip_retro）→ exit 1 且报错点名期望键名 x-skip-retro', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'schema: experience-loop\nx_skip_retro: true\n', retro: null });
    const r = runLint(root, ['--change', 'a']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr, '诊断应点名期望键名').toContain('x-skip-retro');
  });
});

describe('experience-lint ① 范围限定与阶段契约', () => {
  it('显式其它 schema 无 retro → exit 0', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'schema: spec-driven\n', retro: null });
    expect(runLint(root, ['--change', 'a']).status).toBe(0);
  });

  it('未声明 schema → exit 0', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'name: demo\n', retro: null });
    expect(runLint(root, ['--change', 'a']).status).toBe(0);
  });

  it('.openspec.yaml 损坏 → exit 1（fail-loud，不当豁免）', () => {
    const root = makeProject();
    writeChange(root, 'a', { meta: 'this is not valid yaml metadata', retro: null });
    const r = runLint(root, ['--change', 'a']);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('a');
  });

  it('阶段契约：默认模式 active 缺 retro 通过、archive 缺 retro 失败、补齐后通过', () => {
    const root = makeProject();
    writeChange(root, 'wip', { retro: null });
    expect(runLint(root).status, '规划期提交应通过').toBe(0);

    writeChange(root, 'done', { retro: null, archived: true });
    expect(runLint(root).status, '归档集合缺 retro 应失败').toBe(1);

    writeChange(root, 'done', { retro: REAL_RETRO, archived: true });
    expect(runLint(root).status, '补齐后应通过').toBe(0);
  });
});

describe('experience-lint ②③ 字段与 INDEX 一致性', () => {
  it('INDEX 删一行 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', writeIndexRow: false });
    expect(runLint(root).status).toBe(1);
  });

  it('INDEX 行 status 列与文件不符 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, {
      id: 'exp-20260101-alpha',
      indexRowOverride: '| exp-20260101-alpha | general | a | expired | lesson text |',
    });
    expect(runLint(root).status).toBe(1);
  });

  it('frontmatter 缺 verification → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', verification: null });
    expect(runLint(root).status).toBe(1);
  });

  it('文件名内嵌日期与 date 不一致 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', date: '2026-01-02' });
    expect(runLint(root).status).toBe(1);
  });

  it('CRLF 换行的经验文件与 INDEX 可正常校验', () => {
    const root = makeProject();
    const fm = [
      '---', 'id: exp-20260101-alpha', 'date: 2026-01-01', 'source_change: demo',
      'capability: general', 'tags: [a]', 'status: active', 'verification: verify it', '---',
      '', '## 教训', '', 'crlf lesson', '', '## 依据', '', 'because',
    ];
    fs.writeFileSync(
      path.join(root, 'openspec', 'experience', 'exp-20260101-alpha.md'),
      fm.join('\r\n') + '\r\n'
    );
    fs.writeFileSync(
      path.join(root, 'openspec', 'experience', 'INDEX.md'),
      '| exp-20260101-alpha | general | a | active | crlf lesson |\r\n'
    );
    expect(runLint(root).status).toBe(0);
  });
});

describe('experience-lint ④ capability 校验', () => {
  it('active 条目 capability 不存在 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', capability: 'nope' });
    expect(runLint(root).status).toBe(1);
  });

  it('待同步 capability：--change 放行、默认模式拒绝', () => {
    const root = makeProject();
    writeChange(root, 'c1', { specs: ['new-cap'], retro: REAL_RETRO });
    writeLesson(root, { id: 'exp-20260101-alpha', capability: 'new-cap' });
    expect(runLint(root, ['--change', 'c1']).status, '--change 应放行待同步 capability').toBe(0);
    expect(runLint(root).status, '默认模式应严格按主 specs').toBe(1);
  });

  it('expired 条目 capability 已不存在 → exit 0', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', capability: 'gone', status: 'expired' });
    expect(runLint(root).status).toBe(0);
  });
});

describe('experience-lint ⑤⑥ 重复与 supersede 链', () => {
  it('双 active 同 capability 同教训 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', lesson: 'Same Lesson' });
    writeLesson(root, { id: 'exp-20260101-beta', lesson: 'same lesson ' });
    expect(runLint(root).status).toBe(1);
  });

  it('合法 supersede 配对（旧条已改 superseded）→ exit 0', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', lesson: 'Same Lesson', status: 'superseded' });
    writeLesson(root, { id: 'exp-20260101-beta', lesson: 'Same Lesson', supersedes: 'exp-20260101-alpha' });
    expect(runLint(root).status).toBe(0);
  });

  it('新条 supersedes 旧条但旧条仍 active → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', lesson: 'rewritten lesson' });
    writeLesson(root, { id: 'exp-20260101-beta', lesson: 'rewritten lesson', supersedes: 'exp-20260101-alpha' });
    const r = runLint(root);
    expect(r.status).toBe(1);
    expect(r.stdout + r.stderr).toContain('superseded');
  });

  it('supersedes 悬空目标 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-beta', lesson: 'rewritten lesson', supersedes: 'exp-20260101-ghost' });
    expect(runLint(root).status).toBe(1);
  });

  it('supersedes 自指 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-alpha', supersedes: 'exp-20260101-alpha' });
    expect(runLint(root).status).toBe(1);
  });

  it('supersede 链成环 → exit 1', () => {
    const root = makeProject();
    writeLesson(root, { id: 'exp-20260101-a1', status: 'superseded', supersedes: 'exp-20260101-a3', lesson: 'l1' });
    writeLesson(root, { id: 'exp-20260101-a2', status: 'superseded', supersedes: 'exp-20260101-a1', lesson: 'l2' });
    writeLesson(root, { id: 'exp-20260101-a3', status: 'active', supersedes: 'exp-20260101-a2', lesson: 'l3' });
    expect(runLint(root).status).toBe(1);
  });
});

describe('experience-lint --report 度量', () => {
  it('分母/引用率/引用对覆盖率/悬空引用数口径正确，违规文件仍 exit 0，--report 优先于 --change', () => {
    const root = makeProject();
    // 分母外：未声明 experience-loop
    writeChange(root, 'legacy', { meta: 'schema: spec-driven\n', retro: REAL_RETRO });
    // 引用两条库内经验、只复查一条
    writeChange(root, 'c-ref', { retro: REAL_RETRO });
    writeProposal(root, 'c-ref', '# p\n\n## 经验引用\n\n- exp-20260101-alpha\n- exp-20260101-beta\n');
    fs.appendFileSync(
      path.join(root, 'openspec', 'changes', 'c-ref', 'retro.md'),
      '\n- [经验 exp-20260101-alpha] 判定: 生效 — 按约定完成\n'
    );
    // 悬空引用
    writeChange(root, 'c-dangle', { retro: REAL_RETRO });
    writeProposal(root, 'c-dangle', '# p\n\n## 经验引用\n\n- exp-20260101-missing\n');
    // 库内两条合法经验（不同教训避免 ⑤）；另放一条违规经验（缺 verification）证明 report 不判违规
    writeLesson(root, { id: 'exp-20260101-alpha', lesson: 'alpha lesson' });
    writeLesson(root, { id: 'exp-20260101-beta', lesson: 'beta lesson' });
    writeLesson(root, { id: 'exp-20260101-bad', verification: null, lesson: 'bad lesson' });

    const r = runLint(root, ['--report']);
    expect(r.status, 'report 模式恒 exit 0').toBe(0);
    expect(r.stdout).toContain('experience-loop changes: 2');
    expect(r.stdout).toContain('引用率: 50%');
    expect(r.stdout).toContain('引用对覆盖率: 50%');
    expect(r.stdout).toContain('悬空引用数: 1');

    // --report 与 --change 同给：忽略校验（该 change 无 retro 也不报）
    writeChange(root, 'c-no-retro', { retro: null });
    expect(runLint(root, ['--report', '--change', 'c-no-retro']).status).toBe(0);
  });
});

describe('经验条目字段规范同步（N18）', () => {
  it('_template.md frontmatter 键集 == lint 认识的字段全集', async () => {
    const lint = await import(lintScript);
    const expected = new Set(lint.EXPERIENCE_FIELDS as string[]);
    const raw = fs.readFileSync(templatePath, 'utf-8');
    const match = raw.match(/^---\n([\s\S]*?)\n---/);
    expect(match, '_template.md 应有 frontmatter').toBeTruthy();
    const keys = new Set(
      match![1].split('\n').map((l) => l.split(':')[0].trim()).filter(Boolean)
    );
    expect(keys).toEqual(expected);
  });
});
