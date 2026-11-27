import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from 'yaml';
import { runCLI } from '../helpers/run-cli.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const bundleSource = path.join(repoRoot, 'extensions', 'experience-loop', 'schema');

interface SchemaArtifact {
  id: string;
  generates?: string;
  requires?: string[];
}

function makeFixtureProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-exp-schema-'));
  const target = path.join(root, 'openspec', 'schemas', 'experience-loop');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(bundleSource, target, { recursive: true });
  return root;
}

describe('experience-loop schema bundle', () => {
  it('通过 openspec schema validate 且含 retro 工件', async () => {
    const root = makeFixtureProject();

    const result = await runCLI(['schema', 'validate', 'experience-loop', '--json'], { cwd: root });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);

    const schemaPath = path.join(root, 'openspec', 'schemas', 'experience-loop', 'schema.yaml');
    const schema = parse(fs.readFileSync(schemaPath, 'utf-8')) as { artifacts: SchemaArtifact[] };
    const retro = schema.artifacts.find((a) => a.id === 'retro');
    expect(retro, 'artifacts 应含 id retro').toBeDefined();
    expect(retro!.requires).toEqual(['tasks']);
    expect(retro!.generates).toBe('retro.md');
  }, 60_000);

  it('proposal instruction 含读经验检索协议，模板含经验引用段', async () => {
    const root = makeFixtureProject();

    // 结构断言：检索协议三要素 + 引用落点
    const schemaPath = path.join(root, 'openspec', 'schemas', 'experience-loop', 'schema.yaml');
    const schema = parse(fs.readFileSync(schemaPath, 'utf-8')) as {
      artifacts: Array<SchemaArtifact & { instruction?: string }>;
    };
    const proposal = schema.artifacts.find((a) => a.id === 'proposal');
    expect(proposal?.instruction, 'proposal 应有 instruction').toBeDefined();
    const instruction = proposal!.instruction!;
    expect(instruction, '检索协议应读 INDEX.md').toContain('openspec/experience/INDEX.md');
    expect(instruction, '检索协议应按 capability 过滤').toContain('capability');
    expect(instruction, '检索协议应按 tags 过滤').toContain('tags');
    expect(instruction, '命中条目应按 id 引用').toContain('## 经验引用');

    const template = fs.readFileSync(
      path.join(root, 'openspec', 'schemas', 'experience-loop', 'templates', 'proposal.md'),
      'utf-8'
    );
    expect(template, 'proposal.md 模板应含经验引用段').toContain('## 经验引用');

    // e2e：指令经 openspec instructions 真实注入（防同义反复）
    const created = await runCLI(['new', 'change', 'demo', '--schema', 'experience-loop', '--json'], { cwd: root });
    expect(created.exitCode, `${created.stdout}\n${created.stderr}`).toBe(0);

    const ins = await runCLI(['instructions', 'proposal', '--change', 'demo', '--json'], { cwd: root });
    expect(ins.exitCode, `${ins.stdout}\n${ins.stderr}`).toBe(0);
    const payload = JSON.parse(ins.stdout) as { instruction?: string };
    expect(payload.instruction, 'instructions 输出应含检索协议').toContain('openspec/experience/INDEX.md');
    expect(payload.instruction, 'instructions 输出应含经验引用段').toContain('## 经验引用');
  }, 60_000);

  it('retro instruction 含写经验规程五要点，模板含五节结构', async () => {
    const root = makeFixtureProject();
    const schemaPath = path.join(root, 'openspec', 'schemas', 'experience-loop', 'schema.yaml');
    const schema = parse(fs.readFileSync(schemaPath, 'utf-8')) as {
      artifacts: Array<SchemaArtifact & { instruction?: string }>;
    };
    const retro = schema.artifacts.find((a) => a.id === 'retro');
    const instruction = retro?.instruction ?? '';

    // ① 条件化创建
    expect(instruction, '① 应条件化创建').toContain('仅当实现完成后创建');
    expect(instruction, '① 工作流冲突时本 instruction 优先').toContain('本 instruction 优先');
    // ② 写时去重（supersede 链三态）
    expect(instruction, '② 应起草取代而非平行新增').toContain('supersede');
    expect(instruction, '② 新条填 supersedes').toContain('supersedes');
    expect(instruction, '② 旧条改 superseded').toContain('superseded');
    // ③ 人审协议
    expect(instruction, '③ 应列出草稿待用户确认').toContain('用户确认');
    expect(instruction, '③ 确认后才写入经验库').toContain('openspec/experience/');
    // ④ 豁免规程（stub 蕴含）
    expect(instruction, '④ 应识别 x-skip-retro: true').toContain('x-skip-retro: true');
    expect(instruction, '④ stub 恰为一行标记').toContain('skipped: x-skip-retro');
    // ⑤ 脱敏守卫
    expect(instruction, '⑤ 应含脱敏守卫').toContain('密钥');

    const template = fs.readFileSync(
      path.join(root, 'openspec', 'schemas', 'experience-loop', 'templates', 'retro.md'),
      'utf-8'
    );
    for (const section of ['## 声称 vs 实际', '## 教训', '## 依据', '## 经验处置', '## 上次经验复查']) {
      expect(template, `模板应含 ${section}`).toContain(section);
    }
    expect(template, '复查段应含判定行格式').toContain('判定: 生效|不生效|不适用');
    expect(template, '复查段应要求依据验证任务证据').toContain('依据验证任务的完成情况与证据');
    expect(template, '复查段应含空态文案').toContain('无可复查项');
  }, 60_000);

  it('tasks instruction 要求经验验证跟踪任务，且不引入非跟踪 bullet 章节', async () => {
    const root = makeFixtureProject();
    const schemaPath = path.join(root, 'openspec', 'schemas', 'experience-loop', 'schema.yaml');
    const schema = parse(fs.readFileSync(schemaPath, 'utf-8')) as {
      artifacts: Array<SchemaArtifact & { instruction?: string }>;
    };
    const tasks = schema.artifacts.find((a) => a.id === 'tasks');
    const instruction = tasks?.instruction ?? '';

    // 跟踪任务要求（普通复选框任务，随其余任务进入 apply 待办）
    expect(instruction, '应要求为每条引用经验创建跟踪任务').toContain('为『## 经验引用』中每条经验创建一条普通跟踪任务');
    expect(instruction, '应给出 [经验 <id>] 前缀格式').toContain('[经验 <id>]');
    expect(instruction, '任务应随其余任务进入 apply 待办').toContain('apply 待办');

    // 零冲突：与 fork 自 spec-driven 的"非跟踪 bullet 仅限文末 Workflow follow-up"约束不打架
    expect(instruction, '不得新增非跟踪 bullet 章节').not.toContain('## 经验验证点');

    // 模板含编写指引
    const tasksTpl = fs.readFileSync(
      path.join(root, 'openspec', 'schemas', 'experience-loop', 'templates', 'tasks.md'),
      'utf-8'
    );
    expect(tasksTpl, 'tasks.md 模板应含经验验证任务指引').toContain('[经验 <id>]');

    // retro 复查段已对齐判定行格式与证据措辞
    const retroTpl = fs.readFileSync(
      path.join(root, 'openspec', 'schemas', 'experience-loop', 'templates', 'retro.md'),
      'utf-8'
    );
    expect(retroTpl).toContain('判定: 生效|不生效|不适用');
    expect(retroTpl).toContain('依据验证任务的完成情况与证据');

    // schema validate 仍通过
    const result = await runCLI(['schema', 'validate', 'experience-loop', '--json'], { cwd: root });
    expect(result.exitCode, `${result.stdout}\n${result.stderr}`).toBe(0);
  }, 60_000);
});
