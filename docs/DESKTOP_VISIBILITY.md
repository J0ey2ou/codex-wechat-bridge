# 微信会话在 Codex 桌面的展示

微信项目任务使用实际 Codex 项目的名称和归属。Bridge 通过公开的 `project/list` 按真实目录匹配已有项目；只有目录尚无项目时才用带稳定幂等键的 `project/create` 创建项目。不能混用桌面 Connector 的项目 ID 和 App Server 的项目 ID。

新建执行会话在 `thread/start` 中传入官方 `projectId`。已有 Bridge 会话通过 `thread/metadata/update` 补归属，并继续复用原会话；同目录下不同正式项目的会话分别保存。新会话设置简短标题。普通微信问答保留独立会话，归入 Bridge 所在项目；它与项目执行会话仍然分开，不会把一次问答再次当成执行任务。

这些展示操作只更新项目、会话名称和归属，不调用模型，不增加模型 token 消耗。列表查询有分页，不会为每条消息复制聊天。命名或归属接口失败会记录错误，不会重放任务。

## HTTP provider 与桌面兼容

`chatgpt-http` 使用 `bridge_http`，其定义必须同时能被桌面读取。仅将定义传给 Bridge 子进程的 `-c` 会导致桌面打开该会话时报 `Model provider bridge_http not found`。

在项目目录执行以下脚本，通过官方配置 API 注册定义，不更改默认模型或默认 provider，也不读取登录凭据：

```powershell
node --import tsx scripts/repair-desktop-provider.ts --apply
```

不带 `--apply` 只检查。配置更新使用用户层版本，避免覆盖并发配置修改。已有不同定义会保留。

已有微信会话可按当前绑定用户补齐展示信息：

```powershell
node --import tsx scripts/sync-desktop-threads.ts --apply
```

该脚本只读 Bridge 数据库，通过公开会话元数据 API 更新名称和项目；不启动、恢复、停止模型任务。无 `--apply` 只读检查。

当前桌面的项目面板用 `modelProviders: []` 查询，能展示 HTTP provider 会话；普通最近列表可能仍按默认 provider 筛选，因此应从对应项目打开。侧栏可见不等于两个执行端可以同时接管同一会话；Bridge 正在执行的聊天不应在桌面重复发送同一任务。

## 2026-10-26 验证

- 补齐 `bridge_http` 定义，新进程可读取，默认模型和 provider 保持原值。
- 一条真实项目执行会话和两条微信问答历史均已关联到现有 `codex——wechat交互` 项目；保留实际消息和运行记录。
- 公开的跨 provider 项目查询可以检索对应会话。
- 展示相关模块、队列归属、同目录项目的会话隔离及失败不重放均有自动测试。
- 现有会话元数据立即生效；运行服务在原项目任务完成后更新，避免中断执行。

## 微信结果表达

项目最终结构化结果增加 `userMessage`，直接用本次执行模型生成简短的用户说明，不另外调用模型改写。微信通知只发送结果、影响使用的未完成事项，以及必要的下一步。保留未部署、未重启、未验证及不能确认用量等事实，不能把技术实现完成描述成全部可用。

`summary`、`files`、`tests` 继续保存到本地任务详情；不把英文状态码、文件清单、命令退出码和秒数自动附加到微信消息。旧任务没有 `userMessage` 时使用有长度限制的摘要，失败或中断时明确说明。
