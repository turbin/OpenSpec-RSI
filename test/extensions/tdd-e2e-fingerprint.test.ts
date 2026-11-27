// test/extensions/tdd-e2e-fingerprint.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { computeInputKeyV1 } from '../../extensions/tdd-e2e/scripts/lib/fingerprint.mjs';

let root: string;
function git(args: string) { execSync(`git ${args}`, { cwd: root }); }

beforeAll(() => {
  root = path.join('/tmp', `fp-test-${Date.now()}`);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, 'openspec/changes/c1/evidence'), { recursive: true });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\n');
  writeFileSync(path.join(root, 'openspec/changes/c1/tasks.md'), '- [x] 1.1\n');
  writeFileSync(path.join(root, 'openspec/changes/c1/evidence/old.json'), '{"stale":true}');
  git('init -q'); git('add -A'); git('-c user.email=t@t -c user.name=t commit -qm init');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

it('stable across CRLF rewrite of tracked text file (EOL 归一化)', async () => {
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 1;\r\n');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).toBe(before.hash);
});
it('excludes generated evidence/ and planning dirs (写证据不弄脏指纹)', async () => {
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'openspec/changes/c1/evidence/new.json'), 'x');
  writeFileSync(path.join(root, 'openspec/changes/c1/tasks.md'), '- [x] 1.1\n- [x] 1.2\n');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).toBe(before.hash);
});
it('detects uncommitted src change (glm P0-1)', async () => {
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'src/a.ts'), 'export const a = 2;\n');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).not.toBe(before.hash);
});
it('includes openspec/tdd-e2e (runner 自身入指纹)', async () => {
  mkdirSync(path.join(root, 'openspec/tdd-e2e'), { recursive: true });
  writeFileSync(path.join(root, 'openspec/tdd-e2e/e2e-lint.mjs'), '// v1');
  git('add -A'); git('-c user.email=t@t -c user.name=t commit -qm runner'); // 先提交使其 tracked
  const before = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  writeFileSync(path.join(root, 'openspec/tdd-e2e/e2e-lint.mjs'), '// v2');
  const after = await computeInputKeyV1({ projectRoot: root, planningRoot: root });
  expect(after.hash).not.toBe(before.hash);
});
