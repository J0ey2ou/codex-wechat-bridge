# Codex WeChat Bridge · MVP V0.1

Windows 本地 TypeScript 服务：通过微信文本命令管理 Codex 任务、接收通知、审批阶段、整理工作待办。管理界面只监听 `127.0.0.1`。使用现有 Codex/ChatGPT 登录；没有 OpenAI API Key 或云服务器依赖。

这份交付包含真实 App Server 与 iLink 适配器，以及完全独立的 Mock 模式。**是否完成真实模型执行、微信收发及端到端验收，请以 [TEST_REPORT.md](TEST_REPORT.md) 为准。**

## 从零安装

1. Windows 10/11，安装 Node.js 22.13 或更新版本（推荐 Node 24 LTS），并安装官方 Codex CLI 或 Codex 桌面附带 CLI。
2. 在本机完成 `codex login`，选择现有 ChatGPT 账号。`codex login status` 应显示 ChatGPT 登录。Bridge 不读取或复制认证文件。
3. 将项目放到固定目录，例如 `D:\codex-wechat`，在 PowerShell 中执行：

   ```powershell
   cd D:\codex-wechat
   .\scripts\install.ps1
   .\scripts\start.ps1
   ```

安装脚本使用锁文件安装依赖、编译并测试；缺少 npm 时在项目 `.tools` 内下载官方 npm。它不会修改全局执行策略、安装 OpenClaw 或购买模型 API。如果组织策略禁止脚本，请使用组织允许的启动方式，不要关闭系统安全设置。**升级前先停止 Bridge 和本项目测试进程**，否则 Windows 会锁住 esbuild 可执行文件，导致 `npm ci` 报 EPERM。

4. 打开 [本地控制台](http://127.0.0.1:3210)。在“连接与设置”检查 Codex。
5. 点击“获取扫码二维码”，用个人微信扫码，必要时在本地页面输入微信显示的验证码。扫码完成后核对用户 ID，再点击“在本机确认绑定此用户”。绑定只能在本机进行。
6. 在“授权项目”中输入项目名称和绝对目录。不要授权磁盘根目录。可查看同目录 Codex 历史会话并选择分叉；分叉后 Bridge 复用该会话，不接管原桌面聊天。
7. 在微信向扫码创建的助手发“你好”，建立回复上下文。平时直接用自然语言：

   ```text
   帮我检查人口重建的代码问题，不运行模型、不删除文件
   现在在忙什么？
   明天下午三点提醒我交报告
   我还有哪些事没做？
   ```

Bridge 会先确认接收，持久化任务，然后发送启动、阶段和完成/失败摘要。服务端接受消息不等于手机已显示；请在首次验收时亲自核对手机。

自然语言优先，不需要记命令。缺少项目时会问“哪个项目”，随后回项目名称即可；“明天下午”会追问几点，回“下午三点”即可补全；看过待办列表后可以说“第二件做完了”或“报告已经交了”。问候和感谢不会生成待办。澄清上下文保存 15 分钟，当前项目选择会保留。未识别的表达会询问“处理项目还是记为待办”，不会擅自执行。

`/help` 也会返回自然语言例子；技术命令列表留在 `/commands`，下方命令只是可选的精确操作入口。涉及操作审批仍要求复制带唯一编号的确认句，不根据“好的”直接执行。

## 任务、阶段与审批

在管理页“任务与审批”填写分阶段计划，每行一个阶段。例如：检查模型代码、运行小样本验证、总结结果。首阶段由创建动作授权；后续阶段默认等待审批。

```text
/approve 具体审批编号
/reject 具体审批编号
/modify 具体审批编号 修改为仅检查男性模型代码，不执行计算
/continue 继续当前任务，但不要删除原始文件
/stop 具体任务ID
```

不能只回复“同意”来批准任务，以免批准错对象。审批 ID 单次使用，绑定线程、执行轮次、连接和有效期。普通 `/continue` 不会绕过审批。运行中的新任务指令进入该项目持久队列，避免同一会话并发写入。

阶段审批、具有完整且位于项目内文件清单的文件审批可通过微信处理。**Shell 命令审批仅在本机操作**：命令可能扩大沙箱访问，V0.1 不提供手机端任意命令提权。额外权限请求及未知交互默认拒绝。自动继续低风险阶段也不会自动批准工具。

单阶段任务完成仅代表这条任务结束；多阶段任务必须全部完成才会显示 COMPLETED。Codex 自己的阶段内计划变化不会隐式批准下一阶段。

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

普通消息会等待默认 15 分钟整理；`/addtodo` 立即解析。`/collect 消息内容` 强制作为数据；协议能识别的引用/转发消息也只作为数据。纯文本复制不带可靠转发元数据时，推荐使用 `/collect`。

支持完整年月日、今天/明天/后天、本周/下周/下下周与具体时刻。只有明确日期而没有时间时，按当地时间当天 23:59:59 作为日期级截止点并设置到期提醒；“明天下午”“今晚”等模糊时段会请求确认，不擅自指定钟点。没有日期的事项可确认保留为无日期待办。不自动推断负责人。复杂语义暂不调用模型，避免误解析产生执行行为。

提醒保存在 SQLite，重启后继续调度；重复提醒不会把睡眠期间错过的每个周期全部补发。网络明确失败会退避重试；发送超时或发送途中崩溃，结果标为 `delivery_unverified`，不盲目重发。

## 启动、停止与自启

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
```

真实 Codex 冒烟测试会创建专用只读测试会话，验证文字回复、恢复和中断；消耗现有账号额度，不读写项目文件。微信测试由本机扫码后按 [手动验收](docs/ACCEPTANCE.md) 执行。

## 文件与模块

| 位置 | 职责 |
|---|---|
| `src/codex` | 官方 stdio RPC、重连、Mock、桌面会话适配 |
| `src/channels/wechat` | iLink 扫码、长轮询、上下文、发送、Mock |
| `src/tasks` / `src/approvals` | 状态机、持久队列、结构化阶段、唯一审批 |
| `src/notifications` | 持久投递箱、重试与不确定投递 |
| `src/scheduler` | 时区日期规则、待办、提醒、收集窗口 |
| `src/security` | 路径校验、脱敏、Windows DPAPI |
| `src/storage` | SQLite WAL、事务和迁移 |
| `src/api` / `src/ui` | 本机 HTTP API、CSRF 防护、中文界面 |
| `tests` / `scripts` | 自动化测试、真实探针、Windows 运维 |

配置见 [CONFIGURATION.md](CONFIGURATION.md)，选型见 [TECHNICAL_DECISIONS.md](TECHNICAL_DECISIONS.md)，限制与优先级见 [KNOWN_LIMITATIONS.md](KNOWN_LIMITATIONS.md)。
