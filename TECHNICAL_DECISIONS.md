# MVP V0.1 技术决策

核验日期：2026-10-25（Asia/Shanghai）。本机 Node 24.19.0，Codex CLI 0.163.0-alpha.10.2，`codex login status` 显示 ChatGPT 登录。系统 PATH 缺少 npm，开发时在 `.tools/npm` 安装官方 npm，不修改系统 PATH。

- TypeScript strict、Node >=22.13、内置 `node:sqlite`（WAL + 迁移），HTTP 使用 Node 内置模块，UI 为本地静态页面。仅引入 Luxon 日期处理和本地二维码生成。
- Codex 独立子进程 stdio JSON-RPC，先 initialize/initialized；接口依据本机 `codex app-server generate-json-schema` 生成结果，而非猜测在线示例。尤其本机 thread/start sandbox 枚举为 `read-only` 等。
- 使用官方 account/read 检查登录。不读取认证文件或 token。Bridge 创建的会话复用 thread/resume；桌面会话只读列出，由用户在本机选择 fork。独立 App Server 不宣称能监控桌面端正在执行的任务。
- 腾讯公开 iLink HTTP 协议可独立实现文本适配器，不依赖 OpenClaw。扫码凭证和 context token 通过 Windows DPAPI CurrentUser 加密。协议未给出手机已读/可见回执，发送成功仅记为 server_accepted。
- 安全默认使用 Codex read-only 沙箱 + untrusted 审批。自动模式仅影响已明确授权的低风险阶段，不能自动批准工具。拒绝远程沙箱外命令和额外权限提升；文件修改需明确的一次审批。操作系统沙箱的读取范围取决于 Codex，MVP 不宣称具备项目目录以外的强读取隔离。
- 任意普通消息仅进入待办收集；远程执行必须是明确命令或限定自然语言操作。引用/转发消息一律作为数据。
- 所有执行意图先入库；崩溃后的不确定执行标 UNKNOWN，不自动重放；投递超时保留未验证状态，不伪造成功。

依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Tencent 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)、[扫码实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)。线上协议仍可能变更，需真实扫码验收。
