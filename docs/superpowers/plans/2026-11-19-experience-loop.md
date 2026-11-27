# Experience Loop（经验沉淀闭环脚手架）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 OpenSpec 提供一个可安装的「经验闭环」扩展包：change 收尾产出 retro 工件 → 人审后沉淀为结构化经验条目 → 下次 propose 自动检索注入，验证动作落为跟踪任务并由引用 change 自身的 retro 结案，形成可度量的项目级经验循环。

**Architecture:** 纯扩展包（自定义 schema + 经验存储规约 + 零依赖 lint 脚本），不改核心 CLI、不改生成的技能模板。钩子交付面有三个：proposal 工件 instruction（读经验，经 `openspec instructions` 注入）、`config.yaml` 的 `operations.archive.guidance`（archive 时刻的原生文本注入面，要求运行 lint）、archive 技能自带的工件完整性检查（retro 未完成时自然浮出警告）。`openspec/experience/` 为经验生效区，`config.yaml` guidance 保持人工策展区；执法由 `experience-lint.mjs` 承担并**以 CI/pre-commit 为部署要求**（扩展包不附带 CI 配置，各项目自行接线）。**安装模型（N13）**：lint 脚本的规范源在 `extensions/experience-loop/scripts/`，`install.mjs` 将其复制进 `<root>/openspec/experience/experience-lint.mjs`——**运行时一律使用该安装路径**（guidance、instruction、CI 接线三处同此拼法），消费者无需 vendor 扩展目录。核心 validate 不检查自定义工件存在性——事实依据见 Task 4。

**Tech Stack:** OpenSpec schema YAML + Markdown 工件 + Node（零依赖 lint 脚本）+ 仓库既有 vitest（`runCLI` 夹具测试）。

**Spec:** 本文件「已定决策」节即规格来源（2026-11-19 grilling 设计树，14 项决策经用户确认；其后四轮内部对抗审查 + 一轮外部审查的修正均显式标注）。

## 已定决策（规格）

| # | 决策 |
|---|---|
| Q1 | 交付形态 = 不改核心 CLI 的可安装扩展包 |
| Q2 | 目标 = 项目级经验闭环（教训 → 下次行为），不做 agent 自动自我改写 |
| Q3 | 经验产生 = change 收尾 retro 工件，agent 起草 |
| Q4 | 写入生效区 = agent 起草 + 人确认（Don't auto-capture） |
| Q5 | 成功标准 = 可度量（verification 跟踪任务 + retro 结案 + lint `--report` 三指标，口径见 Task 4） |
| Q6 | 存储 = `openspec/experience/`，单条一文件（frontmatter 结构化）+ INDEX.md；与 config guidance 分离 |
| Q7 | 钩子 = 仅两个语义点：propose 前读、archive 前写（交付面三个，见 Architecture） |
| Q8 | retro = 自定义 schema 的正式工件（requires: tasks），`x-skip-retro: true` 显式豁免 |
| Q9 | 检索 = capability/tags 结构化过滤 + INDEX 摘要扫描，不引入向量检索 |
| Q10 | 生命周期 = status 字段（active/superseded/expired）+ 写时去重（supersede 链） |
| Q11 | retro 缺失阻塞 = 执法在扩展 lint（exit 1，部署要求 CI/pre-commit），`x-skip-retro: true` 豁免；retro 检查的范围与阶段契约见 Task 4「模式与检查集合」 |
| Q12 | 验证闭环 = 复用两钩子：propose 把 verification 落为**跟踪任务**（apply 执行），**引用 change 自身的 retro** 按判定行格式结案（口径澄清见外部审查记录） |
| Q13 | 钩子载体 = schema 工件 instruction（技能模板带指纹，`openspec update` 会重生成覆盖补丁） |
| Q14 | 载体 = 本仓库 `extensions/experience-loop/`，先用本仓库 `openspec/` dogfooding 实跑 |

**实施期事实修正（显式声明，非静默假设）：** Q8/Q11 原议"validate 检查 retro 存在、缺失则 archive 报错"。经查 `src/core/validation/validator.ts` 只校验 delta spec 语义，`apply.requires`（`src/commands/workflow/instructions.ts:560`）只挡 apply 阶段，核心对自定义工件的存在性无执法点。因此执法改由扩展 lint 承担：retro 工件仍在依赖图内（获得模板、instructions、构建序），"缺失阻塞"由 `experience-lint.mjs` 以非零退出码实现。

**第 1 轮对抗审查修正（mimo-expert R1，1 严重 5 中等 5 轻微全部采纳）：**
- **S1 时机条件化**：`continue`/`new` 增量流会在 tasks 落盘后、实现开始前把 retro 当作下一个 `ready` 工件创建（`skills/openspec-continue-change/SKILL.md:77`）。retro instruction 必须显式条件化（"仅当实现完成后创建"，即 propose 流认可的 conditional artifact 措辞），否则空壳 retro 污染经验库。
- **M2 键名**：`skip_retro` 会触发核心 unknown-key 告警（`src/utils/change-metadata.ts:41-74`，并注明 "only skip_specs exists"）。改用核心官方扩展约定 **`x-skip-retro`**（`^x-\S+$`，零告警）。"对齐 skip_specs"仅指"拒绝+显式豁免"的哲学，不指键行为。
- **M5 执行点**：lint 的真实执法点是 **CI/pre-commit**；`operations.archive.guidance` 是 archive 时刻唯一原生文本注入面，用作"运行 lint"的传送带；archive 技能的工件完整性检查（`skills/openspec-archive-change/SKILL.md:72-84`，警告+可确认）是 retro 的自然浮出点。
- **M1 度量器**：lint 加 `--report` 三指标（口径在 R2/R3/外部审查定稿，见 Task 4）。
- **M3/M4/P1-P5**：字段表上提为全局定义且 `supersedes` 方向为"新条取代旧条"；lint capability 校验仅对 active；补 e2e 注入链路测试、store 根歧义、INDEX 并发、冷验收、空态文案、日期一致性校验。

**第 2 轮对抗审查修正（mimo-expert R2，0 严重 4 中等 8 轻微全部采纳）：**
- **N1 度量口径定稿**：`--report` 分母 = 声明 `schema: experience-loop` 的 change（前扩展时代 change 天然排除）；「上次经验复查」判定行格式钉死；`--report` 只统计恒 exit 0，违规判定归默认模式。
- **N2 supersede 与查重互斥修复**：lint ⑤ 仅对双 active 条目比对，且豁免 supersedes 直接相连的配对——否则 Q10 要求的合法更新主路径会在 CI 上被打红。
- **N3 蕴含式执法**：lint ① 由"或"改"蕴含"（有豁免 ⇒ 必须有 stub），堵住"裸豁免"废掉 archive 警告浮出点的漏洞。
- **N4 INDEX 内容漂移**：lint ③ 从"行↔文件映射"升级为"五列逐列比对"，闭合 Review Focus 1 命名的失效模式。
- **N5-N12**：字段计数改为八字段；删 `schema init --default` 误导措辞；guidance 建议文案改为"非零退出则停止归档，输出展示不写入工件"；Review Focus 2 改 fail-closed 措辞；增 `_template.md` 与 lint 字段集同步测试；格式串补右括号；README 明写"不附带 CI 配置"并增 CI 红绿验收项。
- **残余风险 9 项**全部写入 README 已知边界；残余 2 的补救（"若工作流指令要求此刻创建，本 instruction 优先"）并入 Task 3 规程①。

**第 3 轮对抗审查修正（mimo-expert R3，1 中等 5 轻微全部采纳）：**
- **N13 安装模型（必修）**：`install.mjs` 把 lint 复制进 `<root>/openspec/experience/experience-lint.mjs`，运行时唯一路径，guidance/instruction/CI 三处统一，消费者零 vendor 依赖。
- **N14** stub 机器可分：stub = "恰为一行 `skipped: x-skip-retro`"；无豁免时 retro.md 为 stub 形态 → exit 1。
- **N15** supersede 豁免不放行漏改态（后由外部审查 P2-2 升级为独立 ⑥ 无前提检查）。
- **N16** lint ③ 教训首行列按 ⑤ 同款归一化口径比对；INDEX 第 5 列**逐字**取「## 教训」首行。
- **N17** `--report` 补洞：悬空引用不进分子、单列计数；`--report` 与 `--change` 同给时 report 优先生效。
- **N18** 同步测试比对集 = lint ② 认识的字段全集（八字段）。

**第 4 轮对抗审查修正（mimo-expert R4，判"通过（可冻结实施）"，3 轻微采纳）：** Task 4 Step 4 验证改用规范源路径（该时点尚未安装）；lint ① 豁免分支宽容化（stub 或真实 retro 均可，只查存在）；旧条漏改检查升级为独立 ⑥ 无前提检查。

**外部审查修正（GPT 三轮：独立质疑 → 交叉反驳 → 修正复审，2 P1 + 2 P2 + 2 建议全部采纳）：**
- **P1-1 待同步 capability**：新 capability 的经验在归档同步前写入时，lint ④ 会误拒（主 specs 尚无该目录）。定稿：`--change` 模式额外接受**该 change 自身 delta specs 声明**的 capability；默认/CI 模式不放宽（外审第 3 轮裁定），红窗以"同步规格 → 经验入库 → lint"推荐顺序收窄，入已知边界。
- **P1-2 旧 schema 误伤**：全局归档 guidance 对所有归档跑 lint，而 ① 不分 schema，存量 `spec-driven` change 会被拒——与迁移承诺冲突。定稿：① **仅对显式声明** `schema: experience-loop` 的 change 执法；显式其它 schema 或未声明 ⇒ 不查 retro；`.openspec.yaml` 损坏或 `schema` 值非法 ⇒ exit 1（fail-loud，不得当作豁免）。
- **P2-1 阶段契约**：① 原只认 `--change`，CI 默认模式漏检；枚举 active 又误伤规划期（retro 按 S1 本就不该存在）。定稿：**归档前模式 `--change`**（含归档目录解析规则）与 **CI 默认模式**（retro 检查仅覆盖 `changes/archive/` 归档集合）分离定义，验收覆盖"规划中提交绿 / 缺 retro 归档入库红 / 补齐绿"。
- **P2-2 supersede 悬空目标**：⑥ 原以"旧条存在"为前提，拼错目标 + 改写教训即可双绿。定稿：⑥ 无前提全查——目标必须存在、禁自指、查环、旧条必须 `superseded`；补错拼目标反例测试。
- **建议 1（验证动作执行者）**：验证点由非跟踪 bullet 改为**普通跟踪任务**（`- [ ] [经验 <id>] …`，进 apply 待办）；顺带消解 M3/N7 的"非跟踪 bullet 仅限 Workflow follow-up"冲突（不再需要改写该约束句）。
- **建议 2（覆盖率语义）**：复查覆盖率改按 **`(change, experience-id)` 引用对** 统计（引用十次复查一次不再显示 100%）；由此澄清 **Q12 口径：判定由引用该经验的 change 自身的 retro 作出**（验证任务在本 change 的 apply 执行、retro 结案，pair 闭环在同一 change 内完成），保留唯一 ID 覆盖为辅助数。

## Global Constraints

- 不修改 `src/`（核心 CLI）与 `skills/`（生成的技能模板，带指纹，`openspec update` 会覆盖）。部署 CI/pre-commit hook 属项目基建接线，不算改核心；扩展包不附带任何 CI 配置文件。
- 不引入新的运行时依赖；lint 脚本仅用 Node 内置模块（`fs`/`path`），frontmatter 手工解析简单标量。
- 所有 instruction 文本为行为契约风格（沿用仓库惯例：明确 MUST/不做什么，冲突须解释）。
- **经验条目文件规范（全局唯一定义，README 与 `_template.md` 是其镜像，lint 按此校验）**：`openspec/experience/exp-YYYYMMDD-<slug>.md`，frontmatter **八字段（含可选 `supersedes`）**：
  - `id`（与文件名一致）、`date`（`YYYY-MM-DD`，lint 校验与文件名内嵌日期一致）、`source_change`、`capability`（`specs/` 相对路径或 `general`）、`tags`（数组）、`status`（仅 `active | superseded | expired`）、`supersedes`（可选，**仅新条目填写**，值为被取代旧条的 id；旧条同时改 `status: superseded`——lint 执法此点，见 ⑥）、`verification`（一句话：下次如何验证生效）。
  - 正文固定两节：`## 教训`（一句话结论，**首行**为 lint ⑤ 归一化查重键，INDEX 第 5 列逐字取此行）、`## 依据`（发生了什么，引用 change 工件）。
- **经验验证任务格式（Q12 口径：判定由引用 change 自身的 retro 作出）**：propose 为每条引用的经验创建**普通跟踪任务** `- [ ] [经验 <id>] <验证动作>（判定标准：<一句话>）`（标准复选框，自动进入 apply 待办；`[经验 <id>]` 前缀供 retro 关联取证；已核实 `src/utils/task-progress.ts:56` 计数无碍）。
- **「## 上次经验复查」判定行格式（全局唯一定义，机器可解析）**：`- [经验 <id>] 判定: 生效|不生效|不适用 — <一句话依据>`（同款 `- [经验 <id>]` 前缀；依据为对应验证任务的完成情况与证据）。
- 豁免字段只认 `.openspec.yaml` 顶层 **`x-skip-retro: true`**（布尔；`x-` 前缀为核心官方扩展元数据约定 `src/utils/change-metadata.ts:22-35`，不触发 unknown-key 告警；核心不解读此键，解读方仅 lint 与 retro 规程）。有豁免时仍必须写 retro.md（规程写 stub——**恰为一行 `skipped: x-skip-retro`**；lint 只查存在，stub 或真实 retro 均接受）（核心 archive 的未完成警告不认此键；无豁免时 retro.md 为 stub 形态属违规，lint 执法）。
- INDEX 行格式固定为：`| <id> | <capability> | <tags 逗号分隔> | <status> | <一句话教训> |`（第 5 列逐字取「## 教训」首行）。
- lint 运行时唯一路径：`node openspec/experience/experience-lint.mjs --project <root> [--change <name>] [--report]`。
- 模板与规约文案使用中文；字段名、命令、路径保持英文原文。

## Review Focus

1. **INDEX 与经验文件内容漂移**（人手编辑后行与文件不一致 → 检索静默失效）→ lint ③ 五列逐列比对（id/capability/tags/status/教训首行，教训列按 ⑤ 同款归一化）+ 双向映射；测试：Task 4 Step 1（删 INDEX 行 / status 列不符各断言 exit 1）。
2. **`x-skip-retro` 误用**（拼错字段名）→ fail-closed：lint 无豁免即 exit 1；lint 报错信息须点名期望键名 `x-skip-retro`；README 说明为何用 `x-` 前缀（核心对 x- 键静默、对裸 `skip_retro` 告警"无效"）；测试：Task 4 Step 3（`x-skip-retro: yes` 断言 exit 1 且报错含键名）。
3. **重复/矛盾经验堆积** → 写时去重协议 + lint ⑤/⑥（仅双 active 比对 + supersede 直接配对豁免；⑥ 无前提检查兜住旧条漏改态）；测试：Task 4 Step 5（合法 supersede 配对 exit 0、旧条漏改 exit 1、双 active 重复 exit 1）。
4. **经验永不被检索**（capability 标错 → 检索 miss）→ lint ④ 仅对 active 校验 capability 真实存在（`--change` 模式放宽待同步 capability）；README 退役指引覆盖退役与**改名**两场景；测试：Task 4 Step 4。
5. **教训夹带密钥/个人数据**（经验进入每次 propose 上下文，泄漏面大于 feedback）→ retro instruction 脱敏守卫 + Q4 人审门；lint 不承诺扫描（已知边界，README 声明）。
6. **新 capability 的经验被误拒**（外部审查 P1-1：归档同步前主 specs 无该目录）→ `--change` 模式接受该 change delta 声明的待同步 capability，推荐"同步规格 → 经验入库"顺序；测试：Task 4 Step 1（同一材料 `--change` exit 0 / 默认 exit 1）。
7. **旧 schema change 被归档规则误伤**（外部审查 P1-2：与迁移承诺冲突）→ lint ① 仅对显式 `schema: experience-loop` 执法，元数据损坏 fail-loud；测试：Task 4 Step 1（显式 `spec-driven` 无 retro → exit 0；损坏元数据 → exit 1）。

---

## File Structure

```
extensions/experience-loop/
├── README.md                          # 安装（含安装模型声明、CI/pre-commit 部署 MUST、不附带 CI 配置声明）、使用、迁移、已知边界（残余风险 10 条）
├── schema/                            # 规范源（安装时复制到 <project>/openspec/schemas/experience-loop/）
│   ├── schema.yaml                    # spec-driven 四工件 + retro 工件；proposal/tasks/retro instruction 含钩子
│   └── templates/
│       ├── proposal.md                # spec-driven 原样 + 「## 经验引用」段位
│       ├── spec.md                    # spec-driven 原样复制
│       ├── design.md                  # spec-driven 原样复制
│       ├── tasks.md                   # spec-driven 原样 + 经验验证任务编写指引注释
│       └── retro.md                   # 新增：retro 工件模板（含「## 上次经验复查」判定行格式与空态文案）
├── experience-store/                  # 经验存储规约样例（安装时初始化进 openspec/experience/）
│   ├── README.md                      # 字段表（镜像 Global Constraints 唯一定义）、状态机、去重规则、INDEX 行格式、并发与退役/改名指引
│   ├── INDEX.md                       # 摘要索引（一行一条）
│   └── _template.md                   # 经验条目模板（与 Global Constraints 字段表逐字段一致，lint 同步测试锚点）
└── scripts/
    ├── install.mjs                    # schema/ → openspec/schemas/；experience-store/ → openspec/experience/；experience-lint.mjs → openspec/experience/（运行时唯一路径）；输出 config guidance 建议片段
    └── experience-lint.mjs            # 规范源；安装后运行路径为 openspec/experience/experience-lint.mjs
test/extensions/
├── experience-loop-schema.test.ts     # Task 1/2/3/5 结构断言 + e2e 注入链路断言（runCLI）
├── experience-lint.test.ts            # Task 4 lint 行为测试（含 _template.md 字段集同步测试）
└── experience-install.test.ts         # Task 6 安装脚本测试（含 lint 脚本安装断言）
```

**职责边界：** `schema/` 只管"工作流里说什么"（instruction 与模板）；`experience-store/` 只管"经验长什么样"（规约，Global Constraints 的镜像）；`scripts/experience-lint.mjs` 只管"规则可执行 + 最小度量"（结构校验与统计，不做语义判断）。三者互不 import，lint 只按 Global Constraints 的字段规范校验文件。

---

### Task 1: schema bundle 骨架与 retro 工件

**Files:**
- Create: `extensions/experience-loop/schema/schema.yaml`、`extensions/experience-loop/schema/templates/{proposal,spec,design,tasks,retro}.md`
- Test: `test/extensions/experience-loop-schema.test.ts`

**Interfaces:**
- Produces: schema id `experience-loop`；artifact id `retro`（`generates: retro.md`，`requires: [tasks]`）；后续任务只改本文件的 instruction 文本与模板，不改工件图。

- [ ] **Step 1: 写失败测试**（夹具：临时项目根，`openspec/schemas/experience-loop/` 复制自 `extensions/experience-loop/schema/`）

```ts
// test/extensions/experience-loop-schema.test.ts
it('experience-loop schema 通过 openspec schema validate 且含 retro 工件', async () => {
  // 在临时项目根执行 runCLI(['schema', 'validate', 'experience-loop', '--json'])
  // 断言 exit 0；读 schema.yaml（用仓库依赖 'yaml' parse）
  // 断言 artifacts 含 id 'retro'，其 requires 为 ['tasks']，generates 为 'retro.md'
});
```

- [ ] **Step 2: 运行测试确认失败** — `pnpm vitest run test/extensions/experience-loop-schema.test.ts`，预期 FAIL（schema 不存在）。
- [ ] **Step 3: 生成 schema 骨架** — 在临时项目里执行 `openspec schema fork spec-driven experience-loop`，把产物整理进 `extensions/experience-loop/schema/`（schema.yaml + 五模板），并在 `schema.yaml` 的 artifacts 末尾追加：

```yaml
  - id: retro
    generates: retro.md
    description: Change 收尾复盘：沉淀可复用经验
    template: retro.md
    requires: [tasks]
    instruction: |
      （Task 3 填写；本任务先放一句占位："仅当实现完成后创建本工件，规程见模板。"）
```

- [ ] **Step 4: 运行测试确认通过** — vitest PASS；另跑 `node bin/openspec.js schema validate experience-loop --json` 于夹具项目，exit 0。
- [ ] **Step 5: Commit** — `git add extensions/experience-loop test/extensions && git commit -m "feat(ext): experience-loop schema bundle with retro artifact"`。

---

### Task 2: proposal instruction 的「读经验」钩子

**Files:**
- Modify: `extensions/experience-loop/schema/schema.yaml`（`proposal` 工件的 `instruction` 字段）
- Modify: `extensions/experience-loop/schema/templates/proposal.md`（末尾加「## 经验引用」段）
- Test: `test/extensions/experience-loop-schema.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 1 的 schema bundle；Global Constraints 的字段规范（检索按 `capability`/`tags`/`status` 字段过滤 INDEX 行）。
- Produces: proposal instruction 中的检索协议（Task 4 的 lint 按同一字段规范校验 INDEX）。

- [ ] **Step 1: 写失败测试** — 结构断言：proposal 的 `instruction` 文本包含检索协议三要素（读 `openspec/experience/INDEX.md`、按 `capability`/`tags` 过滤、命中条目引用其 `id`）；`proposal.md` 模板含「## 经验引用」段。**e2e 断言（防同义反复）**：对含该 schema 的夹具项目执行 `runCLI(['instructions', 'proposal', '--change', '<fixture>', '--json'])`，断言输出的 `instruction` 字段中包含检索协议文案（键名 `instruction` 已对 `docs/agent-contract.md` §4.5 契约核实）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** — 在 proposal instruction 开头加入（行为契约风格）：

```text
动笔前先查经验：读 openspec/experience/INDEX.md，取 status 为 active 的行，
按本次 change 的 capability 路径与主题 tags 过滤，打开命中的经验文件全文。
相关经验必须在 proposal 的「## 经验引用」段落中按 id 引用；被本次工作推翻的
经验，在 proposal 中注明"将由 retro 复盘处置"，不要在此处修改经验文件。
openspec/experience/ 目录不存在时视为无经验，直接继续，不要创建目录。
（store 模式下以 planningHome.root 定位经验目录，见 README 已知边界。）
```

- [ ] **Step 4: 确认通过** → **Step 5: Commit** — `feat(ext): proposal instruction reads experience store`。

---

### Task 3: retro instruction 的「写经验」规程

**Files:**
- Modify: `extensions/experience-loop/schema/schema.yaml`（`retro` 工件的 `instruction` 字段）
- Modify: `extensions/experience-loop/schema/templates/retro.md`
- Test: `test/extensions/experience-loop-schema.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 2 的检索协议（写前先按同一协议查重）；Global Constraints 的经验条目字段规范（八字段 + 两节正文 + 判定行格式，含 `supersedes` 方向与 INDEX 第 5 列逐字规则）。
- Produces: retro.md 工件结构（`## 声称 vs 实际`、`## 教训`、`## 依据`、`## 经验处置`、`## 上次经验复查`）；「经验处置」列出本次新增/更新/作废的经验 id 及其 verification 文本；「上次经验复查」对本 change 引用过的每条经验按判定行格式结案（依据验证任务证据，Task 4 `--report` 消费）。

- [ ] **Step 1: 写失败测试** — 断言 retro instruction 同时含：①**条件化创建**（"仅当实现完成后创建"类措辞 + "若工作流指令要求此刻创建，本 instruction 优先"）；②写时去重（"同 capability 同教训优先 supersede 旧条，新条填 supersedes、旧条改 superseded"）；③人审协议（"列出草稿，用户确认后才写入 openspec/experience/"）；④豁免规程（"`x-skip-retro: true` 时创建一行 stub retro.md 并不创建经验"）；⑤脱敏守卫。`retro.md` 模板含上述五节（「上次经验复查」含判定行格式、"依据验证任务的完成情况与证据"措辞、空态文案："经验库为空或无相关条目时，写明'无可复查项'"）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** — instruction 规程要点（逐条 MUST/禁止）：
  1. **条件化创建（S1 + 残余 2 补救）**：本工件仅当实现完成后创建（apply 已完成、tasks 全勾）；此刻实现未完成则不要创建文件，向用户说明留到 archive 前。**若工作流指令（continue/new）要求此刻创建，本 instruction 优先**——continue 技能明文声明 instruction 为权威（`skills/openspec-continue-change/SKILL.md:124`）；向用户说明并推迟。
  2. 查重：复用检索协议找同 capability 同主题经验，重复则**起草取代**：新条填 `supersedes: <旧条 id>`，旧条改 `status: superseded`，不新增平行条目（旧条漏改会被 lint ⑥ 打回）。
  3. 起草：按 Global Constraints 字段规范写经验条目（含「## 教训」首行一句话）。
  4. **人审门（Q4）**：向用户展示草稿并等待明确确认后，才写 `openspec/experience/<id>.md` 并同步 `INDEX.md` 一行（按 id 排序插入；**第 5 列逐字取「## 教训」首行**，转述会被 lint ③ 打回）。
  5. 豁免：`.openspec.yaml` 有 `x-skip-retro: true` 时，创建 stub retro.md（**恰为一行** `skipped: x-skip-retro`）并跳过经验创建——stub 是必需品（核心 archive 的未完成警告不认此键，lint ① 按蕴含式执法）。
  6. 脱敏守卫：禁止密钥、令牌、个人信息、公司内部细节入文。
  7. 写毕运行 `node openspec/experience/experience-lint.mjs --project <root> --change <name>` 并向用户展示输出（Q11 的执行点之一；真正兜底是 CI/pre-commit）。
- [ ] **Step 4: 确认通过** → **Step 5: Commit** — `feat(ext): retro instruction with conditional creation, dedup and human-gated write-in`。

---

### Task 4: 经验存储规约 + experience-lint 执法/度量脚本

**Files:**
- Create: `extensions/experience-loop/experience-store/{README.md,_template.md,INDEX.md}`
- Create: `extensions/experience-loop/scripts/experience-lint.mjs`
- Test: `test/extensions/experience-lint.test.ts`

**Interfaces:**
- Produces: `experience-lint.mjs` CLI（规范源；安装后运行路径见 Global Constraints）——`node openspec/experience/experience-lint.mjs --project <root> [--change <name>] [--report]`。
  - **模式与检查集合（阶段契约，外部审查 P1-2/P2-1）**：
    - **归档前模式 `--change <name>`**：对指定 change 执行 ① + 全局经验库校验 ②-⑥。`<name>` 接受 active 目录名、archive 目录全名、或裸 change 名的唯一后缀匹配（归档目录带日期前缀）。
    - **默认模式（CI 兜底）**：**不**对 active change 查 retro（规划期提交天然通过，对齐 S1 条件化创建）；① 仅对 `changes/archive/` **归档集合**逐个执行（归档时刻 retro 必已存在，缺失即 CI 红）；②-⑥ 全局执行。
    - **`--report` 模式**：只统计、**恒 exit 0**、不做违规判定；与 `--change` 同给时 report 优先生效（忽略校验）。
  - **校验项**：
    ① retro 存在性（**范围限定**：仅对 `.openspec.yaml` **显式声明** `schema: experience-loop` 的 change 执法；显式其它 schema 或未声明 ⇒ 不查 retro——迁移承诺"存量 change 保持旧 schema"依赖此点；`.openspec.yaml` 损坏或 `schema` 值非法 ⇒ exit 1，**fail-loud，不得当作豁免**）。蕴含式：无豁免 ⇒ 必须有真实 retro.md（缺 → exit 1；stub 形态——恰为一行 `skipped: x-skip-retro`——也 exit 1）；有 `x-skip-retro: true` ⇒ 必须有 retro.md（缺 → exit 1；stub 或真实 retro 均可，只查存在）；豁免值非布尔 → exit 1（报错点名期望键名 `x-skip-retro`）。
    ② 每个 `exp-*.md` frontmatter 八字段齐全（`supersedes` 可选），id 与文件名一致，date 为 `YYYY-MM-DD` 且与文件名内嵌日期一致，status 在枚举内。
    ③ `INDEX.md` 与文件**逐列比对**：每行五列（id/capability/tags/status/教训首行）与文件 frontmatter 及「## 教训」首行一致（**教训列按 ⑤ 同款归一化口径**），且文件↔行双向映射完整；任一不符 → exit 1。
    ④ `capability` 为 `general` 或 `<root>/openspec/specs/` 下真实存在的路径（**仅对 `status: active` 校验**；退役/改名场景由 README 指引改标 `general` 或 `expired`）。**待同步 capability（外部审查 P1-1）**：`--change` 模式额外接受**该 change 自身 delta specs（`<change>/specs/`）声明**的 capability；默认/CI 模式不放宽（严格主 specs）。推荐顺序：含新 capability 的经验在 spec 同步后入库，或入库后立即归档收窄红窗（红窗入已知边界）。
    ⑤ 重复检测：同 `capability` 且「## 教训」首行归一化（去空白/小写）相同 → exit 1 并建议 supersede。**限定**：仅当两文件均 `status: active` 时比对；**豁免** supersedes 链上直接相连的配对（新条 `supersedes` == 旧条 `id`）→ exit 0（配对合法性由 ⑥ 保证）。
    ⑥ supersede 链完整性（**无前提检查**，与教训是否相同无关）：凡 `supersedes` 非空 ⇒ **目标 id 必须存在于库中**（拼错/悬空 → exit 1）、**禁止自指**（== 自身 id → exit 1）、**沿链不得成环**（→ exit 1）、**目标条目 `status` 必须为 `superseded`**（漏改 → exit 1，报错提示"补改旧条 status: superseded"）。
  - **`--report` 指标（口径定稿，外部审查建议 2）**：
    - 分母 = `.openspec.yaml` 声明 `schema: experience-loop` 的 change（active 与 `changes/archive/` 均计入；前扩展时代 change 天然排除）。
    - 引用率 = 分母中 proposal 含「## 经验引用」且引用 ≥1 个**库内存在**的 id 的 change 数 / 分母（无该段的 change 计为未引用；悬空引用不进分子，**单列输出"悬空引用数"**）。
    - **复查覆盖率（按引用对）** = 闭环的 `(change, experience-id)` 引用对数 / 总引用对数（该 change 自身的 retro 含该 id 的判定行即闭环；引用十次复查一次不再显示 100%）；辅助输出唯一 ID 覆盖率（被引用 id 至少判定过一次的比例）。
    - 生效率 = 判定为「生效」的判定行数 / 判定行总数（主观项，README 声明局限）。
- Consumes: Task 3 的 retro 语义（`x-skip-retro`、stub、去重/supersede 规则的可执行化）；Global Constraints 的字段与判定行规范（`_template.md` 与其逐字段一致）。

- [ ] **Step 1: 写失败测试**（每校验项一例，夹具建最小项目树）：
  - ①：缺 retro 无豁免 → exit 1；`x-skip-retro: true` + stub → exit 0；豁免但无 stub → exit 1；无豁免但 retro.md 为 stub 形态 → exit 1；有豁免 + 真实 retro.md → exit 0；`x-skip-retro: yes` → exit 1 且报错含 `x-skip-retro`。
  - ①范围（P1-2）：显式 `schema: spec-driven` 的 change 无 retro，`--change` → exit 0；未声明 schema → exit 0；`.openspec.yaml` 损坏 → exit 1。
  - 阶段契约（P2-1）：默认模式下 active change 缺 retro → exit 0（规划期通过）；`changes/archive/` 内缺 retro → exit 1；补齐后 → exit 0。
  - ②③：INDEX 删一行 → exit 1；INDEX 行 status 列与文件不符 → exit 1；frontmatter 缺 `verification` → exit 1；文件名日期与 `date` 不一致 → exit 1。
  - ④：`capability: nope`（active）→ exit 1；**同材料 `--change` 命中该 change delta 声明的待同步 capability → exit 0、默认模式 → exit 1（P1-1）**；退役条目（expired，capability 已不存在）→ exit 0。
  - ⑤⑥：双 active 同教训两条 → exit 1；合法 supersede 配对（旧条已改 superseded）→ exit 0；新条 supersedes 旧条（教训已改写）但旧条仍 active → exit 1；**supersedes 悬空目标（教训已改写）→ exit 1；自指 → exit 1；三点成环 → exit 1（P2-2）**。
  - `--report`：夹具三个 change（其一未声明 experience-loop schema、其一引用经验两条仅复查一条、其一引用悬空 id）断言分母为 2、引用率 50%、**引用对覆盖率 50%**、悬空引用数 1，且存在违规文件时仍 exit 0；`--report` 与 `--change` 同给时忽略校验。
  - **同步测试（N18）**：`_template.md` frontmatter 键集 == lint ② 认识的字段全集（八字段）。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** `experience-lint.mjs`（零依赖；frontmatter 解析仅支持 `key: value` 与 `key: [a, b]` 两种形态，遇到不支持的形态报错而非静默跳过）与三件规约文档（README 字段表 = Global Constraints 镜像、状态机 `active → superseded/expired`、退役**与改名**指引：capability 退役或改名时 active 条目改标 `general` 或 `expired`、INDEX 并发指引：按 id 排序插入，冲突走 git 合并）。
- [ ] **Step 4: 确认通过** — vitest PASS；对真实仓库根 `node extensions/experience-loop/scripts/experience-lint.mjs --project .` 在无 experience 目录时 exit 0（视为空经验库；本任务时点脚本尚未安装，用规范源路径，安装路径 Task 6 落位）。
- [ ] **Step 5: Commit** — `feat(ext): experience store spec with enforcement and metrics lint`。

---

### Task 5: 验证闭环（verification 贯通 tasks 与 retro）

**Files:**
- Modify: `extensions/experience-loop/schema/schema.yaml`（`tasks` 工件的 `instruction` 字段）
- Modify: `extensions/experience-loop/schema/templates/tasks.md`（加「经验验证任务」编写指引注释）
- Modify: `extensions/experience-loop/schema/templates/retro.md`（「## 上次经验复查」段对齐判定行格式）
- Test: `test/extensions/experience-loop-schema.test.ts`（追加用例）

**Interfaces:**
- Consumes: Task 3 的「经验处置」结构、Task 2 的「## 经验引用」、Global Constraints 的验证任务格式与判定行格式。
- Produces: 闭环约定（Q12 口径，外部审查建议 1/2 定稿）——proposal 引用经验 id 时，propose 在普通任务列表中为每条经验创建**跟踪任务** `- [ ] [经验 <id>] <验证动作>（判定标准：<一句话>）`（进入 apply 待办，由实施执行并留下完成证据）；**引用 change 自身的 retro** 在「## 上次经验复查」按判定行格式对本 change 引用过的每条经验结案，并更新经验文件 `status` 或补记成效。

- [ ] **Step 1: 写失败测试** — 断言：tasks instruction 含跟踪任务要求与 `[经验 <id>]` 前缀格式（普通跟踪任务走标准复选框——与 fork 自 spec-driven 的"非跟踪 bullet 仅限文末 Workflow follow-up"约束**零冲突**，测试断言 instruction 不新增非跟踪 bullet 章节）；retro 模板「## 上次经验复查」含判定行格式与"依据验证任务的完成情况与证据"措辞；schema validate 仍通过。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** — tasks instruction 加一段：「为『## 经验引用』中每条经验创建一条普通跟踪任务，标题以 `[经验 <id>]` 开头，验证动作与判定标准入任务文本；该任务随其余任务进入 apply 待办」；tasks.md 模板加编写指引注释（空态："无引用经验时无此类任务"）；retro.md 复查段按判定行格式 + 证据措辞。
- [ ] **Step 4: 确认通过** → **Step 5: Commit** — `feat(ext): verification loop as tracked tasks with retro judgment`。

---

### Task 6: 安装脚本、README 与 dogfooding 验收

**Files:**
- Create: `extensions/experience-loop/scripts/install.mjs`、`extensions/experience-loop/README.md`
- Test: `test/extensions/experience-install.test.ts`

**Interfaces:**
- Produces: `install.mjs` CLI —— `node install.mjs [--project <root>] [--force]`：
  1. 把 `schema/` 复制进 `<root>/openspec/schemas/experience-loop/`（已存在且内容不同则拒绝除非 `--force`）；
  2. 把 `experience-store/` 的 `README.md`/`_template.md`/`INDEX.md` 初始化进 `<root>/openspec/experience/`（已存在则跳过）；
  3. **把 `scripts/experience-lint.mjs` 复制进 `<root>/openspec/experience/experience-lint.mjs`（运行时唯一路径，覆盖式更新）**；
  4. stdout 输出建议的 config 片段供人工粘贴进 `openspec/config.yaml`（不自动改 config——策展区归人）：

```yaml
operations:
  archive:
    guidance:
      - 归档前运行 node openspec/experience/experience-lint.mjs --project <root> --change <name>，非零退出则停止归档；输出向用户展示，不写入任何工件
```

- [ ] **Step 1: 写失败测试** — 临时项目：安装后 `runCLI(['schema', 'validate', 'experience-loop', '--json'])` exit 0；`<root>/openspec/experience/experience-lint.mjs` 存在且可执行（跑 `--help` 或空校验 exit 0）；重复安装不覆盖 schema 但刷新 lint 脚本、不报错；`--force` 覆盖 schema；stdout 含 guidance 建议片段且路径为 `openspec/experience/experience-lint.mjs`、文案为"非零退出则停止归档"。
- [ ] **Step 2: 确认失败** → **Step 3: 实现** install.mjs 与 README（**安装模型声明**：install.mjs 一次性完成 schema/经验库/lint 脚本三件落位，消费者无需 vendor 扩展目录；运行时一律用 `openspec/experience/experience-lint.mjs`）。安装四步：install.mjs → 粘贴 guidance 建议 → schema 选择：按 change 声明 `schema: experience-loop`（`.openspec.yaml`）或 `openspec new change --schema experience-loop`；项目默认**手改 `openspec/config.yaml` 的 `schema: experience-loop`**（核心对已安装 schema 无设默认命令，`schema init --default` 仅服务新建）→ **部署 lint 到 CI/pre-commit（MUST；扩展包不附带 CI 配置，各项目自行接线；CI 跑默认模式）**。迁移说明：存量 change 保持旧 schema（lint ① 不对其执法，见范围限定），新 change 用新 schema。已知边界 = 残余风险 10 条原文收录：①软执法本质（CI 未部署/被绕过时无拦截，instruction 均为行为契约）；②continue/new 工作流指令冲突靠 instruction 权威条款软裁决；③脱敏不机扫；④生效率主观判定、无对照组、多经验同 change 不可归因，引用率/覆盖率仅为暴露度；⑤store 共享时经验库跨项目混流（经验目录跟 planningHome.root）；⑥x- 键拼错核心静默，体验依赖 lint 报错文案；⑦capability 改名同退役处理；⑧检索无语义相似度，措辞差异大的重复条目绕过查重；⑨前扩展时代 change 不参与闭环（分母已排除）；⑩新 capability 的经验入库与归档同步之间存在默认模式红窗（外部审查 P1-1 接受项：`--change` 模式已放宽待同步 capability，推荐"同步规格 → 经验入库"顺序收窄红窗）。
- [ ] **Step 4: dogfooding 验收**（手动清单，逐项打勾记录在 PR 描述）：
  - [ ] 对本仓库执行 install.mjs，`openspec schema validate experience-loop` 通过，guidance 片段粘贴进本仓库 config。
  - [ ] 本仓库新建一个真实小 change 走完 `/opsx:explore → propose → apply → archive`：proposal 含「## 经验引用」（首轮空库应写"无可引用经验"），引用经验时 tasks 含 `[经验 <id>]` 跟踪任务并随 apply 完成，archive 前产出 retro 并经人工确认写入 ≥1 条经验，`node openspec/experience/experience-lint.mjs --project . --change <name>` exit 0。
  - [ ] **增量流试跑（S1）**：用 `new`/`continue` 流走第二个 change，验证 tasks 完成后 retro **不会**被提前创建（instruction 条件化生效），archive 前才出现。
  - [ ] **冷验收（P4）**：全新会话跑 `/opsx:archive` 且**不提及 retro**，观察 archive 技能的工件完整性检查是否自动报出 retro 未完成。
  - [ ] **CI 红绿验收（N12 + 外部审查 P2-1）**：规划期提交（active change 无 retro）→ 绿；缺 retro 的 change 归档入库后跑默认模式 → 红；补齐 retro（或 `x-skip-retro` + stub）→ 绿；**旧 schema change 归档入库 → 绿（不误伤，P1-2）**。
  - [ ] 第三个 change 的 proposal 检索到第 1 条经验并引用其 id；tasks 含 `[经验 <id>]` 跟踪验证任务；本 change 的 retro 按判定行格式结案。
  - [ ] `node openspec/experience/experience-lint.mjs --project . --report` 输出三项指标（含引用对覆盖率与悬空引用数）可读。
- [ ] **Step 5: Commit** — `feat(ext): installer, docs, and dogfooding acceptance`。

---

## Self-Review 结论（已执行，含 R1-R4 与外部审查修正复核）

1. **覆盖**：Q1-Q14 + 事实修正 + R1（S1/M1-M5/P1-P5）+ R2（N1-N12 + 残余 9 条）+ R3（N13-N18）+ R4（3 轻微）+ 外部审查（P1-1/P1-2/P2-1/P2-2 + 建议 1/2）全部映射到任务与 README，无缺口。
2. **步粒度**：每步可写出唯一合理产物；模板正文只给要点不誊写全文。
3. **类型一致性**：`exp-YYYYMMDD-<slug>`、`x-skip-retro`（+ stub 蕴含 + stub 形态判定）、status 三值、`supersedes`（新条→旧条 + ⑥ 无前提全查：存在/禁自指/查环/旧条必 superseded）、判定行格式、验证任务格式（跟踪任务）、INDEX 行格式（第 5 列逐字）、lint 三模式签名（`--change`/默认/`--report`）与统一安装路径在各任务间一致；字段与格式单一定义源（Global Constraints），README/`_template.md` 为镜像且有同步测试锚点。
4. **Review Focus**：7 条全部绑定到 Task 4 的具体测试步骤。
5. **比例**：计划主体是任务与接口而非代码正文，无遗留 TBD。
