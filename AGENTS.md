## 待办队列（issue/）
每次开工前先读 `issue/INDEX.md`，把状态≠已完成的待办列给用户选继续哪些；
做完一条就更新 `issue/<id>.md` 的 frontmatter 状态，并同步 `issue/INDEX.md` 对应行
（改完跑 `node scripts/todo-lint.mjs --project .` 确认一致）。
