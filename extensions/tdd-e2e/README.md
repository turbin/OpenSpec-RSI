# tdd-e2e — TDD e2e 门禁扩展包

把 `tdd-driven` schema（proposal → specs → **tests** → design → tasks → **evidence**）与
e2e 发布门禁接到 OpenSpec change 上：测试台账先于实现、evidence 由真实运行生成、
发布资格由 CI 内独立重跑判定。纯扩展包：**不改核心 CLI、不改生成的技能模板**。

```
node scripts/install.mjs --project <root>
node openspec/tdd-e2e/e2e-gate.mjs --change <name> --finalize        # E1 本地收尾
node openspec/tdd-e2e/e2e-lint.mjs --gate                            # E4 CI 判定（唯一入口）
node openspec/tdd-e2e/e2e-lint.mjs --archive-gate --change <name> --execute   # E2 受管归档
```

## 1. 安装

```console
$ node extensions/tdd-e2e/scripts/install.mjs --project .
schema: 已安装到 openspec/schemas/tdd-driven/
scripts: 已安装到 openspec/tdd-e2e/（e2e-gate.mjs、e2e-lint.mjs、lib/，覆盖式更新）

建议粘贴进 openspec/config.yaml（人工策展，install 不自动改 config）：

operations:
  apply:
    guidance:
      - （仅 tdd-driven change 适用）任务全勾后运行 node openspec/tdd-e2e/e2e-gate.mjs --finalize --change <name>，红灯不得宣告完成
  archive:
    guidance:
      - （仅 tdd-driven change 适用）归档走受管入口 node openspec/tdd-e2e/e2e-lint.mjs --archive-gate --change <name> --execute，未过判定不得归档
```

- **落位**：`schema/` → `openspec/schemas/tdd-driven/`；`scripts/{e2e-gate.mjs,e2e-lint.mjs,lib/}` →
  `openspec/tdd-e2e/`（覆盖式更新；`install.mjs` 自身不落位——它是分发面，不是运行时脚本）。
- **不自动改 config**：config.yaml 是人工策展区（同 experience-loop 先例）。片段的 guidance
  文本以"（仅 tdd-driven change 适用）"开头，因为 config 注入不按 schema 过滤，会进入所有
  change 的 apply/archive 流程；主承载在 tdd-driven schema instruction。
- **幂等**：二次运行 exit 0；schema 内容一致则跳过，不同则刷新（静态面漂移即过期）。
- **源缺失 fail-closed**：`schema/` 或任一运行时脚本缺席 → 报错点名缺失项、exit 1、不写任何文件。
- **schema 选择**：按 change 声明（`.openspec.yaml` 的 `schema: tdd-driven`）或
  `openspec new change --schema tdd-driven`；项目默认手改 `openspec/config.yaml` 顶层 `schema:`。

## 2. 命令发现与信任模型

e2e 命令来源是一个**信任决策**。发现链三级，只有前两级是受信源：

| 级 | 源 | 权威执行（lint 重跑） | 本地提示（gate） |
|---|---|---|---|
| 1 | `tdd-e2e.config.json` 的 `command` | ✅ 认 | ✅ 认 |
| 2 | `package.json` 的 `scripts["test:e2e"]` | ✅ 认 | ✅ 认 |
| 3 | change 级 `.openspec.yaml` 的 `x-tdd-e2e.command` | ❌ **不执行**（`--gate` 判 FAIL `no-trusted-command`） | ✅ 只作本地提示 |

- **change 级键仅本地提示**：本地 `e2e-gate.mjs` 会执行它拿到早反馈，但 CI 的权威重跑
  永不接受 change 级命令（防止候选侧自带"绿"命令）。staging 记录的 `commandSource` 仅信息性。
- **受信源概念**：权威判定读取的是命令定义本身（config / package.json）。最终信任边界是
  code review + 受保护策略源：PR 把 `command` 改成 `true` 技术上无解（与改 package.json
  scripts 同级），已知并明示。
- 全空且无豁免 → fail-closed（gate `no-command` / lint `no-command`）。
- 近似键（`x-tdd-e2e_skip`、裸 `skip_reason`）由 lint 报 typo 诊断（`--json` 输出顶层
  `warnings` 数组，`metadata-typo:` 前缀；warning 不拦截判定，但值得修——真正的键不会生效）。
- **唯一 YAML 样例**（change 级豁免字段全形）：

```yaml
schema: tdd-driven
x-tdd-e2e.skip: true
x-tdd-e2e.skip_reason: upstream flake，追踪于 ISSUE-123
```

### 配置发现与 `tdd-e2e.config.json` 字段

配置放项目根 `tdd-e2e.config.json`（JSON；缺失 = 全缺省；坏 JSON / 类型不符 = fail-closed）：

| 字段 | 类型 | 作用 |
|---|---|---|
| `command` | string | 一级受信 e2e 命令（整条 shell 命令串） |
| `enforce` | `"tdd-driven-only" \| "all-changes"` | 执法范围：只管有效 schema 为 tdd-driven 的 change / 全员收测试门禁（但不强求无 tests 工件的 schema 补台账） |
| `allowlist` | string[] | EXEMPT 受信授权记录（每条是 JSON 对象字符串，四要素见 §4） |
| `include` | string[] | 输入指纹显式 include 的未跟踪路径（未跟踪输入须显式声明，否则不受测并告警） |
| `collect` | string[] | 绿灯后收集制品的 glob（生成 `deliverables/` 制品清单：文件名 + sha256 + 大小） |
| `produces` | string[] | 发布契约：必须存在的产出文件（glob 或路径；缺失 = FAIL `missing-produces`） |

另有 `skipApproved: true`（布尔）：gate 本地提示层放行全空命令链（仍须 change 级或 config 级
豁免语义配套）。**它不产生 EXEMPT**——权威豁免只走 lint 的受信授权记录（见 §4）。

## 3. 判定表与生命周期

### 判定表（真值表五情形）

三态输出分离：`--gate --json` 给 `{aggregate, projectRun, changes:[{name,status,reason}]}`；
退出码 0 ∈ {PASS, EXEMPT, NOT_APPLICABLE}，1 = FAIL，2 = 用法错误。**"未执行"永不记 PASS**；
聚合取最差项（required check 只发布聚合）。

| 情形 | 项目级 e2e | 逐 change 对账 | 聚合结论 |
|---|---|---|---|
| docs-only（diff ⊂ 文档路径） | 免重跑（记 SKIP-EXEC，**非 PASS**） | 免 | 无在范围 change → NOT_APPLICABLE |
| code-only（无 change 目录变动） | **必须重跑**（inputs 覆盖全仓） | 空集合 → 无对账项 | 重跑绿才 PASS |
| 涉 change（新增/迁移/删除/触碰） | 必须重跑 | 按身份决策表逐 change | 聚合取最差项 |
| EXEMPT（有效授权） | 免重跑（凭授权记录） | 可继续（归档记录标豁免） | EXEMPT（独立结果） |
| merge queue | 同涉 change | 合成结果 vs 目标分支基线 | 同上 |

**docs-only 定义**（fail-closed，宁可多跑不可漏跑）：diff 里每一个路径（除 change 内生成记录
`evidence/`、`deliverables/`、`.staging/`、`evidence.md` 投影）都满足——

- 仅**第一路径段**为 `docs/` 或 `docs-lab/`（深层 `src/docs/` 永不算）；**根级文件（含 .md）不算**，
  触碰即强制重跑；
- 扩展名 ∈ 白名单：`.md .mdx .markdown .txt .rst .adoc .png .jpg .jpeg .gif .svg .webp .ico .pdf`；
- `openspec/` 下的规划面不算文档（触碰 change 必须收门禁）。

混合 PR（docs + 代码）必须全跑。逐 change 身份决策：新增（按新身份）、迁移（按迁移后身份）、
删除（须确认清理完整，残留生成记录 = FAIL `incomplete-deletion`）、空集合记 NOT_APPLICABLE。

### 生命周期四事件

```
E1 本地收尾 ── e2e-gate --finalize（幂等）：绿 → 落地 run bundle（worktree，未提交）
E2 受管移动 ── e2e-lint --archive-gate --change <name> --execute（已同步后移动，无半态）
E3 最终候选提交 ── 开发者显式提交（最终归档路径 + 完整 bundle）【合并资格只绑定此提交】
E4 CI 判定 ── e2e-lint --gate 对该最终候选重跑 → required check + CI artifact（不创建提交）
```

- **E1 `--finalize`**：运行协议（发现命令 → 前指纹 → 执行 → 后指纹，不一致 = `stale-inputs`
  作废）→ staging → 原子发布 `evidence/runs/<runId>/`（e2e-result.json + 人读报告）→ 顶层
  `evidence.md` 人读投影（非权威）。幂等：同组合键（内容 hash ⊕ 规划面 ⊕ 策略版本）＋完整＋
  成功＋清单校验通过 → 直接复用不重跑。两态标识：`local-finalized`（未提交）/
  `committed-pending-ci`（E3 之后）。
- **E3 合并资格绑定最终候选提交**：已有绿检查后移动/修改任一 bundle 文件 = 新候选，旧检查
  **不放行**。允许早提交 bundle，但它只是中间提交，不继承最终放行。
- **E2 受管归档**：①完整判定（含重跑）→ ②快照复验（防判定后编辑）→ ③sync 完整性校验
  （delta 已合入主 spec 或显式 `skip_specs`）→ ④无半态移动（no-clobber、日期前缀
  `YYYY-MM-DD-<name>`、失败回退）。归档记录 `evidence/archive-record.json` 随行可审计。
- 原生 `openspec archive`、archive skill 直接 mv、手工移动**不在本地强制范围**；受保护分支
  required check 验收归档提交兜底（边界见 §7）。

## 4. EXEMPT（豁免授权）与 skip（本地提示）——两层分开

**gate 的 skip 是本地提示层，豁免授权（EXEMPT）由 lint 判定**：

- `e2e-gate.mjs` 看到 change 级 `x-tdd-e2e.skip: true` + `skip_reason`（或 config
  `skipApproved`）→ 本地记 `status: skipped`、exit 0。这只是"本地没跑"的诚实记录，
  **不产生任何放行凭证**。
- `e2e-lint.mjs --gate` 看到 skip 声明 → **必须**命中受信授权记录才判 EXEMPT，否则 FAIL
  （`unauthorized-skip`；快照失配 = `authorization-stale`）。

**受信授权记录四要素**（缺一不可；glob 只筛候选，不作授权）：

```json
{
  "allowlist": [
    "{\"change\":\"c1\",\"snapshot\":\"<change 规划面 sha256>\",\"scope\":[\"src/**\"],\"approver\":\"alice\"}"
  ]
}
```

| 要素 | 含义 |
|---|---|
| `change` | change 稳定身份 |
| `snapshot` | **受审快照 hash**（change 规划面 specs/tests/.openspec.yaml 的内容 hash）——改豁免原因、改 delta、改元数据 → 键变 → 授权失效，须新授权 |
| `scope` | 范围 glob 数组：该 change 的触碰路径须全部落在 scope 内 |
| `approver` | 批准人 |

- CI strict（默认）下无授权的 skip = FAIL。
- EXEMPT 归档可继续，但 `archive-record.json` 必带豁免标记与授权引用（可审计）。
- 修改既有 change 的 schema / 豁免字段 = 须授权记录，未授权 = FAIL
  （`unauthorized-metadata-edit`，防脱管）。

## 5. CI / pre-commit 接线（单入口）

**CI 唯一入口是 `e2e-lint --gate`**。`e2e-gate --rerun` 直跑 CI 属接线外旁路——它不带判定
（快照绑定、台账对账、发布契约），不构成发布资格。归档走 `--archive-gate --execute`。

CI 样例（单入口；扩展包不附带 CI 配置，各项目自行接线）：

```yaml
- name: Install tdd-e2e
  run: node extensions/tdd-e2e/scripts/install.mjs --project .
- name: e2e gate（唯一判定入口）
  run: node openspec/tdd-e2e/e2e-lint.mjs --gate --json
```

- gate 结果接入 PR 与 merge queue 的 **required checks** 聚合：缺失、被取消、配置不可读
  一律**不等于通过**。
- 权威重跑只接受受信源命令（config → package.json）；发现链只落到 change-metadata →
  FAIL `no-trusted-command`。
- docs-only 过滤**只影响重跑层**（`--gate` 内部 SKIP-EXEC），不做 CI job 级 paths-filter
  跳过判定层——免重跑不免判定。
- `--base <ref>` 显式传目标分支/合成结果（缺省回退 merge-base）。
- **pre-commit**（本地早反馈，仅退出状态，不发布检查、不产生凭证）——入口同 CI（`--gate`，
  换掉的只是运行时机）：

```yaml
- id: tdd-e2e-local
  name: tdd-e2e local gate
  entry: node openspec/tdd-e2e/e2e-lint.mjs --gate
  language: unsupported        # pre-commit ≥ 4.4（旧版用 system）；不装环境，直接跑系统命令
  pass_filenames: false        # 必须：默认会追加暂存文件名 → lint 用法错误 exit 2
```

pre-commit 里 lint 会按 diff 基线自选受检集合；要只看单个 change 加 `--change <name>`
（与 CI 同参）。`pass_filenames: false` 不可省——`--gate` 不接文件名参数，pre-commit
默认追加会把暂存文件名当未知参数传进去（exit 2）。

## 6. skill 桥接（superpowers，可选加速器）

tdd-driven 的 tests 工件可与 superpowers 测试驱动技能组合：**按 id 引用、双写形态**
（`superpowers:` 前缀或裸名），不复制内容、不 vendor、不锁版本。**技能存在与否不影响
正确性**——规范锚是 schema instruction 的内联协议；技能可加严/补充、不可放松，冲突以内联为准。

- `superpowers:test-driven-development`（双写：裸名 `test-driven-development`）：红-绿-重构三步微协议加速器；
- `superpowers:verification-before-completion`：收尾取证；
- `superpowers:finishing-a-development-branch`：分支收尾（可选）。

**skill id 验证方法**（如何确认技能可用）：让 agent 列出已装技能并按两种形态各查一次——

- 前缀形态：问 agent "你有哪些 `superpowers:` 前缀的技能"（或列技能目录，如
  `~/.agents/skills/`、`.agents/skills/` 下找 `superpowers` 命名空间）；
- 裸名形态：问 "是否有名为 `test-driven-development` 的技能可用"。

任一形态命中即可用；两个都没有 → 技能缺席，协议仍以内联为准（见 §7-L3/R6）。

## 7. 已知边界（L1-L3 与残余风险）

| # | 边界 | 说明 |
|---|---|---|
| L1 | **规划级追溯上限** | v1 追溯是规划级逐场景 + 执行级总量（exit code），**不验证"每个具名测试真被执行"**：台账行指向的测试路径不在 lint 校验范围内（校验的是场景映射完整性，非测试文件存在/执行）。红→绿历史顺序也不可证（开发协议，CI 不证明历史）。 |
| L2 | **store 模式** | change 住 store（planningHome.root ≠ 项目根）时 gate 跨双根取证受限；"CI 权威"无落点（change 在 store、代码在项目根，runner 跑在哪仓 CI？）。**硬门禁需双仓接线，否则降级本地 advisory**（沿 experience-loop 边界 #5）。 |
| L3 | **skill 触点是 prompt 级** | 触点 1/2（任务边界测试先写、收尾取证）是 prompt 级契约，与 OpenSpec 全产品执法模型一致；触点 3（runner 真执行）兜底。 |
| — | 原生归档绕过 | 本地强保证只覆盖 `--archive-gate` 受管入口；受保护分支 required check 验收归档提交兜底；全不可绕过需核心钩子 = Phase 2。 |
| — | 陈旧 `.run-lock` 恢复 | 硬崩溃后残留的 `evidence/.run-lock` 恒报 `run-locked`（无 PID 检测）。**恢复方式：人工确认无并发运行后删除锁文件** `<changeDir>/evidence/.run-lock`，再重跑 `--finalize`。 |
| — | 命令配置即信任边界 | PR 把 `command` 改成 `true` 技术上无解，接受并明示：信任边界是 code review + 受保护策略源。 |
| — | 台账同名场景 | 同一 capability+requirement 下重名场景 = FAIL（v1 不引入稳定 ID，fail-closed 拒绝并给诊断）。 |
| — | schema 静态 fork 漂移 | 核心指令修复不自动传播进 tdd-driven fork（parity 靠校验，重新 fork 需人工移植）。 |

## 8. 术语表（与 OpenSpec 既有词汇的区分）

| 术语 | 本扩展含义 | 与 OpenSpec 既有词的区分 |
|---|---|---|
| **evidence（测试证据）** | change 目录内 `evidence/`（`runs/<runId>/` 权威 run bundle + `.staging/` + `.run-lock`）与顶层 `evidence.md` 人读投影：由真实运行生成的判定输入。`evidence.md` 是投影**非权威**——放行以判定进程链内独立重跑为准 | ≠ OpenSpec **artifact**（规划文档：proposal/spec/design/tasks）。evidence 是运行产物，不是规划面 |
| **deliverables（交付制品）** | change 目录内 `deliverables/`：绿灯后按 `collect` glob 生成的制品**清单**（文件名 + sha256 + 大小）；实体复制 opt-in，建议 .gitignore 防仓库膨胀 | ≠ OpenSpec **artifact**；也 ≠ evidence（deliverables 是被测系统的产出物登记，evidence 是测试运行的证据） |
| **run bundle** | `evidence/runs/<run-id>/`：单次运行的权威记录（e2e-result.json、人读报告、组合键投影） | 单一不可变发布对象；E3 提交它，E4 对它重跑判定 |
| **台账（ledger）** | change 的 `tests/` 下红绿状态表格（能力/需求/场景/用例/测试路径/状态） | 三态：计划 / 红 / 绿；无红不记绿 |
| **受信源** | 命令发现链前两级（tdd-e2e.config.json、package.json test:e2e） | change 级 x- 键**不是**受信源 |
| **组合键 v1** | sha256(内容 hash ⊕ policyVersion)，内容 hash = 输入指纹 ⊕ change 规划面 | 快照绑定的比对基准：改代码/台账/delta/元数据/策略任一 → 键变 → bundle 失配 |

## 9. 常见判定失败速查

| 错误码 | 含义 | 处置 |
|---|---|---|
| `no-command` | 命令发现链全空且无豁免 | 配 `tdd-e2e.config.json` 的 `command` 或 package.json `test:e2e` |
| `no-trusted-command` | 只有 change 级命令，CI 不执行 | 把命令提到受信源（config/package.json） |
| `stale-inputs` | 运行期间输入指纹变了，或 bundle 与最终候选键不匹配 | 修复后重跑 `--finalize` 重建 bundle |
| `run-locked` | `.run-lock` 被持有（或硬崩溃残留） | 确认无并发后人工删锁文件（§7） |
| `unauthorized-skip` | skip 声明无受信授权 | 走 §4 授权流程或撤回 skip |
| `missing-produces` | 发布契约产出缺失 | 补齐产出或修正 `produces` |
| `sync-incomplete` | 归档时 delta 未完全合入主 spec | 先 sync（或显式 `skip_specs`）再归档 |
