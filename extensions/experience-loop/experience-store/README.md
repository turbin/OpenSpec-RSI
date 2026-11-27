# openspec/experience/ — 经验库规约

本目录是**经验生效区**（propose 检索、retro 写入），与 `openspec/config.yaml` guidance
（人工策展区）分离。以下字段与格式规范的唯一定义源是实施计划的 Global Constraints，
`experience-lint.mjs` 按此校验（`_template.md` 为镜像，同步测试锚点）。

## 经验条目：单条一文件

文件名 `exp-YYYYMMDD-<slug>.md`，frontmatter **八字段**（`supersedes` 可选）：

| 字段 | 规则 |
|---|---|
| `id` | 与文件名一致 |
| `date` | `YYYY-MM-DD`，与文件名内嵌日期一致 |
| `source_change` | 来源 change 名 |
| `capability` | `specs/` 相对路径或 `general` |
| `tags` | 数组，如 `[api, auth]` |
| `status` | 仅 `active \| superseded \| expired` |
| `supersedes` | 可选，**仅新条目填写**，值为被取代旧条的 id |
| `verification` | 一句话：下次如何验证生效 |

正文固定两节：`## 教训`（一句话结论——**首行**逐字进入 INDEX 第 5 列，也是 lint ⑤ 归一化
查重键）、`## 依据`（发生了什么，引用 change 工件）。

## INDEX.md

一行一条（表格式五列），与经验文件**双向一致**，lint ③ 逐列比对
（id/capability/tags/status/教训首行，教训列归一化比较）：

```
| <id> | <capability> | <tags 逗号分隔> | <status> | <教训首行（逐字）> |
```

按 id 排序插入；并发编辑冲突走 git 合并。

## 状态机

```
active ──► superseded   （被新条 supersedes 取代）
active ──► expired      （过期/失效）
```

## 去重与取代（写时去重）

同 capability 同教训（归一化相同）优先 **supersede 取代**而非并存：新条填
`supersedes: <旧条 id>`，旧条同时改 `status: superseded`（lint ⑥ 强制：目标必须存在、
禁自指、禁环、旧条必为 superseded）。双 active 平行条目会被 lint ⑤ 打回。

## capability 退役与改名

capability 被退役（`retire_capabilities`）或改名后，引用它的 **active** 条目会触发
lint ④（仅 active 校验）：将其改标 `general` 或 `expired`。

## 校验

```
node openspec/experience/experience-lint.mjs --project <root> [--change <name>] [--report]
```

- 归档前（`--change`）：查该 change 的 retro（蕴含式 + `x-skip-retro: true` 豁免，
  豁免仍须 stub `skipped: x-skip-retro`）+ 全局经验库校验；接受该 change delta 声明的
  待同步 capability。
- 默认（CI）：retro 检查仅覆盖 `changes/archive/`；推荐顺序"同步规格 → 经验入库"以
  收窄新 capability 的红窗。
- `--report`：引用率 / 引用对覆盖率 / 悬空引用数等指标，恒 exit 0。

**已知边界**：脱敏不机扫（密钥/个人信息靠 retro 规程 + 人审）；`supersedes` 之外的语义
重叠（措辞差异大的重复条目）绕过查重；生效率为主观判定。
