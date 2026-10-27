# 鲁滨逊 V0.3.0 配置说明

微信会话在 Codex 左侧按项目展示。HTTP 传输需要在用户配置中注册 `bridge_http` 定义，修复脚本和现有会话迁移见 [桌面展示说明](docs/DESKTOP_VISIBILITY.md)。

V0.3.0 的便携版入口为 `release/鲁滨逊/鲁滨逊.exe`，分发文件为 `release/鲁滨逊-Windows-x64.zip`。完整解压后使用，保留 EXE、`runtime` 和 `app` 的相对位置。包内自带 Node，仍依赖本机已安装的 Codex 和 Edge/Chrome。源码入口继续支持 `npm run app` / `Robinson.cmd` 及服务脚本。

AI 登录在 App 内发起，密码和 token 由官方 Codex 处理，不增加密钥配置项。`user_profiles` / `user_memories` 保存当前绑定用户的偏好与记忆；`inference_records` 保存不含消息正文和凭据的调用证据。账号查询、登录进度在内存中处理，不保存授权 URL。详见 [ROBINSON.md](docs/ROBINSON.md)。

便携版配置保存在 `%LOCALAPPDATA%\Robinson\config.json`，不写入发行目录。首次同机启动若发现附近原源码配置，会把实际数据目录指向原位置，继续使用已有微信绑定；新机器默认数据目录为 `%LOCALAPPDATA%\Robinson\data`。此流程不复制凭据，ZIP 中也不包含用户配置、数据库或账号数据。移动到另一台机器或换 Windows 用户后，仍需完成该环境自己的登录与扫码。

源码安装从 `config.example.json` 生成项目内的 `config.local.json`。本地配置、数据库、日志、凭证与开发工具均被 `.gitignore` 排除。UI 可修改的策略保存到实际数据库的 `application_settings.preferences`，优先于文件中的相同策略。

| 配置 | 默认值 | 说明 |
|---|---|---|
| port | 3210 | 本机 HTTP 端口，始终绑定 127.0.0.1 |
| dataDir | ./data（源码） | SQLite、DPAPI 密文、PID、日志位置；便携版使用原同机数据目录或 `%LOCALAPPDATA%\Robinson\data`，由用户配置记录实际位置 |
| timezone | Asia/Shanghai | IANA 时区，用于解析、显示日期 |
| codexBin | codex | 可配置 `codex.exe` 完整路径；安装脚本自动检测 |
| codexMode / wechatMode | real | real 或 mock，不会因真实连接失败偷偷切换 Mock |
| codexTransport | default | `default` 使用 Codex 默认传输；`chatgpt-http` 由独立 provider 使用原有官方登录并关闭 WebSocket。本机实测默认传输超时，已选 HTTP |
| executionAuthorization | bound-user | 扫码绑定一次后，发现的项目直接执行；项目内 `workspace-write` + `never`，普通操作和后续阶段无需逐次审批。`per-action` 仅兼容旧模式及测试 |
| collectionMinutes | 15 | 转发或 `/collect` 消息整理延迟；普通直接消息即时交给模型 |
| staleMinutes | 10 | 没有任务活动事件多久变 UNKNOWN，0 禁用 |
| timeoutMinutes | 120 | 总运行超时，请求中断，0 禁用 |
| approvalMinutes | 30 | `per-action` 兼容模式中一次审批的有效期 |
| wechatPushEnabled | true | 微信主动推送总开关；关闭后任务/阶段、桌面项目完成及待办提醒等通知不投递，直接问答仍回复，重新开启不补发旧通知 |
| notifyProgress | true | 是否在软件通知记录中保留阶段完成详情；不推送微信 |
| autoContinueLowRisk | false | 仅影响 `per-action` 兼容模式；开启后符合低风险条件的下一阶段自动继续。默认 `bound-user` 的阶段不逐次审批 |

微信新建项目使用 `projectCreationRoot`，默认 `./projects`，限于当前 Bridge 工作目录内的独立子目录。每位用户在其哈希子目录下创建项目，指定目录也必须位于该用户根内。该配置由本地配置文件提供，不扩大既有任务写权限；完整说明见 [微信创建项目](docs/PROJECT_CREATION.md)。

环境变量用于启动位置与开发模式覆盖，不放账号凭证：

- `BRIDGE_CONFIG`：配置文件路径。
- `BRIDGE_DATA_DIR`：覆盖数据目录。
- `BRIDGE_CODEX_BIN`：覆盖官方 CLI 路径。
- `BRIDGE_PORT`：覆盖端口。
- `BRIDGE_MOCK=1`：启用两个 Mock 适配器。`start.ps1 -Mock` 另外隔离数据目录。
- `ROBINSON_PACKAGED=1`：由便携 EXE 设置，启用用户目录中的配置与数据布局；正常使用无需手动设置。

不存在 `OPENAI_API_KEY` 必填配置。微信 bot token 只能由官方扫码产生，保存在实际数据目录的 `secrets/*.dpapi`。context token 同样加密；不进入 SQLite、日志或 UI 状态。DPAPI CurrentUser 意味着换 Windows 用户/机器后通常需要重新扫码。源码安装脚本移除数据目录继承 ACL，只授权当前用户与 SYSTEM；现存备份仍需妥善管理。

本机应用能力无需维护逐个软件的启动路径或应用清单。服务从 Windows 应用、快捷方式、运行进程和已发现工作目录中查找候选，由 Codex 选择真实 ID；应用启动工具不接受任意命令。正式项目名来自官方实验性 `project/list`，项目根和会话目录用于定位本地工作区。2026-10-26 实测 22 个正式项目、21 个可用目录；普通项目列表只展示名称，问位置时再展示目录，不把目录数当项目数或声称它们是当前前台。

默认 `bound-user` 下，首次微信扫码绑定后无需手工登记项目。明确执行请求会把发现的真实项目映射为内部执行记录，再在该目录以 `workspace-write` 沙箱和 `never` 审批策略运行。项目内普通操作和阶段自动继续，超出沙箱明确失败，不自动批准额外权限。`per-action` 保留旧的逐次审批流程供兼容和测试，不是当前默认。

本机工具参数使用 `computer` 结构对象并受 JSON Schema 校验，`text` 不再承载嵌套 JSON 或中文工具描述。格式异常最多自动内部修复两次；仍失败才向用户报告未完成。`qa-protocol:<用户ID>` 记录分析协议版本，版本变化时不复用旧 `qa-session`，以免旧策略影响新请求；不会清除扫码凭据或更改微信绑定。

本机数据工具仅在真实发现的读取根目录内访问文件，检查相对路径和链接边界并拒绝凭据文件。支持文本、JSON、CSV 等文本格式，以及 SQLite 表结构和参数化的结构化筛选；没有任意 SQL 或 Shell 执行入口。应用界面点击、截图、OCR、专有格式和联网内容读取不在当前能力范围内。查询指定软件的数据时使用该软件来源，Bridge 自身待办是独立清单。

关闭 App 窗口后后台继续运行。顶部“微信推送”开关和设置页均修改 `wechatPushEnabled`，关闭时取消尚未投递的主动通知，关闭期间新产生的主动通知也不再投递；重新开启不补发这些通知。已经提交给微信的消息无法撤回。该开关不会关闭微信接收或普通问答，也不会停止正在执行的项目。

普通问答与本机查询不配置周期性“正在处理”通知。明确任务请求可靠入库后采用 800 ms 延迟接收回执；若回答先到就取消，不把接收说成启动。聊天、快问答和普通转发不机械回执。开始/阶段详情、完整任务和原始异常仅留软件后台；微信只保留简短回应、必要追问、重要阻塞与结果。`notifyProgress` 仅控制后台阶段详情记录，不能重新开启微信阶段推送。重启不补发旧回执。可在“微信对话 → 查看通知优化报告”查看验证、生效边界和实测延迟；用户主动问技术细节时再展开。

桌面项目完成观察通过公开 App Server API 读取会话及完成结果，首次观察只建立基线，不补发历史。它不创建或恢复模型执行轮次，不增加模型调用；通知是否投递仍受微信连接状态和主动推送开关约束。

SQLite 使用 `schema_migrations` 记录迁移。原有十张业务表保留，版本 2 增加 `questions`，保存普通消息的排队、模型决定和实际处理结果。关键去重字段使用唯一索引；决定执行前先标记 dispatching，重启不自动重放。迁移在 BEGIN IMMEDIATE 事务中执行；数据库开启 WAL 与 busy_timeout。备份请先停止服务再复制整个数据目录，避免遗漏 WAL。

本机 API 需要从 `/api/bootstrap` 获取当前启动周期的管理 token，并在 `X-Bridge-Token` 提交；所有修改接口仅接受 JSON。Host/Origin 与本机地址必须一致。没有公网监听选项，不支持在反向代理中暴露这些接口。

主要接口：`GET /api/state`；`POST /api/projects/add`、`tasks/create`、`tasks/stop`、`approvals/decide`、`todos/add`、`todos/confirm`、`reminders/add`、`settings`、`codex/check`、`sessions/list`、`sessions/fork`、`wechat/login`、`wechat/poll`、`wechat/bind`、`wechat/unbind`。字段定义见 `src/api/server.ts`，优先使用本机 UI。

创建多阶段任务的 JSON 示例：

```json
{
  "projectId": "真实项目ID",
  "title": "检查并总结代码",
  "stages": [
    { "title": "只读检查", "prompt": "只检查代码，不修改文件", "requiresApproval": false, "lowRisk": true },
    { "title": "汇总", "prompt": "仅用文字总结问题，不运行命令", "requiresApproval": false, "lowRisk": true }
  ]
}
```

默认 `bound-user` 下，上例第二阶段直接继续；`autoContinueLowRisk` 仅影响旧 `per-action` 模式，不会自动批准沙箱外工具。通知默认仅摘要，内容脱敏和截断；不能保证模型生成的摘要绝不含敏感信息，不应把敏感原文写进任务标题。
