# 负面经验回灌（轻量版）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现并用测试验证负面经验回灌的**实现机制**——状态四态迁移、解析资格、处置验收、lint 集成，含 3 项 P1 必验（写入到文件级 / 半批恢复 / 纠错扫描）。

**Architecture:** 把机制逻辑抽成纯函数模块 `recheck.mjs`（状态迁移表、三段解析、处置决议），`experience-lint.mjs` 复用它做验收；写入仍由 retro（代理+人审）按 schema 指令完成，lint 只读验收（漏写即 fail）。全部轻量（无新写入命令/授权框架/分布式锁）。

**Tech Stack:** Node.js ≥22（ESM `.mjs`）、vitest、`node:fs`/`node:path`、`node:child_process`（集成测试跑 lint CLI）。

**Spec:** `docs/superpowers/specs/2026-11-20-negative-experience-reinjection-design.md`

## Global Constraints
- 状态四态：`active`/`ineffective`/`superseded`/`expired`；`ineffective` 为新增，`expired` 保留。
- ID 合约：`exp-YYYYMMDD-<slug>`（`LESSON_NAME_RE`）。
- 处置四义：`已应用`/`终态无需改`/`仅记录`/`已撤销`；`已撤销` 追加列撤销键、不替换。
- 纠错一致：只要还有未撤销、要求回灌的负判定，不得恢复 `active`。
- 资格：仅当实际经验目录在已确认本地根内且库非注册 store 才 `已应用`；否则 `仅记录`。
- 不做：新写入命令、owner 授权框架、分布式锁、独立账本。

## Review Focus（spec 隐含、易踩，各配测试钉到对应任务）
1. **形似规范行但格式错被静默跳过** → 空集通过。期望：报错。→ Task 2。
2. **共享根误判为本地** → 误写。期望：`仅记录`、不改状态、lint 不误报。→ Task 3/5。
3. **半批落盘被当成功归档**。期望：归档前拒"有计划未结案"。→ Task 5。
4. **纠错漏扫已结案未归档的负判定** → 错误恢复 active。期望：含入、阻恢复。→ Task 5。
5. **旧 lint 退 0 被当支持 v1** → 误启用。期望：能力检查拒绝。→ Task 4。

---

## File Structure
- Create: `extensions/experience-loop/scripts/recheck.mjs` — 纯机制逻辑（`STATUSES`、`nextStatus`、`parseRecheck`、`resolveDisposition`）。
- Modify: `extensions/experience-loop/scripts/experience-lint.mjs` — STATUSES 加 `ineffective`；复用 recheck 做终态+处置验收、能力检查、替代者反向映射。
- Test: `test/experience-recheck.test.ts` — 纯函数单测（Task 1–3）。
- Test: `test/experience-lint-recheck.test.ts` — lint 集成 + 3 项 P1 必验（Task 4–5）。

---

### Task 1: 状态迁移表 `nextStatus`

**Files:**
- Create: `extensions/experience-loop/scripts/recheck.mjs`
- Test: `test/experience-recheck.test.ts`

**Interfaces:**
- Produces: `export const STATUSES: Set<string>`（`active/ineffective/superseded/expired`）；`export function nextStatus(current: string, ev: {kind: 'negative'|'negative-unqualified'|'supersede'|'retire'|'effective'|'na'}): string | null`（返回新状态，`null`=本功能不自动写）。

- [ ] **Step 1: 写失败测试（迁移表逐格 + 幂等 + 未列不写）**

```ts
import { describe, expect, it } from 'vitest';
import { STATUSES, nextStatus } from '../extensions/experience-loop/scripts/recheck.mjs';

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
  expect([...STATUSES].sort()).toEqual(['active','expired','ineffective','superseded']);
});
```

- [ ] **Step 2: 跑测试确认失败** Run: `pnpm vitest run test/experience-recheck.test.ts` Expected: FAIL（recheck.mjs 未定义）。
- [ ] **Step 3: 实现 `nextStatus` 与 `STATUSES`**（迁移表逐格 + 未列返回 null；`retire`：`active→expired`、其余不变；`supersede`：`active/ineffective/expired→superseded`）。
- [ ] **Step 4: 跑测试确认通过** Run: `pnpm vitest run test/experience-recheck.test.ts` Expected: PASS。
- [ ] **Step 5: Commit** `git add extensions/experience-loop/scripts/recheck.mjs test/experience-recheck.test.ts && git commit -m "feat(ext): recheck 状态迁移表"`

---

### Task 2: 三段解析 `parseRecheck`

**Files:**
- Modify: `extensions/experience-loop/scripts/recheck.mjs`
- Test: `test/experience-recheck.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `recheck.mjs`。
- Produces: `export interface RefLine { id: string }`; `export interface WarningLine { id: string; replaces?: string }`; `export interface JudgmentLine { id: string; verdict: '生效'|'不生效'|'不适用' }`; `export function parseRecheck(md: string): { refs: RefLine[]; warnings: WarningLine[]; judgments: JudgmentLine[] }`（形似规范行但格式错 → 抛错，不静默跳过）。

- [ ] **Step 1: 写失败测试（D1 反例 + ID 合约）**

```ts
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
```

- [ ] **Step 2: 跑测试确认失败** Run: `pnpm vitest run test/experience-recheck.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现 `parseRecheck`**（只读唯一顶层二级段 `## 经验引用`/`## 经验警示`/`## 上次经验复查`，跳注释/围栏；规范行按 `JUDGMENT_RE`/引用/警示格式；ID 校验 `exp-YYYYMMDD-<slug>`，非法抛错）。
- [ ] **Step 4: 跑测试确认通过** Run: `pnpm vitest run test/experience-recheck.test.ts` Expected: PASS。
- [ ] **Step 5: Commit** `git commit -m "feat(ext): recheck 三段解析与 ID 合约"`

---

### Task 3: 处置决议 `resolveDisposition`

**Files:**
- Modify: `extensions/experience-loop/scripts/recheck.mjs`
- Test: `test/experience-recheck.test.ts`

**Interfaces:**
- Consumes: Task 1/2。
- Produces: `export type Disposition = '已应用'|'终态无需改'|'仅记录'|'已撤销'`; `export function resolveDisposition(input: { verdict: '不生效'; targetState: string; isLocal: boolean; revoked?: boolean }): Disposition`（资格：`isLocal=false`→`仅记录`；目标已 `superseded/expired`→`终态无需改`；`revoked`→`已撤销`；否则 `已应用`）。

- [ ] **Step 1: 写失败测试（四义 + 资格）**

```ts
it('本地 + 目标 active + 合格负判定 → 已应用', () => {
  expect(resolveDisposition({ verdict:'不生效', targetState:'active', isLocal:true })).toBe('已应用');
});
it('共享库/未授权根 → 仅记录（不改状态）', () => {
  expect(resolveDisposition({ verdict:'不生效', targetState:'active', isLocal:false })).toBe('仅记录');
});
it('迟到判定、目标已 superseded/expired → 终态无需改', () => {
  expect(resolveDisposition({ verdict:'不生效', targetState:'superseded', isLocal:true })).toBe('终态无需改');
  expect(resolveDisposition({ verdict:'不生效', targetState:'expired', isLocal:true })).toBe('终态无需改');
});
it('已撤销 → 已撤销', () => {
  expect(resolveDisposition({ verdict:'不生效', targetState:'ineffective', isLocal:true, revoked:true })).toBe('已撤销');
});
```

- [ ] **Step 2: 跑测试确认失败** Run: `pnpm vitest run test/experience-recheck.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现 `resolveDisposition`**（按四义决议表）。
- [ ] **Step 4: 跑测试确认通过** Run: `pnpm vitest run test/experience-recheck.test.ts` Expected: PASS。
- [ ] **Step 5: Commit** `git commit -m "feat(ext): recheck 处置决议"`

---

### Task 4: lint 集成（STATUSES+ineffective / 能力检查 / 反向映射）

**Files:**
- Modify: `extensions/experience-loop/scripts/experience-lint.mjs`
- Test: `test/experience-lint-recheck.test.ts`

**Interfaces:**
- Consumes: Task 1–3 的 `recheck.mjs`。
- Produces: lint 新增校验：① `STATUSES` 含 `ineffective`（status 取值）；② 三段解析用 `parseRecheck`；③ 处置验收用 `resolveDisposition`；④ 能力检查（`--protocol-info` 探针 + schema 协议声明，缺则拒绝启用）；⑤ 替代者反向映射（链异常报"已过时，替代关系异常"不编 ID）。

- [ ] **Step 1: 写失败测试（ineffective 合法 / 旧 lint 退 0 不支持 / 链异常）**

```ts
it('status: ineffective 合法（不报"必须为 active|superseded|expired"）', () => { /* fixture 跑 lint 无该违规 */ });
it('能力检查：旧 lint 无 --protocol-info（退 2）→ 拒绝启用', () => { /* spawn lint --protocol-info，断言非支持 */ });
it('superseded 缺入边/多入边/环 → 报"已过时，替代关系异常"不编 ID', () => { /* fixture */ });
```

- [ ] **Step 2: 跑测试确认失败** Run: `pnpm vitest run test/experience-lint-recheck.test.ts` Expected: FAIL。
- [ ] **Step 3: 实现 lint 集成**（import recheck；STATUSES 加 `ineffective`；三段解析/处置验收/能力检查/反向映射；不引入第二套执法）。
- [ ] **Step 4: 跑测试确认通过** Run: `pnpm vitest run test/experience-lint-recheck.test.ts` Expected: PASS。
- [ ] **Step 5: Commit** `git commit -m "feat(ext): experience-lint 接入 recheck 验收"`

---

### Task 5: 3 项 P1 必验（文件级 / 半批 / 纠错扫描）

**Files:**
- Test: `test/experience-lint-recheck.test.ts`

**Interfaces:**
- Consumes: Task 4 的 lint。
- Produces: 三组 fixture 集成测试（断言 lint 退出码与违规文案）。

- [ ] **Step 1: 写失败测试 P1#1（写入边界到文件级）**

```ts
it('经验文件/INDEX 软链到库外 → lint 违规，且未改外部文件', () => { /* symlink fixture；断言 violation + 外部文件未变 */ });
it('普通库内文件 → 通过', () => { /* 正常 fixture */ });
```

- [ ] **Step 2: 跑测试确认失败** Run: `pnpm vitest run test/experience-lint-recheck.test.ts` Expected: FAIL（边界校验未实现）。
- [ ] **Step 3: 实现文件级边界校验**（拒链接/无法确认归属目标；lint 判据与 writer 一致）。
- [ ] **Step 4: 跑测试确认通过**。
- [ ] **Step 5: 写失败测试 P1#2（半批恢复）**

```ts
it('同批取代写一半（新条已落、旧条未置 superseded、计划未结案）→ 归档前拒', () => { /* fixture 有未结案计划 */ });
it('同 ID 同状态但取代边不同 → 保持未结案', () => { /* 计划预期取代边 vs 实际不符 */ });
it('已审计划全部达成 → 归档前通过', () => { /* 正常完成 fixture */ });
```

- [ ] **Step 6: 跑测试确认失败**。
- [ ] **Step 7: 实现半批验收**（归档前拒"有计划未结案"；核已审目标/前态匹配）。
- [ ] **Step 8: 跑测试确认通过**。
- [ ] **Step 9: 写失败测试 P1#3（纠错扫描范围）**

```ts
it('负判定已归档 + 已结案未归档各一条，只撤一条 → 两组都不得恢复 active', () => { /* 双 change fixture */ });
it('撤销后新合格负判定 → 仍须回灌（阻恢复）', () => { /* */ });
```

- [ ] **Step 10: 跑测试确认失败**。
- [ ] **Step 11: 实现纠错扫描**（同库锁下汇总已归档 + 已完成处置的开放 change；未完成计划阻断同 ID 恢复；每条合格判定独立成键）。
- [ ] **Step 12: 跑测试确认通过**。
- [ ] **Step 13: 跑全量套件确认无回归** Run: `pnpm test` Expected: 全绿。
- [ ] **Step 14: Commit** `git commit -m "test(ext): 负面回灌 3 项 P1 必验"`

---

## 收尾
- 机制验证通过（Task 1–5 测试绿）后，针对**已归档数据**的讨论（存量库如何被新规则影响、升级路径）另起——不在本计划内。
