# 精确远端结果核对

Issue #11。副作用调用一次后发生失败，不代表远端没有写入。本模块只利用 Git ref、精确 PR/Issue 身份、原生父子关联和真实工件确认事实；不增加 flow、attempt 或 operation 账本，也不封装通用写重试。

`remote-git` 负责精确 ref 查询与 expected-old-SHA 更新。创建使用空旧 ref 的 lease；更新必须证明旧 SHA 是新 SHA 的祖先并使用该旧 SHA 的 lease。预读取一致不代替原子 lease；未知响应后只读同一 ref，确认等于目标 SHA 才复用。空 ref、404、旧 SHA 或读取失败都不能证明上次未写入。只有实际本地命令未启动或准备阶段尚未发出调用，才标记 `REMOTE_NOT_SENT`；重新执行前仍由调用者重新核对批准前提。

`Remote` 每个方法负责一种业务结果：PR 创建绑定 head/base/H、内容、Draft 和原作者；评论绑定精确 discussion、完整内容、作者及写前不存在的新 ID；ready 绑定当前 PR 版本；merge 只读回真实 M，并交回集成层先记录已合入事实再核对父树、ref 和 M 门禁；关闭绑定精确 Issue 内容与 completed 结论。读取不到不自动重放。取消后已发送操作继续核对，调用者仍必须检查取消，不能因确认事实获得下一步执行资格。进程未收敛、孤儿进程及本地请求清理失败不得被核对吞掉。

派生 Issue 的创建与原生关联不是事务。返回 ID 后可以按该 ID 及父子双方原生关联核对；创建丢失 ID 且未关联时停止，保留可能已创建的 Issue，不按标题或正文查找近似对象。已知 ID 而后续读取或关联失败，报告保留该公开 ID；后续恢复以此现有 Issue 事实为依据。

工件合同可以可选声明 `artifacts.locator={kind:"github-release",tagPrefix,assetName}`。报告原始 JSON 字节的 SHA256 决定 `<tagPrefix>-<hash>`，assetName 同时决定 FLOW_REPORT 的文件名。批准的 publisher 承诺在此位置发布实际报告且按合同期限保留；GitHub 没有服务器 TTL，这是一项明确的项目保留承诺。丢响应后，验证实际 release、唯一已上传 asset、实际 Git tag（包括解引用 annotated tags）对应 codeSha、原始下载字节 SHA256 和下载前后 tag 不变。缺失或部分资产仍 unknown，错误字节/版本拒绝；不自动补传、覆盖或换用其它报告。旧合同成功响应路径保持原校验，无 locator 的丢响应仍停止。

核对不吞并项目契约、范围或源码漂移失败。发布过程中改变源码，即使资产正确也不能继续。安全诊断只传递分类字段，不公开原始 stderr、请求负载、私有路径或认证信息。

验证边界与运行方式见 [T9B 场景](../testing/t9b-scenarios.md)。真实正常流程使用 OpenAI；丢响应发生在真实 CLI 成功后。派生 Issue 场景通过真实 pi 测试入口调用同一个生产适配器，后续自动修复/同步完整流程另行验收。

官方原生关联接口：[GitHub REST sub-issues](https://docs.github.com/en/rest/issues/sub-issues?apiVersion=2022-11-28)。GitHub 不提供这些不同业务对象间的跨请求事务，因此此设计不承诺网络请求恰好一次。
