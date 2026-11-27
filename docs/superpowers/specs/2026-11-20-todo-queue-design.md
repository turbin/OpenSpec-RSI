# 待办队列（issue/ + INDEX + AGENTS.md 约束）— 设计稿

日期：2026-11-20 · 状态：**待批准**（未批准不动手）

## 意图与为什么
大任务/跨会话工作里，拆出来的待办子项容易丢、难续。建一个 agent 每次开工都能看到的待办队列：列出未完成项让用户选继续哪些，做不完留到下次接跑。

## 目标
- `issue/` 存待办：一文件一条，带状态。
- `issue/INDEX.md`：一行一条同步"摘要 + 状态"。
- `AGENTS.md` 约束：每次开工读 `issue/INDEX.md` 未完成待办、列给用户选继续；做完更新状态 + 同步 INDEX。

## 非目标 / 反目标
- 不进 OpenSpec：OpenSpec 输出（`instructions --json` 等）**不含任何待办内容，连指针都不含**。
- 不做 OpenSpec schema/config 集成（约束走 `AGENTS.md`，不走 `config.yaml`）。
- 不做自动任务拆解；不做语义检索。

## 约束
- OpenSpec 输出 100% 不碰 issue。
- 约束落 `AGENTS.md`（harness 层），不依赖 OpenSpec 是否安装进 OpenCode。
- 复用 experience-loop 的 folder + INDEX + lint 模式（INDEX↔文件双向一致）。

## 方案（Approaches）
- **A 轻量约定（选中）**：`issue/` + `issue/INDEX.md` + `AGENTS.md` 约束段 + lint 校验。最简、本仓够用、OpenSpec 完全不碰。
- **B 可安装扩展包**（`extensions/todo-queue/`，install.mjs 生成骨架 + 插 AGENTS.md + 装 lint）：跨项目复用，但重，且约束仍靠 install 写进 AGENTS.md。
- **选 A**：本仓先跑通即可；除非将来要跨项目复用，才升级到 B。

## 已定的 how
- 待办文件 `issue/<id>.md`：frontmatter `id / 标题 / 状态 / 摘要`，正文写细节。
- 索引 `issue/INDEX.md`：一行一条 `| id | 标题 | 状态 | 摘要 |`，与文件双向一致。
- 状态：`未开始 / 进行中 / 已完成 / 受阻`。
- lint 脚本（仿 `experience-lint.mjs`）：校验 INDEX↔文件双向一致、状态取值合法。
- `AGENTS.md` 追加约束段（示意："每次开工先读 issue/INDEX.md，把状态≠已完成的列给用户选继续；做完更新 issue/<id>.md 状态并同步 INDEX"）。

## 留给 builder
- lint 具体规则与错误提示。
- `issue/<id>.md` 的精确 frontmatter 字段。
- `AGENTS.md` 约束段措辞。
- 待办产生方式（默认"手动 / 大任务拆子项"）的具体触发。
