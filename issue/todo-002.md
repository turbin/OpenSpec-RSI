---
id: todo-002
title: 试跑 tdd-e2e 并评估 agent 修复 loop
status: 未开始
summary: v1 落地后验证门禁，记录真实 change 是否需要人工唤起 agent 继续修复
---

前置：`tdd-e2e` v1 落地，受管归档和 CI required check 已接线。

按[设计文档 §7.1](../docs/superpowers/specs/2026-11-26-tdd-e2e-artifacts-design.md#71-修复-loop-试点)执行：

- [ ] 用可复现回归验证红灯拦截，修复后确认新候选通过验收。
- [ ] 用真实 change 试跑，记录 run ID、失败摘要和是否需要人工重新唤起。
- [ ] 记录试点结论。达到设计中的两个独立 change 阈值时，重开本地修复 loop 设计议题。
