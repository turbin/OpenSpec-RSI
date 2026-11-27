// test/extensions/tdd-e2e-schema.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { loadSchema } from '../../src/core/artifact-graph/schema';

const SCHEMA_DIR = path.resolve(__dirname, '../../extensions/tdd-e2e/schema');
const SPEC_DRIVEN = path.resolve(__dirname, '../../schemas/spec-driven');

describe('tdd-driven schema', () => {
  it('parses with exact requires edges', () => {
    const schema = loadSchema(path.join(SCHEMA_DIR, 'schema.yaml'));
    const ids = schema.artifacts.map((a) => a.id);
    expect(ids).toEqual(['proposal', 'specs', 'tests', 'design', 'tasks', 'evidence']);
    const byId = Object.fromEntries(schema.artifacts.map((a) => [a.id, a]));
    expect(byId.specs.requires).toEqual(['proposal']);
    expect(byId.tests.requires).toEqual(['specs']);
    expect(byId.design.requires).toEqual(['proposal']);
    expect(byId.tasks.requires).toEqual(['specs', 'design', 'tests']);
    expect(byId.evidence.requires).toEqual(['tasks']);
    expect(schema.apply.requires).toEqual(['tasks', 'tests']);
    expect(schema.apply.tracks).toBe('tasks.md');
  });
  it('evidence instruction carries the no-early-creation clause', () => {
    const schema = loadSchema(path.join(SCHEMA_DIR, 'schema.yaml'));
    const evidence = schema.artifacts.find((a) => a.id === 'evidence')!;
    expect(evidence.instruction).toContain('仅当实现完成后创建');
    expect(evidence.instruction).toContain('本 instruction 优先');
  });
  it('fork parity: unchanged instructions byte-identical to spec-driven', () => {
    for (const f of ['proposal.md', 'spec.md', 'design.md', 'tasks.md']) {
      const forked = readFileSync(path.join(SCHEMA_DIR, 'templates', f), 'utf8');
      const base = readFileSync(path.join(SPEC_DRIVEN, 'templates', f), 'utf8');
      expect(forked).toBe(base);
    }
  });
});
