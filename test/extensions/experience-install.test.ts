import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runCLI } from '../helpers/run-cli.js';

const repoRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
const installScript = path.join(repoRoot, 'extensions', 'experience-loop', 'scripts', 'install.mjs');

function runInstall(root: string, args: string[] = []) {
  const r = spawnSync(process.execPath, [installScript, '--project', root, ...args], { encoding: 'utf-8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

function makeProject(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'openspec-exp-install-'));
  fs.mkdirSync(path.join(root, 'openspec'), { recursive: true });
  return root;
}

describe('experience-loop install.mjs', () => {
  it('安装后 schema 可校验、lint 脚本落位可执行、guidance 片段输出', async () => {
    const root = makeProject();
    const r = runInstall(root);
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);

    const v = await runCLI(['schema', 'validate', 'experience-loop', '--json'], { cwd: root });
    expect(v.exitCode, `${v.stdout}\n${v.stderr}`).toBe(0);

    const lint = path.join(root, 'openspec', 'experience', 'experience-lint.mjs');
    expect(fs.existsSync(lint), 'lint 脚本应落位到运行时唯一路径').toBe(true);
    const check = spawnSync(process.execPath, [lint, '--project', root], { encoding: 'utf-8' });
    expect(check.status, `空校验应 exit 0\n${check.stdout}${check.stderr}`).toBe(0);

    expect(r.stdout, 'guidance 片段应含运行时路径').toContain('openspec/experience/experience-lint.mjs');
    expect(r.stdout, 'guidance 片段应含停止归档文案').toContain('非零退出则停止归档');
  }, 60_000);

  it('重复安装：不覆盖 schema、刷新 lint 脚本、不报错；--force 覆盖 schema', () => {
    const root = makeProject();
    expect(runInstall(root).status).toBe(0);

    const schemaFile = path.join(root, 'openspec', 'schemas', 'experience-loop', 'schema.yaml');
    fs.appendFileSync(schemaFile, '\n# user-marker\n');
    const lint = path.join(root, 'openspec', 'experience', 'experience-lint.mjs');
    fs.appendFileSync(lint, '\n// user-marker\n');

    const again = runInstall(root);
    expect(again.status, '重复安装不报错').toBe(0);
    expect(fs.readFileSync(schemaFile, 'utf-8'), '不覆盖用户修改过的 schema').toContain('user-marker');
    expect(fs.readFileSync(lint, 'utf-8'), 'lint 脚本覆盖式刷新').not.toContain('user-marker');

    const forced = runInstall(root, ['--force']);
    expect(forced.status).toBe(0);
    expect(fs.readFileSync(schemaFile, 'utf-8'), '--force 覆盖 schema').not.toContain('user-marker');
  }, 60_000);

  it('经验库文件已存在则跳过', () => {
    const root = makeProject();
    expect(runInstall(root).status).toBe(0);
    const idx = path.join(root, 'openspec', 'experience', 'INDEX.md');
    fs.writeFileSync(idx, '# custom index\n');
    expect(runInstall(root).status).toBe(0);
    expect(fs.readFileSync(idx, 'utf-8'), '已存在的经验库文件不应被覆盖').toContain('custom index');
  });
});
