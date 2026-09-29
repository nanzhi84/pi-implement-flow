# T9B 远端结果核对：实施前的外部失败边界

Issue #11。本文件先于实现列出失败方式；它不是通过记录。正式验收使用真实 pi RPC、Git/gh、隔离合成 GitHub 仓库、实际项目命令和下载资产。正常实现及独立审查使用 `openai/gpt-6-astra`，确定性故障在实际 CLI 的返回边界注入；不得把模拟响应当作远端成功。

1. **已应用但响应丢失**：实际 feature/Ticket push、Ticket/总 PR create、ready、merge、delivery comment、Ticket close 及 publisher 完成后丢弃成功响应。每个精确目标只发送一次；只读核对后继续。最终 PR/M/parents/tree/实际 CLI、C/M 工件、关票、总 Draft、父 open、main 不变均须核验。
2. **明确未发送**：在目标 Git push 的本地 spawn 之前产生真实启动失败。无远端 ref、无实现 Agent、无额外写入。仅 runner 的 `commandStart=not-started` 能证明本地调用未开始，不能从 404、空列表或一般错误推断。报告允许修正环境后重新核对前提，不自动套重试循环。
3. **创建成功但核对不可用**：实际 Ticket PR 创建后丢响应，再让本次控制器的精确读取失败。独立读取证明 PR 只有一个；控制器保持 unknown、无 merge/close，不重复 create，不凭标题猜测。
4. **合并成功但核对不可用**：实际 merge 后丢响应，查询不可用。保留已发生的 GitHub 事实，不能称从未合入；Ticket 仍 open、无下游释放、无第二次 merge。
5. **部分发布**：已知内容寻址 tag 创建成功但资产缺失。只读查询不能证明 publication 完成，不再运行 publisher、不补传或覆盖资产。
6. **错误资产**：精确 locator 可读但实际原始字节摘要不符；注入等长、JSON 语义相同的不同原始字节，不能仅靠 metadata 长度拒绝。拒绝资格；不以 URL、release 元数据、等价解码文本或其它版本报告替代。
7. **派生 Issue 与关联**：真实 create 返回 ID 后关联请求成功但响应丢失，按精确 Issue ID 与父原生关联复用。create 自身失去 ID 且未关联时，事实不足则停止，不按标题/正文近似查找、重复开票或增加 operation 账本。此边界在真实 pi 中调用同一个远端适配器；自动派生工作的完整用户流程由后续同步/修复 Ticket 验收。
8. **不弱化旧边界**：现有无 locator 合同成功响应仍校验 URL/hash/保留承诺与原始字节；无 locator 丢响应仍 unknown。PROCESS_UNQUIESCED 优先，不发核对以外的新动作；取消后已发送的动作仍核对，但不获得下一步执行资格。
9. **发布完成但源代码漂移**：真实 publisher 成功后修改 probe 源码。即使精确远端工件可读且摘要正确，也必须保留 `PROBE_CHANGED_CODE`，不可被副作用核对吞掉或继续派工。

原 `push-unknown` 回归在成功 push 丢响应后，同时令控制器的该精确 ref 读回不可用；外部验收仍直接读取真实 GitHub ref。这样验证的是未解的远端事实，成功读回后的继续路径由本票第一条覆盖。

10. **错误 tag 版本**：实际报告资产字节正确，但真实 Git tag 指向固定的另一个合成基线；拒绝资格，不能只信 release target_commitish 或报告内部 codeSha。

11. **关联期间范围漂移**：已知新建 Issue 的原生关联真实成功后，外部关闭该子票，再丢弃关联响应。核对必须发现已变化的 child 状态，不返回过时的成功对象，不重复关联或开票。
12. **未知写后的孤儿读取**：实际 PR 创建成功丢响应，随后精确 PR 列表查询真实完成但留下同组子进程。进程边界收敛后仍停止，保留远端未知状态与所有权，不因查询正文可解析或再次查询而继续。

13. **写成功但读命令未启动**：实际 feature push 成功返回后，精确 ref 核对的本地命令启动失败。这个 not-started 只属于读取，不得误报写未发送；仍保留 unknown 所有权、实际分支且不派工。

每次报告写在最终 Node 子进程退出和 teardown 之后，记录 clean 源码 SHA/内容摘要、Node/pi/SDK/模型、选定场景、实际退出值、远端对象/证据摘要及断言。失败报告和私有现场保留；公开工件不含认证、原始诊断或本机路径。按相同 source SHA 精确补验，不能把失败 runner 改写为成功。复用已有 C/M 版本和原始字节行为断言，不增加实现结构单测。

不提供 `retryWrite(fn)`；核对只返回事实。任何下一次写入仍由原业务调用者检查当前取消、范围、版本与保护约束。没有 flow/attempt/operation 日志或恢复计数。

## 重复执行

独占合成仓库 `nanzhi84/pi-implement-flow-reconciliation-acceptance`，main 固定 `afaa997f3859680d01ea8e88fd0344803f8b398a`；已批准 exact locator。使用可访问该仓库的 gh 和可用 OpenAI 配置的真实 pi：

```sh
PI_BIN="$HOME/.npm-global/bin/pi" PI_PROVIDER=openai PI_MODEL=gpt-6-astra \
RUN_GITHUB_E2E=1 FLOW_ACCEPTANCE_REPOSITORY=nanzhi84/pi-implement-flow-reconciliation-acceptance \
NO_PROXY=127.0.0.1,localhost no_proxy=127.0.0.1,localhost \
GODEBUG=http2client=0 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=http.version GIT_CONFIG_VALUE_0=HTTP/1.1 \
npm run test:reconciliation
```

`FLOW_RECONCILIATION_SCENARIO` 可选择测试文件列出的一个精确场景。HTTP/1.1 与 loopback bypass 是记录的验收环境设置，不是已证明的网络修复。报告位于 `artifacts/reconciliation-runs/`，包含最终测试进程退出结果；只有源码内容与 SHA 未变、源树干净、所有选择行完整通过才可发布为验收通过。
