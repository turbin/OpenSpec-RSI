import { describe, expect, it } from 'vitest';
import { STATUSES, nextStatus, parseRecheck, resolveDisposition } from '../extensions/experience-loop/scripts/recheck.mjs';

describe('nextStatus 状态迁移表', () => {
  it('active + 合格负判定 → ineffective', () => {
    expect(nextStatus('active', { kind: 'negative' })).toBe('ineffective');
  });
  it('ineffective + 合格负判定 → 幂等自环 ineffective', () => {
    expect(nextStatus('ineffective', { kind: 'negative' })).toBe('ineffective');
  });
  it('active/ineffective + 取代 → superseded', () => {
    expect(nextStatus('active', { kind: 'supersede' })).toBe('superseded');
    expect(nextStatus('ineffective', { kind: 'supersede' })).toBe('superseded');
  });
  it('superseded/expired + 负判定 → 终态优先不变', () => {
    expect(nextStatus('superseded', { kind: 'negative' })).toBe('superseded');
    expect(nextStatus('expired', { kind: 'negative' })).toBe('expired');
  });
  it('expired + 取代 → superseded（允许的人工处置）', () => {
    expect(nextStatus('expired', { kind: 'supersede' })).toBe('superseded');
  });
  it('任意 + 生效/不适用/未合格负判定 → null（不自动写）', () => {
    expect(nextStatus('active', { kind: 'effective' })).toBeNull();
    expect(nextStatus('active', { kind: 'na' })).toBeNull();
    expect(nextStatus('active', { kind: 'negative-unqualified' })).toBeNull();
  });
  it('STATUSES 含四态且含 ineffective', () => {
    expect([...STATUSES].sort()).toEqual(['active', 'expired', 'ineffective', 'superseded']);
  });
});

describe('parseRecheck 三段解析', () => {
  it('引用/警示/判定规范行解析，警示替代 ID 不入 refs', () => {
    const md = `## 经验引用\n- [经验 exp-20261120-a] 采用\n## 经验警示\n- [警示 exp-20261120-b] 已过时，直接替代 exp-20261120-c\n## 上次经验复查\n- [经验 exp-20261120-a] 判定: 不生效 — 依据 x`;
    const r = parseRecheck(md);
    expect(r.refs.map(x => x.id)).toEqual(['exp-20261120-a']);
    expect(r.warnings[0]).toEqual({ id: 'exp-20261120-b', replaces: 'exp-20261120-c' });
    expect(r.judgments).toEqual([{ id: 'exp-20261120-a', verdict: '不生效' }]);
  });
  it('形似规范行但格式错（ID 非法）→ 抛错', () => {
    expect(() => parseRecheck('## 经验引用\n- [经验 exp-001] 采用')).toThrow();
  });
  it('注释/围栏内不计入', () => {
    const r = parseRecheck('## 经验引用\n```\n- [经验 exp-20261120-a] 采用\n```\n- [经验 exp-20261120-b] 采用');
    expect(r.refs.map(x => x.id)).toEqual(['exp-20261120-b']);
  });
  it('缺右括号的规范行 → 抛错（不静默变空集）', () => {
    expect(() => parseRecheck('## 经验引用\n- [经验 exp-20261120-a')).toThrow();
  });
  it('判定尾随字（不生效了）→ 抛错（不当成不生效）', () => {
    expect(() => parseRecheck('## 上次经验复查\n- [经验 exp-20261120-a] 判定: 不生效了')).toThrow();
  });
  it('重复目标段 → 抛错', () => {
    expect(() => parseRecheck('## 经验引用\n- [经验 exp-20261120-a] 采用\n## 经验引用\n- [经验 exp-20261120-b] 采用')).toThrow();
  });
  it('HTML 注释内的判定不计入', () => {
    const r = parseRecheck('## 上次经验复查\n<!--\n- [经验 exp-20261120-a] 判定: 不生效\n-->\n- [经验 exp-20261120-b] 判定: 不生效');
    expect(r.judgments.map(x => x.id)).toEqual(['exp-20261120-b']);
  });
  it('围栏内的标题不改变当前段落', () => {
    const r = parseRecheck('## 经验警示\n```\n## 经验引用\n```\n- [警示 exp-20261120-b] 已过时，直接替代 exp-20261120-c');
    expect(r.refs).toHaveLength(0);
    expect(r.warnings).toHaveLength(1);
  });
});

describe('resolveDisposition 处置决议', () => {
  it('本地 + 目标 active + 合格负判定 → 已应用', () => {
    expect(resolveDisposition({ verdict: '不生效', targetState: 'active', isLocal: true })).toBe('已应用');
  });
  it('共享库/未授权根 → 仅记录（不改状态）', () => {
    expect(resolveDisposition({ verdict: '不生效', targetState: 'active', isLocal: false })).toBe('仅记录');
  });
  it('迟到判定、目标已 superseded/expired → 终态无需改', () => {
    expect(resolveDisposition({ verdict: '不生效', targetState: 'superseded', isLocal: true })).toBe('终态无需改');
    expect(resolveDisposition({ verdict: '不生效', targetState: 'expired', isLocal: true })).toBe('终态无需改');
  });
  it('已撤销 → 已撤销', () => {
    expect(resolveDisposition({ verdict: '不生效', targetState: 'ineffective', isLocal: true, revoked: true })).toBe('已撤销');
  });
});
