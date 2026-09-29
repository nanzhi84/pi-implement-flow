# Ticket 门禁与串行集成协议

状态：对应 Issue #4（T3）的实施协议。源码已实现；实际验收以绑定提交的报告为准，本文不是通过记录。

## 目标与边界

Ticket 通过真实项目检查、行为验收、独立审查及可核验远端工件后，才进入功能分支；实际集成版本确认完成前，不关闭 Ticket 或释放下游。总 PR 始终保持 Draft，父 Spec 保持打开，flow 不合并 main。

首版只支持 GitHub 的 `merge` 提交策略。拒绝 squash、rebase、merge queue 及无法核验的保护规则，不使用管理员绕过。内部独立 review 不代替 GitHub 原生 required review；支持受保护仓库的成功路径，必须另行具备并验收其原生身份与检查条件。当前无法满足的规则安全拒绝，不能宣称已支持。

功能分支由同一个本机控制器独占维护，开发成果以 Ticket PR 为入口。外部写入不在支持范围：发现后停止、保存现场并报告，不自动接纳、覆盖或修复。这个约束不是远端写入隔离承诺。

## 版本与证据

- H：获准集成的 Ticket PR head。
- B：本次候选的功能分支基线。
- C：基于 B 与 H 构造并实际验收的候选 merge commit，父提交顺序必须为 `[B, H]`。
- M：GitHub 实际产生、经远端事实核对的 merge commit。

门禁证据绑定 Ticket/Spec、门禁类型、相应 H/B/C/M、有效需求摘要、契约与指令摘要、实际命令、环境与数据前提、行为断言、独立审查来源、生成来源、内容摘要及保留要求。启动 probe 不是 Ticket gate；模型文字声明不是执行结果或批准凭证。发布后下载并校验工件实际字节，历史证据保留但不能自动放行新版本。

`approvedContext` 保存控制器确认时的 Spec/Ticket 标题、正文、依赖、批准变更（当前为空）、规范化合同和所选项目指令的可读原文；不会让模型编写范围摘要，也不从 C/M 重新推断批准。每个文本附原始 UTF-8 SHA256；已知凭据、认证/带参数 URL、私有路径和邮箱以明确的 redaction 类型/次数遮盖，严格匹配的公开 GitHub 评论引用保留。被遮盖原文不进入可读文本或 metadata；原始摘要仅用于关联，不是机密保护，也不能证明任意或编码秘密都已发现。该过滤只处理新增批准上下文，不宣称整个工件可自动完整脱敏。单文本上限 128 KiB、完整序列化上下文上限 512 KiB、指令文件最多 64 个；超限在 gate 项目命令和发布前拒绝，不截断遗漏需求。真正敏感信息仍不得写入批准源或工件。

review 使用独立于实现者的上下文和只读工具，审查 Spec、代码及验收命令/断言/覆盖的变化。正确性、安全及明确规范缺陷阻断，并给出依据、影响和可验证解决条件；普通风格建议不阻断。不得通过弱化验收获取通过。

若项目要求先新增断言再实施，控制器向 review 提供本次受控 write/edit 实际成功写入的相对路径、顺序及前后字节摘要。记录在工具收敛后冻结，逐路径核对实施基线→变更链→H，并标明哪些历史版本仍与 C/M 中实际内容一致。只写过测试文件名不构成证明；review 必须核对实际断言语义及其最终版本出现时机。无变化写入不计入；写入或摘要核对不完整时停止。此证据有容量边界，随门禁报告保留，不是执行账本，不用于接续进度，也不宣称完整操作系统审计或红色测试执行记录。

## 最小集成协议

同一串行集成控制权覆盖以下全过程。远端结果未知时保留控制权并停止；不以释放锁或开始下一票掩盖未知结果。

1. 固定 PR 身份、H、B、有效需求及契约/指令，确认本次执行仍有效。
2. 读取 PR 的真实 `merge_commit_sha` 为 C，fetch 精确对象并核对有序父提交 `[B,H]`。不用可变 FETCH_HEAD 或未发布的本地对象代替 C；候选冲突、过期或不可核验时停止。T3 尚无后续自动修复能力。
3. 在干净、隔离的 C worktree 运行 prepare/check/accept/cleanup，验证命令前后代码与 HEAD 未漂移；执行独立 review，发布并下载验证 C 工件。
4. 合并前重新读取 H、B、需求、契约及仓库保护要求。任何变化均撤销旧证据的合入资格，不以无文本冲突作为放行依据。
5. T2 创建的是 Draft Ticket PR，必须通过独立的 ready 操作并核对结果后才能请求合并。这不改变总 PR 的 Draft 状态。每次新写入前检查取消/执行资格；已经发出的操作继续核对事实。
6. 使用明确的 `merge_method=merge` 和 `sha=H` 请求合并。副作用失败或结果未知不得盲目重试。
7. 核对 PR 实际 merged、响应及 PR 的 merge SHA 为 M、远端 feature 为 M、`parents(M)=[B,H]`、`tree(M)=tree(C)`。合并后的 PR `base.sha` 不作为历史 B 的凭据；B 由既有证据及 M 的第一 parent 核对。
8. M 与 C 不同时，在实际 M 上重新执行完整项目门禁及独立 review，发布并下载验证绑定 M 的新工件。tree 相同不是依赖 commit identity 的验收证明，不把 C 的批准改写为 M 的批准。
9. 首次确认实际集成差异后创建或核对 Draft 总 PR；在 M 门禁之前创建也不授予完成资格。再次核对 feature、需求、实际 PR 及 Draft 总 PR，写入关联 Ticket PR 和 C/M 工件的交付索引。
10. 显式关闭 Ticket 是最后一个业务写操作。关票响应及读回、随后 feature/范围复核全部完成才标记交付、解锁下游；Draft 创建不是完成，失败路径不得把总 PR 转 ready。

## 无法由本协议消除的竞态

GitHub merge API 的 `sha` 条件只约束 PR head，不提供 expected-base 条件。相邻读取 B/H 与 merge 请求不能组成跨远端 CAS。即使最后读取 B 正常，外部也可能先把功能分支改为 B′，随后 GitHub 合入一个基于 B′ 的 M。双 parent 检查只能事后发现，不能宣称阻止了该 merge。

此时必须明确报告 `integrated-unaccepted`：远端已经发生合入，但该结果未获验收。保持 Ticket open、不释放下游、不继续集成、不重新 merge、不强推回滚。实际 M 重验失败、证据缺失或需求变化也采用这一事实区分；T3 可以安全停止等待后续修复能力，不能显示成“尚未合入”或“已完成”。所有阶段保留已发生的 Git/GitHub 事实，聊天及会话变化不会回滚它们。

GitHub 不提供跨 feature、需求和 Issue 关闭的事务。关票后的复核发现漂移时，必须保留 `closed-unaccepted` 事实，不宣称 Ticket 仍 open，不自动重开或释放下游。只允许本控制器已确认的关票改变批准范围中的生命周期状态；外部关票、重开或关闭父 Spec 都需停止核对。

GitHub 测试 merge ref 可能滞后。若使用它获取 C，必须重新读取 PR 并核对 C 的实际父提交；不能把 ref 名字或 `mergeable=true` 当成当前 H/B 的门禁证据。候选与实际 merge SHA 不同是预期情况，不默认相等。

## 实施与验证约束

复用现有工作空间、命令进程、独立角色和远端副作用边界，不引入执行/尝试/预算账本。Issues、PR、Git 提交和交付工件保留需求与交付事实；运行期串行控制状态可以丢失。自动接续核对与修复属于后续 Tickets，未实现时停止而不是绕过门禁。

实现前的外部行为断言见 [T3 场景](../testing/t3-scenarios.md)。文档、源码审查、构建和 HTTP 成功不能替代真实 pi 用户路径验收。

官方接口依据：

- [Merge a pull request](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)：head SHA 条件及合并策略。
- [Get a pull request](https://docs.github.com/en/rest/pulls/pulls#get-a-pull-request)：测试 merge commit 与实际 merge SHA 的不同含义。
- [Git database guide](https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database)：merge refs 的新鲜度限制。
