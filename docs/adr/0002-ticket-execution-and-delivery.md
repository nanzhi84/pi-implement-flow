# Ticket 执行与交付边界

T2 消费 T1 已确认的完整规划与命令契约。编排器从明确的功能分支基线创建独立 Ticket worktree，向独立 SDK 会话提供 Spec、Ticket、依赖成果、问题/决策和显式项目指令。角色只产生代码或问题；代码、Git 与远端事实由编排器核对。角色的文字声明不是验收凭证。

实现工具将文件访问限定在当前 worktree，拒绝 `.git` 和逃逸路径；命令工具只运行已批准契约中的命令，不向角色开放任意 shell、GitHub 或 Git 写操作。它是受支持工具接口的约束，不是 OS/凭据沙箱：可信项目命令仍以用户身份执行。

编排器独占创建功能分支、提交 Ticket、推送与创建 PR。功能分支与 Ticket 分支使用不同 ref 前缀以避免 Git ref 文件/目录冲突。首次功能分支与 main 出现真实差异时才创建 Draft 总 PR。没有差异或存在歧义时不制造空提交。

T2 交付 Ticket PR 后安全暂停，等待 T3 门禁；不得关闭 Ticket 或合入 PR。用户可用 `/flow preflight` 单独检查并确认原 T1 预检，而 `/flow start` 推进到当前已交付能力边界。未知远端副作用保留现场并停止；T9B 将在原生 PR/分支/提交/交付证据上补齐接续核对，不创建执行账本。

验收从真实 pi RPC 入口操作隔离合成 GitHub 项目。真实模型路径与固定模型/故障注入路径分别报告；后者不能证明模型质量。实现前的可观察失败清单见 `docs/testing/t2-scenarios.md` 与 `docs/agents/t2-agent-boundaries.md`。
