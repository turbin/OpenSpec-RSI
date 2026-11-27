# experience-loop — OpenSpec 经验闭环扩展包

change 收尾产出 retro 工件 → 人审后沉淀为结构化经验（`openspec/experience/`）→
下次 propose 按 capability/tags 检索注入 → 验证动作落为跟踪任务，由引用 change
自身的 retro 按判定行结案。纯扩展包：**不改核心 CLI、不改生成的技能模板**。

## 安装模型

`install.mjs` 一次性完成三件落位，**消费者无需 vendor 扩展目录**：

| 源 | 目标 | 策略 |
|---|---|---|
| `schema/` | `openspec/schemas/experience-loop/` | 已存在且内容不同 → 跳过覆盖（`--force` 覆盖） |
| `experience-store/{README,_template,INDEX}` | `openspec/experience/` | 已存在 → 跳过 |
| `scripts/experience-lint.mjs` | `openspec/experience/experience-lint.mjs` | **覆盖式更新**（运行时唯一路径） |

```
node install.mjs [--project <root>] [--force]
```

## 安装四步

1. 运行 `install.mjs`；
2. 把输出的 guidance 建议片段粘贴进 `openspec/config.yaml`（人工策展，安装器不自动改 config）；
3. schema 选择：按 change 声明 `schema: experience-loop`（`.openspec.yaml`）或
   `openspec new change --schema experience-loop`；项目默认**手改 `openspec/config.yaml`
   的 `schema: experience-loop`**（核心对已安装 schema 无设默认命令，`schema init --default`
   仅服务新建）；
4. **部署 lint 到 CI/pre-commit（MUST）**：`node openspec/experience/experience-lint.mjs
   --project <root>`（默认模式）。**扩展包不附带 CI 配置，各项目自行接线。**

## 迁移说明

存量 change 保持旧 schema（lint ① 仅对显式声明 `schema: experience-loop` 的 change 执法，
不误伤）；新 change 用新 schema。

## 校验与度量

```
node openspec/experience/experience-lint.mjs --project <root> [--change <name>] [--report]
```

- 归档前 `--change`：retro 蕴含式检查（`x-skip-retro: true` 豁免仍须 stub）+ 全局经验库校验；
- 默认（CI）：retro 检查仅覆盖 `changes/archive/` 归档集合，规划期提交天然通过；
- `--report`：引用率 / 引用对覆盖率 / 悬空引用数等，恒 exit 0。

## 已知边界（残余风险）

1. **软执法本质**：CI 未部署或被绕过时无任何拦截；instruction 均为行为契约。
2. **continue/new 工作流指令冲突**靠 instruction 权威条款软裁决（retro 条件化创建）。
3. **脱敏不机扫**：密钥/个人信息只靠 retro 规程 + 人审门。
4. **生效率是主观判定**：无对照组、多经验同 change 不可归因；引用率/覆盖率仅为暴露度。
5. **store 共享时经验库跨项目混流**：经验目录跟 planningHome.root 走。
6. **x- 键拼错核心静默**：fail-closed 安全，但体验依赖 lint 报错文案。
7. **capability 改名同退役处理**：active 条目改标 `general` 或 `expired`。
8. **检索无语义相似度**：措辞差异大的重复条目绕过归一化查重。
9. **前扩展时代 change 不参与闭环**：`--report` 分母已排除。
10. **新 capability 的红窗**：经验入库与归档同步之间默认模式会报错（`--change` 已放宽待同步
    capability；推荐"同步规格 → 经验入库"顺序收窄红窗）。
