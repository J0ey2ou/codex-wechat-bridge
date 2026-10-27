# 鲁滨逊 · V0.3.0（原 Codex WeChat Bridge）

提供自带 Node 的 Windows 便携 EXE、独立 App 窗口与 PWA、App 内 OpenAI 官方登录、按微信用户隔离的个性化记忆和逐轮模型用量证据。关闭窗口后后台继续运行；顶部“微信推送”开关可关闭主动通知，微信问答仍正常回复。升级与使用说明见 [鲁滨逊使用说明](docs/ROBINSON.md)。

Windows 本地 TypeScript 服务：微信消息先由 Codex 理解，再直接回答、查找本机软件及其数据、交给对应项目、或记录待办与提醒。管理界面只监听 `127.0.0.1`。使用现有 Codex/ChatGPT 登录；没有 OpenAI API Key 或云服务器依赖。

这份交付包含真实 App Server 与 iLink 适配器，以及完全独立的 Mock 模式。**真实模型执行、微信收发及端到端验收结果，以 [TEST_REPORT.md](TEST_REPORT.md) 中对应版本的记录为准；旧版结果不自动代表 V0.3.0。**

## 使用便携版

1. 完整解压 `release/鲁滨逊-Windows-x64.zip`，双击其中的 `鲁滨逊/鲁滨逊.exe`。项目内的打包产物入口为 `release/鲁滨逊/鲁滨逊.exe`；不要单独移动 EXE，旁边的 `runtime` 和 `app` 文件夹也必须保留。
2. 本轮完整 Windows x64 包内置 Node、官方 Codex 和中文字体，无需另装 Node/npm/Python/Codex；仍需 Edge 或 Chrome 以及用户自己的登录和网络。
3. 便携版配置位于 `%LOCALAPPDATA%\Robinson\config.json`。首次同机启动若发现附近原源码配置，会沿用原数据目录和微信绑定；新机器默认使用 `%LOCALAPPDATA%\Robinson\data`，再完成自己的登录与扫码。ZIP 不包含或复制账号凭据、原数据库、`config.local.json`。
4. 关闭 App 窗口后托盘中的 EXE 继续管理后台。托盘可重开界面或安全退出；未完成的任务或消息会阻止退出。顶部“微信推送”开关可关闭主动通知，问答仍回复。

本轮原版 R 图标已实际嵌入 EXE，构建编号显示在概览页。已有桌面对话支持按项目及名称/ID 真正续接（含数字名称和无正式 projectId 的旧对话），不会以分叉冒充续接。明确要求“把这次结果整理成 PDF 报告发我”时可生成并通过微信文件消息发送，默认仍为单段文字；后台可下载报告。详细实际运行证据和限制见软件内“项目问题记录”及 `src/ui/runtime-upgrade-report.txt`。PDF 手机最终显示尚未实机验收。

桌面项目完成观察只读取 Codex 公开 App Server API，首次建立基线时不补发历史完成记录，不创建或续跑会话，不增加模型调用。后台仍须运行，消息才能继续投递。

## 源码安装

1. Windows 10/11，安装 Node.js 22.13 或更新版本（推荐 Node 24 LTS），并安装官方 Codex CLI 或 Codex 桌面附带 CLI。
2. 安装官方 Codex CLI 后，可在鲁滨逊“连接与设置”中点击“使用 ChatGPT 登录”，打开返回的官方登录页并完成验证。已有 Codex 登录会继续使用；`codex login` 仍可作为命令行入口。Bridge 不读取或复制认证文件。
3. 将项目放到固定目录，例如 `D:\codex-wechat`，在 PowerShell 中执行：

   ```powershell
   cd D:\codex-wechat
   .\scripts\install.ps1
   node scripts\robinson.mjs
   ```

安装脚本使用锁文件安装依赖、编译并测试；缺少 npm 时在项目 `.tools` 内下载官方 npm。它不会修改全局执行策略、安装 OpenClaw 或购买模型 API。如果组织策略禁止脚本，请使用组织允许的启动方式，不要关闭系统安全设置。**升级前先停止 Bridge 和本项目测试进程**，否则 Windows 会锁住 esbuild 可执行文件，导致 `npm ci` 报 EPERM。

4. 打开 [本地控制台](http://127.0.0.1:3210)。在“连接与设置”检查 Codex。
5. 点击“获取扫码二维码”，用个人微信扫码，必要时在本地页面输入微信显示的验证码。扫码完成后核对用户 ID，再点击“在本机确认绑定此用户”。绑定只能在本机进行。
6. 绑定完成后即可直接用微信查询项目、打开软件或安排项目工作，无需逐项目登记或重复授权。Bridge 自动发现正式项目与本地目录；指定已有对话时按真实名称/ID 验证并续接原线程，管理页也可检查历史后续接。分叉保留为单独操作，明确产生新线程。
7. 在微信向扫码创建的助手发“你好”，建立回复上下文。平时直接用自然语言：

   ```text
   帮我检查人口重建的代码问题，不运行模型、不删除文件
   现在在忙什么？
   明天下午三点提醒我交报告
   我还有哪些事没做？
   我最近在做哪些项目？
   打开 ddl-app，查一下今天没完成的待办
   ```

Bridge 先持久化收到的消息，再交给 Codex。普通问答和本机查询只发送结果、必要的追问或明确错误，不发送固定的“还在处理”提示；重启会取消旧版本尚未发出的此类提示。项目任务的启动、阶段和完成/失败摘要受主动推送开关控制；完成回复使用简短自然说明，保留尚未验证、尚未重启等限制，技术详情留在本地任务记录。单次模型轮次 90 秒没有完整结果会报告超时；连续本机查询还受总时限约束。服务端接受消息不等于手机已显示；请在首次验收时亲自核对手机。

普通消息全部先进入独立的 Codex 分析会话。模型会看到原话、真实正式项目、当前任务、待办和最近执行结果，返回结构化决定；Bridge 校验动作及目标后才执行。这里没有关键词式的业务分流。问“什么是过拟合”直接回答，追问“举个例子”沿用同一分析会话；明确说“帮我检查某项目代码”才交给该项目。缺少时间或目标时，Codex 根据上下文具体追问。

本机查询采用“发现 → 读取 → 继续分析 → 回答”的连续流程。Bridge 自动发现 Windows 开始菜单、桌面快捷方式、正在运行的软件及项目构建产物；Codex 选择返回的真实应用 ID，明确要求打开时才启动。读取器可以查看已发现目录中的文本、JSON、CSV，以及 SQLite 的真实表结构和筛选结果。比如查询 ddl-app 的待办，会查找该软件的数据来源，不会拿 Bridge 自己的待办清单代替。软件重名或有多份数据且不能确定来源时会具体追问，不要求先配置每个软件。

询问“我的工作项目有哪些”时，名称来自 Codex 官方实验性 `project/list`，默认只列项目名，不用磁盘路径冒充项目，也不附加“去授权”的话术。2026-10-26 本机实测为 22 个正式项目、21 个可用目录；数量会随项目变化。目录信息结合官方项目根和会话记录，只有问位置时才展示，不代表当前前台窗口。启动返回 `launch_requested` 只说明系统接受了启动请求。当前没有通用 GUI 点击、截图、OCR、专有文件格式或联网应用内容读取能力；无法读取时会说明实际限制。

2026-10-26 第二轮修复把工具参数改成强 schema 的 `computer` 对象，避免中文描述误传到 JSON 接口。格式错误最多在内部修复两次，不要求用户写 JSON；协议升级会新建分析会话，避免沿用旧的“手动授权”策略，现有微信绑定保持不变。

“我还有多少 token”由模型识别为账号查询，Bridge 使用官方 `account/rateLimits/read` 获取实际额度窗口；“累计用了多少”查询 `account/usage/read`。接口不提供精确剩余 token 余额时会如实说明。问答和分流也会消耗额度：ChatGPT 登录使用对应 Codex 套餐权益，API Key 登录则使用 OpenAI Platform API 计费；两者不能混同。

`/help` 也会返回自然语言例子；技术命令列表留在 `/commands`，下方命令只是可选的精确操作入口。

## 任务与执行范围

默认 `executionAuthorization=bound-user`：首次扫码绑定建立身份授权，之后用户明确安排的项目任务直接执行。Bridge 按真实项目 ID 找到目录并自动创建内部执行记录，不要求再次添加“授权项目”。项目会话使用 `workspace-write` 沙箱与 `never` 审批策略，项目内普通操作和后续阶段不再逐次询问；超出沙箱的操作明确失败，不盲目提权或代替用户批准。

可在微信直接安排工作、追加要求或停止，也可在管理页填写分阶段计划，例如：检查模型代码、运行小样本验证、总结结果。运行中的新指令进入该项目持久队列，避免同一会话并发写入。

```text
/continue 继续当前任务，但不要删除原始文件
/stop 具体任务ID
```

`per-action` 仅作为兼容旧模式及测试选项，保留只读沙箱、逐次审批和 `/approve`、`/reject`、`/modify` 命令。该模式下审批 ID 单次使用，绑定线程、轮次、连接和有效期；普通“同意”或 `/continue` 不会绕过审批，Shell 审批仍需本机处理。

分析问答会话和软件数据查询继续保持只读，不因项目执行模式改变而取得任意 Shell 或 SQL 入口。额外权限请求及未知交互默认拒绝。

单阶段任务完成仅代表这条任务结束；多阶段任务必须全部完成才会显示 COMPLETED。

## 工作待办与提醒

```text
/addtodo 下周三之前完成论文修改，周二先检查一遍统计结果
/todo
/confirmtodo 待办编号 2026-11-03 15:00
/confirmtodo 待办编号 无日期
/remind 待办编号 2026-11-03 09:00 每30分钟
/done 待办编号
/edittodo 待办编号 2026-11-05 17:00 完成项目报告
/canceltodo 待办编号
/calendar
```

普通消息即时交给 Codex 判断。只有明确的记录/提醒意图才进入待办模块；模型不确定时间时会先追问。`/addtodo` 保留为立即解析入口。`/collect 消息内容` 和协议能识别的引用/转发消息只作为数据，在默认 15 分钟收集窗口后整理；其中的命令不会执行。纯文本复制不带可靠转发元数据时，推荐使用 `/collect`。

自然语言日期由 Codex 结合当前时间和配置时区理解，再由 Bridge 校验日期合法性及是否已过期；不把“明天会下雨吗”当提醒。明确无日期可以记录为无日期待办。命令和转发收集仍支持本地日期解析，日期级截止点采用当天末尾，模糊时段请求确认。不自动推断负责人。

提醒保存在 SQLite，重启后继续调度；重复提醒不会把睡眠期间错过的每个周期全部补发。网络明确失败会退避重试；发送超时或发送途中崩溃，结果标为 `delivery_unverified`，不盲目重发。

## 启动、停止与自启

便携版双击 EXE 打开界面，关闭窗口后后台继续运行。下面的脚本用于源码部署，操作前应确认它们对应实际使用的配置和数据目录。

```powershell
.\scripts\start.ps1                 # 隐藏窗口后台进程
.\scripts\start.ps1 -Foreground     # 前台诊断
.\scripts\stop.ps1                  # 通过本地停止标志优雅退出
.\scripts\doctor.ps1                # CLI、登录、App Server 检查
.\scripts\enable-autostart.ps1      # 当前用户登录 Windows 时启动
.\scripts\disable-autostart.ps1     # 移除该计划任务
```

自启只创建当前用户、普通权限的 Windows 登录计划任务；本轮不会默默为你开启。任务在睡眠/关机期间不能执行。停止 Bridge 不代表外部 R/Python 后代进程一定已经终止；重启时原执行任务变为 UNKNOWN，必须检查后再处理。不要删除数据库来清理 UNKNOWN。

## 无账号开发与测试

```powershell
npm ci
npm run check
npm test
npm run build
.\scripts\start.ps1 -Mock
.\scripts\stop.ps1 -Mock
```

Mock 模式使用 `data/mock`，避免污染真实账号数据；管理页会明确标识 MOCK，可绑定模拟用户并输入微信命令。Mock 和真实实例默认共用端口，请先停止另一个实例，或用 `BRIDGE_PORT` 指定不同端口。

没有全局 npm 时，可使用：

```powershell
node .tools\npm\bin\npm-cli.js run build
node node_modules\tsx\dist\cli.mjs --test tests/*.test.ts
node node_modules\tsx\dist\cli.mjs scripts\smoke-codex.ts
node node_modules\tsx\dist\cli.mjs scripts\smoke-chat.ts
node node_modules\tsx\dist\cli.mjs scripts\smoke-computer.ts
# 需要实际启动验证软件时显式指定：
node node_modules\tsx\dist\cli.mjs scripts\smoke-computer.ts --open
```

真实 Codex 冒烟测试会创建专用只读测试会话，验证文字回复、恢复和中断；`smoke-chat` 验证模型问答、追问、账号查询、项目分流及提醒澄清。`smoke-computer` 默认只读验证工作目录和 ddl-app 数据查询，`--open` 才显式启动验证软件。脚本使用隔离的 Bridge 数据库和模拟投递，不向微信发消息，也不修改业务数据；会消耗现有账号额度。微信测试按 [手动验收](docs/ACCEPTANCE.md) 执行。

构建完成后运行 `scripts\package-windows.ps1`，提供 `-CodexPath`（官方安装中的 codex.exe）和 `-CodexLicensePath`（对应官方许可证）；可用 `-NodeLicensePath` 指定本地 Node 许可证，避免构建时下载。完整包收集编译应用、生产依赖、私有 Node、Codex 及同目录辅助程序、中文字体和许可证，不包含用户数据和配置。`鲁滨逊.exe --self-test <报告路径>` 可在不打开窗口、连接微信或调用模型的情况下检查内置环境。打包、安装和服务启动是三个阶段，实际生效以 `/api/state` 的构建编号为准。

打包会从原 `src/ui/icon.svg` 转换并嵌入 EXE 图标，再校验实际资源字节；已有包保留，新包另存。图标更新的当前限制、验证范围与优化候选见 [图标与下一步建议](docs/ICON_AND_NEXT_STEPS.md)。

## 文件与模块

| 位置 | 职责 |
|---|---|
| `src/codex` | 官方 stdio RPC、重连、Mock、桌面会话适配 |
| `src/computer` | 工作目录和 Windows 应用发现、按真实 ID 启动、文本与 SQLite 只读工具 |
| `src/channels/wechat` | iLink 扫码、长轮询、上下文、发送、Mock |
| `src/tasks` / `src/approvals` | 状态机、持久队列、结构化阶段、唯一审批 |
| `src/notifications` | 持久投递箱、重试与不确定投递 |
| `src/scheduler` | 时区日期规则、待办、提醒、收集窗口 |
| `src/security` | 路径校验、脱敏、Windows DPAPI |
| `src/storage` | SQLite WAL、事务和迁移 |
| `src/api` / `src/ui` | 本机 HTTP API、CSRF 防护、中文界面 |
| `tests` / `scripts` | 自动化测试、真实探针、Windows 运维 |

配置见 [CONFIGURATION.md](CONFIGURATION.md)，选型见 [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md)，限制与优先级见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。

微信可按「新建 Codex 项目『阅读助手』，使用 6.1sol，先整理需求」发起正式项目创建。名称必填，目录和初始任务可省略；返回官方项目 ID 后可直接继续分发任务。目录边界、模型核验、失败恢复及当前生效状态见 [微信创建项目](docs/PROJECT_CREATION.md)。
