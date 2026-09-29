# 验收仓库隔离边界

实现前失败方式：

- 环境变量拼写错误、大小写差异、任意仓库或空值不得退回默认并写到意外位置。
- 允许名称被 GitHub 重定向至其它 canonical repository 时，必须在创建合成 Issue 前拒绝。
- Integration bridge 的配置仓库、环境选定仓库与当前 clone origin 不一致时，不得启用写入故障注入。
- 同仓库的多个 clone 不提供 controller 隔离；不同仓库才允许不同流程并行。GitHub 账户限流仍可能共享。
- 不迁移依赖固定 Issue 编号和保护规则的 T1 fixtures，不通过修改它们制造并行能力。

`FLOW_ACCEPTANCE_REPOSITORY` 未设置时保留 `nanzhi84/pi-implement-flow-acceptance`；显式设置只允许该名称以及 `nanzhi84/pi-implement-flow-scheduling-acceptance`、`nanzhi84/pi-implement-flow-repair-acceptance`、`nanzhi84/pi-implement-flow-exclusive-acceptance`、`nanzhi84/pi-implement-flow-reconciliation-acceptance`。fixture 在任何远端写入前核对选中 repo 的 canonical full_name 与数字 id；bridge 还核对选中 repo 与 config、clone origin。

本补丁只提供受约束的仓库选择，不声称已验证新仓库的项目行为。各 Ticket 使用实际仓库 baseline、资源契约及原始最终 runner 报告验收；不得假定各验收仓库总是具有相同 main。静态语法检查不替代各 Ticket 的真实路径验收。
