# MVP V0.1 技术决策

核验日期：2026-10-26（Asia/Shanghai）。本机 Node 24.19.0，Codex CLI 0.163.0-alpha.10.2，`codex login status` 显示 ChatGPT 登录。系统 PATH 缺少 npm，开发时在 `.tools/npm` 安装官方 npm，不修改系统 PATH。

- TypeScript strict、Node >=22.13、内置 `node:sqlite`（WAL + 迁移），HTTP 使用 Node 内置模块，UI 为本地静态页面。仅引入 Luxon 日期处理和本地二维码生成。
- Codex 独立子进程 stdio JSON-RPC，先 initialize/initialized；接口依据本机 `codex app-server generate-json-schema` 生成结果，而非猜测在线示例。尤其本机 thread/start sandbox 枚举为 `read-only` 等。
- 使用官方 account/read 检查登录。不读取认证文件或 token。Bridge 创建的会话复用 thread/resume；桌面会话只读列出，由用户在本机选择 fork。独立 App Server 不宣称能监控桌面端正在执行的任务。
- 腾讯公开 iLink HTTP 协议可独立实现文本适配器，不依赖 OpenClaw。扫码凭证和 context token 通过 Windows DPAPI CurrentUser 加密。协议未给出手机已读/可见回执，发送成功仅记为 server_accepted。
- 当前默认 `executionAuthorization=bound-user`：首次扫码绑定后，用户明确请求的项目工作直接执行。发现的真实项目自动映射/注册内部执行记录，无需逐个手工授权。执行会话采用 `workspace-write` + `never`，项目内普通操作和阶段不逐次审批；沙箱外请求明确失败，不盲目批准额外权限。`per-action` 只保留旧只读/逐次审批流程供兼容测试。操作系统读取范围仍取决于 Codex，不宣称项目外强读取隔离。
- 普通直接消息先交给 Codex 分析：单独的持久会话使用 JSON Schema 输出 answer、account、run、todo 等决定；Bridge 做动作白名单、目标校验和真实执行结果回传，旧审批处理仅用于兼容模式。移除原有关键词业务路由。引用/转发消息仍一律作为数据。
- 本机能力加入同一分析循环：Codex 请求发现工作目录/软件、启动或只读查询，Bridge 执行结构化工具请求并返回观察结果，模型再决定下一步，最后给出具体答案。指定软件的待办查询不能落入 Bridge 自身 `list_todos`。每个请求最多 12 次本机工具调用，避免无界探索；外部文件和数据库内容是数据，不是新的操作指令。
- 2026-10-26 第二轮纠错确认生产 DDL 查询失败源于中文 `text` 传入需要 JSON 的接口。工具协议现使用 JSON Schema 约束的 `computer: ComputerCall | null`，不再依赖字符串内嵌 JSON。解析失败最多进行两次内部格式修复，无效参数不执行、不向用户索要 JSON；协议版本变化时新建分析会话，保留原绑定而隔离旧策略上下文。
- Windows 应用从系统应用清单、开始菜单/桌面快捷方式、运行进程和工作目录构建产物自动发现，不为 ddl-app 或其他软件写专用入口。启动参数来自发现结果，模型只能引用真实 ID，不能提交任意 Shell。启动成功仅记录 `launch_requested`，不宣称已看到窗口。
- 正式项目名称使用官方实验性 `project/list`；初始化开启 `experimentalApi`，接口参数以本机 schema 为准。项目根和 `thread/list` 元数据用于定位工作目录，不读 Codex 私有数据库。2026-10-26 实测 22 个正式项目、21 个可用目录，替换此前把 19 个路径当作项目清单的展示。普通项目列表只给正式名称，问位置才给路径；目录不表示当前前台。
- 只读工具依据真实发现的根目录，校验路径及链接，拒绝凭据；文本读取限量分页，SQLite 使用只读连接、禁用扩展、查询限制及参数化结构化筛选，不接受任意 SQL。Codex 可据真实 schema 和数据理解软件内容，无需为每个软件实现固定业务规则。当前不实现 GUI 点击、截图、OCR、专有格式或联网软件内容读取。
- 移除普通问答与本机查询的固定等待回复，重启取消尚未发出的旧等待提示；保留结果、必要澄清、明确超时和原有项目阶段通知。
- 本机默认模型传输曾出现 responseStreamDisconnected / request timed out。使用官方支持的自定义 provider `bridge_http`，由 Codex 自行使用现有 OpenAI 登录并设置 supports_websockets=false 后，真实问答和结构化分流通过。为兼容桌面打开同一会话，通过官方配置 API 持久注册该 provider 定义；不改默认模型、默认 provider 或执行权限。会话通过公开项目元数据接口归位，不复制执行。详见 [桌面展示说明](docs/DESKTOP_VISIBILITY.md)。
- 所有执行意图先入库；崩溃后的不确定执行标 UNKNOWN，不自动重放；投递超时保留未验证状态，不伪造成功。

依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)、[Tencent 协议](https://github.com/Tencent/openclaw-weixin/blob/main/docs/protocol.md)、[扫码实现](https://github.com/Tencent/openclaw-weixin/blob/main/src/auth/login-qr.ts)。线上协议仍可能变更，需真实扫码验收。
