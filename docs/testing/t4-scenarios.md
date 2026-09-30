# T4 并行调度的外部行为约定（实现前）

对应 Issue #5。先定义以下真实 pi 用户路径，再实现调度器；本文件不是通过记录。默认并发 2，实际模型使用 openai/gpt-6-astra，确定性故障才使用明确标注的 loopback HTTP provider。实现后因批准 implementation 角色无 bash 权限，端口握手放入批准 prepare 命令，另断言真实 OpenAI 会话生命周期重叠；未扩大角色权限。

| 场景 | 可控边界 | 外部断言 |
| --- | --- | --- |
| real-openai-diamond | 新合成原生依赖图 A/B→C；A/B 各写独立 CLI 与 acceptance 文件 | 真实实施 prepare 命令同时持有不同 loopback 端口，用相同逻辑 key 读写不同数据；A/B 分别实际集成、M 重验、关票；C 首次实施起点包含两个已接受 M；远端 combined CLI 正确 |
| slot-release-and-local-block | 两个独立实现同时结束等待集成；修改同一文件不相交区域；独立 D 返回具体未声明需求阻塞，E 依赖 D | review 能取得统一活动槽、无互占死锁；无关 A/B 可交付；D/E 不合入；原生依赖无自动加边；所有命令/角色活动不超过并发上限 |
| exclusive-real-resource | 固定 exclusive 合同；harness 拥有的共享服务/namespace 由真实 prepare/cleanup 请求争用 | 第二资源生命周期必须等首个 cleanup/停止；等待 review 期间资源仍归原 owner；等待资源不占计算槽；不把 harness 服务冒充 controller 孤儿进程 |
| latest-base-semantic-conflict | A/B 从 B0 实施，A 先交付；B 在 B0 的行为对照可通过，但 A+B 的最新候选行为失败 | B 必须针对最新 B 的 C 实际重验；不能使用旧起点通过或无文本冲突取得合入；失败后 Ticket open、没有错误 merge/close，保留成果 |

正常图采用固定 isolated 仓库基线，exclusive 使用独立固定 exclusive 仓库；任何验收不得在运行中篡改合同来切换资源模式。新增行为文件必须先于实现写入，原 Ada/missing 断言保留，候选和实际门禁报告实际执行所有 acceptance/*.mjs。

停止与竞态：自己的 Issue 关闭/readback 与其它 Ticket 的 scope 读取互斥，confirmed closure 不等于 Delivery；closed 的初始依赖不能解锁。等待用户/依赖/资源/集成不持计算槽。普通取消撤销排队回调；cleanup 用受同一上限约束的无取消许可。未停止进程在释放前冻结普通队列，保留其活动许可、资源及仓库控制权；若无安全容量执行其它 cleanup，明确 stopping/cleanup-pending，不能假称已清理。未知远端副作用不重复写，不接受迟到结果。

端口只在前台批准命令内部启动、实际访问、关闭并等待结束，禁止 prepare 后台启动后返回，保持现有 process-group orphan 协议。屏障等待实际事件，不用固定 sleep 制造并行。每次 runner 保存初末源 SHA/clean/指纹、宿主/模型、实际远端仓库 baseline、图/PR/H-B-C-M/工件原始哈希、重叠和资源断言、故障边界、最终退出状态。失败现场和历史报告保留；不包含 auth、真实凭据、原始模型会话或私有路径。

本票不自动修复冲突、不恢复旧 flow、不完成最终 Spec；全部本轮可交付票完成后总 PR 仍 Draft、Spec open、main 不变。按受影响边界复用既有真实 integration、取消、scope/生命周期及 unknown-write 验收；不新增实现镜像单元测试。

## 首轮真实路径暴露的候选基线边界（修复前）

3984d0a 的真实 A/B→C 场景中，两张 Ticket PR 在 A 合入前创建。A 完成交付后，B 的 GitHub PR base SHA、potential merge commit 和 `refs/pull/<n>/merge` 仍绑定旧 B0；数分钟后的独立 REST、GraphQL 与 Git 读取保持一致。控制器以 CANDIDATE_UNAVAILABLE 停止，未错误合入，也未启动 C。这是并行目标路径未完成，不能计为本票验收通过。

修复采用首次 PR 创建延后：实现先 commit/push 并进入 submitted 队列，释放活动槽与已清理资源；集成持锁选择最新 B 后才创建该 Ticket 的第一张 PR。继续核对 C 的有序父提交 `[B,H]`，不刷新旧 PR、不重复 push、不增加候选 branch，不靠无限轮询使旧证据有效。

复用现有 diamond、同文件队列与语义冲突场景增强外部断言：至少两个真实 submitted 可在首次 review 前存在；每张 Ticket PR 的实际创建请求发生在其 submitted 之后，若已有前票 Delivery 则必须在该 Delivery 之后；新 PR 的 base SHA 和 C 第一父提交均等于当前接受的 B。每票恰好一张 PR。真实 C/M 门禁、依赖起点、资源/槽及语义失败不合入断言保持不变。取消或 PR 写入结果未知仍按原协议停止并保留已发生事实；后续修复始终使用该串行集成过程内已创建的同一 PR。

## 独立审查前补充的并行停止边界

`parallel-unknown-retains-cleanup` 在真实两个实现会话重叠时，让 A 的 Ticket push 实际成功后 CLI 返回失败，且 pi 进程内该精确 ref 的 ls-remote 回读也明确不可用（外部验收独立读真实 ref），B 的模型响应尚未完成。必须先冻结普通派工并取消 B，B 的 cleanup 仍由同一活动池允许。事件屏障在 cleanup 未结束时检查资源未提前释放、竞争 controller 无法取得仓库。释放屏障后，真实 cleanup 命令先运行，再由可控故障重新留下合成资源并返回失败；B 资源必须 retained，首个 remote unknown 不能被后续 cleanup/cancel 覆盖。断言只有 feature 与 A Ticket 两次 push、没有 PR/merge/close、A 远端实际 SHA 保留、B 无远端分支、Spec/Tickets open、main 不变。该新增场景补的是并行冻结与清理的实际组合缺口，不是实现镜像单测；固定 HTTP 与失败注入均显式披露。

## 实际失败后的夹具与只读诊断修正（修改前）

86a 的 unknown 场景未成功建立故障前提，A 被产品按真实远端结果合法交付，B 固定模型仍在等取消 cleanup；原测试最终失败，不能追认通过。精确 ref 的 controller-only 读回阻断应在 A 实际 push spawn 前同步 arm，不能依赖 wrapper 完成独立读回并输出 marker 才生效。wrapper 仍须执行真实 push、独立精确读回和 observer 确认，缺一不得生成 applied 证据。前提失败用无原始诊断的阶段枚举通知 harness；unknown 场景的意外 A Delivery、flow 终态或有限测试等待上限均应结束等待并让现有 teardown 关闭本场 pi。所有计时器在成功、失败和 close 清理，原有远端、资源、并发、ownership 和零额外写入断言不变。

同一冻结源的数次 fresh 场景在不同阶段出现 GitHub EOF；已确认的只有安全 FailureDetail，不能推断路由根因。新增透明观察只记录批准合成仓库的实际只读 gh api 请求：公开路径（不含 query）、受限 GraphQL 操作标签、顺序、最后一个受控阶段以及启动/退出结果。既不改变请求/响应/重试，也不记录 headers、原始 stderr、认证、正文或任意私有路径。失败工件保存这组安全记录以定位下一次实际失败，历史报告原字节和源 SHA 不改。仅测试变动的验收组合须明确每个原始 tested SHA，并证明产品源码/配置/依赖字节相同，不将旧报告伪标新 SHA。
