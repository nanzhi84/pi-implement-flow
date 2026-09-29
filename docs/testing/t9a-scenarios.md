# T9A 基础设施故障与失败报告：实现前行为边界

目标：真实 pi `/flow start` 遇到暂时模型/远端读取/项目环境故障时，有有限恢复或明确停止；不重复启动 Ticket、不制造修复票、不错误 merge。SDK 负责其已批准的 retry，控制器只调用一次 session.prompt；远端写结果未知保留既有 stopping/ownership 语义，不能根据 transient 诊断重放。

## 先识别的失败方式

- 暂时 503 后恢复：实际 SDK 可以完成第二次调用；不可额外创建会话重开任务。
- 持续 503：项目约定 maxRetries=2 时最多 3 次传输请求；耗尽后一次明确停止，不重开 session。
- 401 权限/认证、429 insufficient_quota：永久原因不得伪装为暂时限流继续调用。
- HTTP 200 但模型 JSON 不合法：不是网络错误，不触发外层恢复。
- SDK 退避期间真实 `new_session` RPC 引发暂停：等待实际取消与工具收敛，无后续模型调用或 Git/GitHub 新写入。
- GitHub 读取返回 EOF 或明确权限错误：保留安全 operation/kind/reason；只调用一次。诊断不含 stderr、鉴权头、响应正文或本机路径。
- 明确证书过期或不受信任：属于 configuration/tls，transient=false。宽泛 TLS 握手或 SSL_ERROR_SYSCALL 不能证明暂时性，报告 unknown/tls 且不设置 transient；复用真实读取成功后的 CLI 注入分别验证 expired、untrusted 和无法归因 TLS 三种边界。
- check/accept 的普通 exit 1：无法证明是代码缺陷，停止而不生成行为失败或修复 Ticket。
- check/accept 显式行为失败：仅接受退出码 1、完整严格 UTF-8 JSON、正确 SHA、唯一且完整的有界断言集合；至少一项 false。报告摘要绑定原始字节，不充当修复进展或执行账本。
- 显式 environment/configuration 报告：是执行问题，不是行为缺陷。
- 所有已有可信项目阶段须保留 phase operation 和安全 detail；preflight/Ticket cleanup 的包装不能抹掉底层原因。现有真实 T1 preparation failure 和 cleanup/publish quiescence 场景增加 phase/detail 断言，不扩大行为失败或修复授权。
- 错 SHA、额外字段、重复/空/全通过断言、混日志、非法 UTF-8、超限或退出码与报告矛盾：不能取得修复资格或绕过 gate。
- 正常退出前输出了合法失败 JSON，但后来超时/取消/信号结束/进程未停止：生命周期错误优先。无法确认 quiescence 时保留 ownership 与工作空间。
- 既有 exit 0 check 文本、accept 成功协议、原始 Buffer 资产校验必须保持；新失败协议是 opt-in。
- 实际远端写成功但客户端返失败：仍为 unknown，不因为 transport 可重试就普通 replay。复用既有 push-unknown 用户路径验收。

## 验收选择

新增 `tests/infrastructure.test.mjs` 经真实 pi/SDK/GitHub 执行 loopback 模型 transport 及 OS/CLI 故障注入；不 mock FlowController、SDK 重试实现或生产 parser。每场景独立 Spec/Ticket/clone，记录成功/失败终态、具体 request/command 次数、脱敏 FailureDetail、保留现场与未 merge/无额外子票的远端断言。固定响应明确不证明模型质量。

正常真实 OpenAI 实现与候选/实际 review 复用 integration 的 real-integration；字节完整性复用 evidence-unavailable；生命周期与 unknown replay 复用 ticket-faults，以及已有 T1 unquiesced 行为必要选定场景，不机械重跑全部历史 39。SDK retry disabled 的既有合同分支未被本次改写，若未单独跑真实场景则不得宣称其新增验收。

先写行为脚本，再修改生产代码。最终验收在独立 review 后的 clean commit 运行，记录初末 SHA/dirty/源码内容指纹、真实宿主 SDK、baseline、选择/skip、最终子进程 exit 和完整断言。中途 rows、HTTP 成功、typecheck 或旧 SHA 通过不能作为最终来源；前置传输故障保留原报告，可同版本 fresh fixture 精确补验。

## 真实前置失败暴露的 Harness 边界（修正前记录）

冻结 c791 的完整 18 场景在前 5 项通过后，取消场景先于模型调用遇到 `PUBLISH_UNRESOLVED`，控制器正确保留 ownership。测试仍等待 `MODEL_RETRY` 满 10 分钟；pi 随 teardown 退出后，自己留下的 socket 又使后 12 项仅得到 `FLOW_OWNED`，未触及目标注入。该次真实 exit 1 / pass 5 / fail 13 保留为历史，不伪称取消或后续故障验收成功。

最小修正仅作用于基础设施 Harness：

- 模型 retry 等待同时观察实际 `/flow` Promise 完成；如果流程先停止，及时失败，且没有遗留等待计时器继续拖住进程。未观察实际 retry 不能发取消并声称目标通过。
- 每个基础设施场景开始时确认对应仓库不存在 controller socket；已有或无法判定的资源一律拒绝，不争抢。场景的所有 pi 进程退出后，才可核对新产生资源确为 socket、属于本用户、`lsof` 明确无 owner，且前后 device/inode 一致；只清本测试留下的陈旧 socket，不删除 Git/工作空间或重放远端动作。
- 失败证据只保留外部通知中的结构化安全诊断，不存原始 stderr、模型输出、token、本机路径或整个通知串。采集缺失不能推断故障原因。

每项业务断言继续检查运行中的 ownership/停止行为；teardown 只整理已退出的测试进程遗留物，任何清理疑义仍让 Node 最终退出失败。修正后在新冻结源码重新执行目标 E2E，不复用旧 SHA 的中间通过作为新来源。
