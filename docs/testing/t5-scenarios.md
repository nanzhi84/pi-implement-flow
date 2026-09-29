# #6 同 Ticket 修复：实现前的失败边界和 E2E

本约定先于实施编写，不能作为通过记录。真实入口是 pi `/flow start SPEC`；使用独立、显式允许的合成仓库 `nanzhi84/pi-implement-flow-repair-acceptance`。初始 main、既有 Issues/PR、认证配置不被改动，每次场景使用新的原生 Spec/Ticket 和独立分支/资源。

| 外部失败边界 | 必须观察到的行为 |
| --- | --- |
| 验收实际执行后以严格、版本匹配的行为报告失败 | 同一 C 上完成独立只读 review，准确记录失败/未运行命令；cleanup、完整失败工件发布和原始字节核验后才进入修复 |
| 普通非零、基础设施、无效报告、未停止进程 | 不派修复角色、不把它们当代码缺陷；复用 #10 的真实分类证据 |
| 修复的准备、cleanup、发布或评论失败/未知 | 保留原缺陷与现场，更高优先级停止；不继续 Agent、不重复副作用 |
| 每次新代码或候选基线 | 获取新的真实 C，重新检查/accept/review；旧通过/失败工件不能批准新版本 |
| 一项项真实解决缺陷 | 不设修复次数/总时限/预占预算，不存 attempt ledger；五次及以后的可验证进展仍继续 |
| 无差异或无关代码噪声 | 不空提交；新 tree、SHA、URL、模型“已改善”不算进展；相同失败没有已验证解决时保留成果并暂停 |
| 断言消失、旧通过退化、review 缺陷被重新措辞 | 不算进展；完整断言 IDs 与稳定旧 blocker 引用仍须逐项核对，不降低门禁 |
| 最新已接受 B 与 H 有文本冲突 | 控制器准备可独立重算的 merge tree/stages；Agent 仅解决获准代码，完成 [H,B] 提交且追加到同一 open PR |
| 无文本冲突但组合语义错误 | 最新 C 的真实 CLI 揭示失败，同票修复后再次完整验证；不凭旧起点通过放行 |
| 冲突需要新业务选择 | 修改前提出具体问题，保留原 PR/源码/失败依据，相关 Ticket blocked，不擅自选 ours/theirs |
| 旧 H 到新 H 的证据链 | 单 parent Agent 编辑与 controller merge 分段；每段完整路径/原始 blob/mode 覆盖，不把上游变化伪写成工具事件 |
| 已合入的 M 未通过 | 保留 integrated-unaccepted，不向已 merged PR 追加冒充修复；后继修复票/整体循环留给后续能力 |
| 外部修改 PR/head/feature，或条件 push 不确定 | 不 force 覆盖、不另开 PR、不盲重发；保留事实并安全停止 |

## 最小场景

1. `real-repair`：用明确标注的初始缺陷输入保证到达修复边界，真实 OpenAI `gpt-6-astra` 执行修复和独立审查，最终从远端 M 运行真实业务行为。初始缺陷输入不是 OpenAI 质量证据，修复/审查模型来源独立记录。
2. `progressive-five`：固定真实 SDK 工具初始留下五个真实 CLI 缺陷，每次只解决一个，批准的完整断言集始终保留。至少五次修复后交付；检查同一 PR、每轮实际版本及下载工件、失败集合的真实变化。
3. `no-progress-no-diff`：固定修复重放原文件，保留失败工件后 no-progress；没有空提交、第二 PR 或继续派工。
4. `no-progress-noise`：修复只加无关注释，新 tree 仍产生同一失败集，独立 review 不认可解决；停止且保留真实新提交，不用代码噪声延长循环。
5. `conflict-repair`：同 Spec 的 A/B 真实修改同文件，A 先交付；B 在最新 B 上经历文本冲突和随后可执行的组合语义失败，在同一个 B PR 追加修复，最终通过。独立重算准备 tree、conflict stages、所有编辑段与实际 C/M，不调用产品 verifier 证明自己。
6. `repair-needs-decision`：已有 PR 和失败证据后，修复角色明确返回 unresolved requirement 问题且不编辑；Ticket open、原 PR/head 保留，问题链接可读。

固定 HTTP 响应仅控制缺陷/每次写入，真实 SDK 工具、项目命令、GitHub PR/merge/评论/Issues 与证据下载均真实执行。测试不得根据“第 N 轮”伪造 passed；断言结果必须来自实际 CLI。失败未到目标边界不能计通过。各场景最终 Node exit/信号、源码初末 SHA/dirty/fingerprint、host/local SDK、实际模型、仓库基线、外部断言与工件链接均写脱敏报告。

共享执行 helper 对唯一仓库的 allowlist 扩展来自 #10，不复制进程/parser。没有单元测试、凭据复制、原始会话公开或源码边改边验。最终冻结提交后运行；保留失败现场及原始报告。

7. `review-progress`：先由确定性独立审查指出两个真实可见 stderr 契约缺陷；两次真实代码修复分别补齐诊断和调用提示。每次 review 逐项绑定旧引用与当前原始 blob。外部验收从最终 M 再执行 CLI，检查完整诊断输出、历史 failure 报告和同一 PR；改措辞或遗漏旧阻断不能算解决。

文本冲突可能出现在项目 prepare/cleanup 脚本本身，导致冲突树不能执行。修复资源生命周期必须从精确 H 的独立只读工作树执行获准 prepare/cleanup，使用同一明确资源目录；controller 在 prepare 后才物化冲突树，Agent 在该树修复。cleanup 不能依赖尚未解决的脚本或因此吞错。最终 C/M 仍执行其自身完整项目命令，不能用 H 的生命周期结果代替新版本门禁。
