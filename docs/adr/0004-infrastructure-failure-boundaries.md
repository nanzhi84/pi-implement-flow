# 0004：故障诊断与 SDK 有界恢复

状态：对应 Issue #10（T9A）。本文定义协议；验收结果以绑定源码的最终报告为准。

## 决策

模型、远端、项目命令和行为缺陷使用不同的可信边界。`FailureDetail` 只包含操作、类别、原因及可选数字状态、退出码、信号、CLI 启动事实。最多在内存检查 16 KiB 诊断文本，原始错误、正文、路径、鉴权头和 `cause` 不进入该结构。已知暂时问题可以标记 `transient`，这只是诊断，不能授权重试、修复、合入或释放 ownership。无法分类时明确为 unknown。

唯一底层命令执行器 `captureCommand` 保留原始 stdout Buffer。正常数值退出才返回；取消、超时、信号、输出超限、未收敛进程优先抛错，即使此前 stdout 已给出合法行为失败报告。`runBytes` 和 `run` 复用该执行器。`commandStart: not-started` 只表示同步启动异常或无 pid/无 spawn 事件的明确启动失败；`started` 不证明远端请求已发送，更不证明远端副作用已落地。

每个角色仍只有一个 `session.prompt`。已批准的 SDK `retry.enabled/maxRetries` 负责其恢复，provider 重试为零，不叠加控制器重启循环。真实宿主 pi 0.99.1 的 SDK 会排除配额/计费类永久失败，依有限策略恢复支持的暂时错误，并让取消打断退避。扩展不重新实现其重试规则。每次 retry 通知只有安全分类；耗尽或永久失败保留现场并结束当前操作。不保存重试计数，不创建修复 Ticket。开发类型依赖仍为 0.87.1，实际验收报告分别记录宿主 CLI、宿主 SDK 与本地依赖版本。

GitHub 读操作复用同一命令生命周期并透传安全分类，不新增重放；远端写与发布结果不确定仍保留现有 `REMOTE_RESULT_UNKNOWN` / `PUBLISH_UNRESOLVED` 和 ownership 语义。即使诊断为 EOF，也不能把未知副作用转成普通 retry。精确远端结果恢复属于 #11。

## 项目失败报告

成功命令兼容原约定：exit 0 的 check 可以返回原有文本，accept 仍须通过既有成功验收解析。新增协议仅为 opt-in 的失败报告，不改变成功协议。

`check` 或 `accept` 只有正常 exit 1、stdout 为单份严格 UTF-8 JSON、报告大小不超过 256 KiB，才可能提供以下结构：

```json
{"schema":"flow-command-failure-v1","kind":"behavior","codeSha":"<controller 的 40 位 SHA>","assertions":[{"name":"greeting-for-name","passed":true},{"name":"whitespace-rejected","passed":false}]}
```

报告仅接受展示字段；assertions 为 1–2048 项，每个名称唯一，匹配 `[a-z0-9._-]{1,80}`，passed 为布尔值，至少一项 false。必须提交完整断言集合；控制器验证结构和 SHA，不能从报告结构证明项目没有遗漏断言。`ReportedBehaviorFailure.report` 包含命令、SHA、不可变断言集合和原始 stdout 字节的 SHA256，不保留正文。摘要是字节身份，不是进展标记。结构合法仅证明命令显式报告行为失败；#6 还须完成工作区核对、cleanup、失败证据发布下载校验和 scope/version 绑定后才授予修复资格。

执行失败也可使用 exact-key 报告：

```json
{"schema":"flow-command-failure-v1","kind":"execution","codeSha":"<controller 的 40 位 SHA>","category":"infrastructure","reason":"connection-refused"}
```

允许的 category/reason 对为：infrastructure 的 connection-refused、dns、tls、timeout、service-unavailable、rate-limit；configuration 的 missing-dependency、missing-configuration、authentication、permission；unknown 的 unclassified。它们只产生执行诊断，不能转换为 `ReportedBehaviorFailure`。

错 SHA、字段/类型异常、重复断言或全通过失败报告拒绝为 `COMMAND_REPORT_INVALID`。exit 0 返回保留 schema 也因矛盾拒绝。混合日志、非法 UTF-8、过大或非协议 exit 1 保持普通 `COMMAND_FAILED`，不会猜测其中某段 JSON 或根据通用 exit 1 创建修复。生命周期错误优先于任何报告。

## 验证与边界

实现前清单见 [T9A 场景](../testing/t9a-scenarios.md)。真实 pi/SDK 调用真实 loopback HTTP 服务验证有限恢复、耗尽、永久认证、配额、非法返回与退避取消；测试进程观察准确请求数。远端读取/项目命令注入先执行真实成功操作，再返回明确故障，避免把环境前置失败误当注入成功。正常 OpenAI 实现和独立 review、资产字节与 unknown push 回归使用既有用户路径另附报告。

固定模型不是模型质量证明；有限样例不是所有 provider 错误的穷举。报告保留实际 skipped 和未验证边界。#6 修复与 #11 远端恢复各自负责其新增业务资格，本票不提前创建账本或恢复状态。
