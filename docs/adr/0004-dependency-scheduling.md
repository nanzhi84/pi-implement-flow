# ADR 0004：依赖解锁、活动并发与资源生命周期

状态：Issue #5 实施协议；通过与否由绑定提交的真实验收报告决定。

调度器只保存本控制器生命周期中的 acceptedFeatureHead、Submission、Delivery 和等待状态；不写执行账本。feature 创建一次。ready Ticket 在短 integration 控制权内核对 scope、精确 feature SHA 和依赖 M 的 ancestry，固定 startedFrom，再进入独立 worktree。初始 closed Issue 没有本轮 Delivery，不能释放下游；文件交叠不产生业务依赖。

实现结果提交可以晚于其它 Ticket 的合入。提交只负责自己的分支与 H，不要求 feature 仍等于其原 startedFrom。集成控制权覆盖选择最新 B 到 C/M 门禁、实际合入、证据、关票 readback 和最终 scope/ref 核对。仅完整 Delivery 更新 acceptedFeatureHead。候选不可用或新组合语义失败时安全停止；自动修复由 #6 实施，不用旧通过结果替代新候选。

计算许可包住实际 prepare/check/accept/cleanup/publish 命令和独立实现/审查会话。角色内部受批准 bash 属于同一会话许可。等待依赖、用户、资源或集成不占槽；命令到进程组停止、角色到 abort/settle/idle/dispose 后才归还。资源 lease 从 prepare 前一直持有至 cleanup 及发布使用结束；exclusive 合同串行整个生命周期，含等待 review。

ScopeGuard 的短互斥涵盖 fresh read/比较及 close→响应→completed readback→confirmedClosed 更新，避免自己的关闭与其它 Ticket 读取相撞。该集合只改变 lifecycle 期望，不授权下游。锁顺序为 integration→scope 或 integration→resource→activity；implementation 释放 resource/activity 后才等待 integration；scope 不反向申请其它锁。

普通许可等待支持取消，cleanup 用无取消许可但仍受同一上限。PROCESS_UNQUIESCED 在释放前保留许可并冻结普通队列；资源无法确认清理时保留资源和仓库所有权。若所有容量被未停活动占用，cleanup 明确报 pending，不无槽执行或无限等待。取消不回滚真实 GitHub 效果；unknown 与 M/closure-pending/closed-unaccepted 事实优先于后续取消，禁止迟到结果解锁。普通错误安全停止，只有明确 implementation blocked/no-diff 作为局部结果。

当前全部票交付后仍 `paused (final-acceptance-not-installed)`；Spec open、总 PR Draft、main 不变。外部写入只能检测后停，不宣称 GitHub 提供跨 branch/Issue CAS。当前现场需要显式协调后续恢复，不能重复 start 覆盖成果。
