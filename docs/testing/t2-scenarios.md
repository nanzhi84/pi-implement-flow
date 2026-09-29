# T2 外部行为验收约定（实现前）

## 范围与数据边界

通过真实 pi RPC 的 `/flow start SPEC` 入口执行一张无依赖 Ticket。成功仅表示 Ticket PR 已提交、停在 `gates-not-installed`；不代表评审、合并或最终 Spec 交付。使用 `nanzhi84/pi-implement-flow-acceptance` 的合成 greeting 项目，在每次运行创建新的 Spec 与 native 子 Ticket，不改已有 Issue、已有分支、远端 main。模型仅取得本次 Ticket 的受控工作空间工具。测试 runner 用 Git/gh 独立核对外部事实。

## 失败方式与边界条件

1. **真实实现成功**：模型将只含空白的姓名拒绝为退出码 2；既有 `Ada` 输出仍为 `Hello, Ada!`，缺少姓名仍为退出码 2。必须通过远端 Ticket PR 的 SHA 获取代码并运行 CLI 验证，检查 feature 基线、PR base/head、Issue 仍 open、PR 未 merge、主分支未改变。模型自报成功不算通过。
2. **修改前歧义**：需求故意保留两个互斥的产品选择并要求先提问。必须在 Ticket 留下可见问题、停止该票，代码与基线无差异，无 Ticket PR、无空提交、Issue 仍 open。
3. **无差异返回与工具范围**：固定传输先请求 git/gh shell、`../` 写入、`.git` 读取及指向工作空间外的 symlink 读取；按实际合同，未授权工具必须不可用，已授权读写必须拒绝逃逸。外部合成 sentinel 必须不变。随后模型返回已实现但未产生文件改动。必须停止，不为空 PR 制造提交；没有远端 Ticket PR，没有新增代码提交，Issue 仍 open。
4. **会话取消与迟到返回**：在 Agent 请求已经到达的可观察时机触发真实 pi `new_session`，随后让测试专用传输返回先前成功结果。旧任务不得 push/创建 PR/关闭 Issue；工作空间保留供核对，控制权只在安全停止后释放。

成功路径必须使用配置的真实模型。确定性无差异和取消场景允许仅替换本机模型 HTTP 传输，仍走真实 pi、SDK、GitHub 和控制器；报告逐项标记该边界，不能声称它证明真实模型质量。

## 可重复命令及前提

- Node 24+、pi 0.87.1、Git、已认证 gh；对 acceptance 仓库具有建立 Issue/native 子 Issue/独立分支/PR/Release evidence 的权限。
- acceptance 的远端 main 为既有 greeting fixture；`.pi/flow.json` 和原 T1 probes 保持有效。
- 成功模型使用 `PI_PROVIDER`、`PI_MODEL`（默认 `openai-codex`、`gpt-6-astra`）；从 `FLOW_TEST_AGENT_DIR` 或 `~/.pi/agent` 只显式引用 auth/models 配置，不复制凭据进工件。
- `RUN_GITHUB_E2E=1 npm run test:execution`。可选 `FLOW_EXECUTION_SCENARIO` 仅选择一个场景以诊断失败；报告必须注明选择范围。
- 每次生成 `artifacts/execution.json`：开发仓库 SHA/dirty、runner 最终退出结果、环境、断言结果、创建的 Issue/PR URL、验证过的远端 SHA；不包含 token、模型原始对话、个人路径、原始 stderr。
- 成功临时 clone 可清理；失败临时目录保留并通过本地私有定位文件记录，公开报告不含个人路径。远端合成资产保留为可核对证据，不自动合并、关闭或删除。
