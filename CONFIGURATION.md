# 配置说明

首次安装从 `config.example.json` 生成 `config.local.json`；本地配置、数据库、日志、凭证与开发工具均被 `.gitignore` 排除。UI 可修改的策略保存到 SQLite 的 `application_settings.preferences`，优先于文件中的相同策略。

| 配置 | 默认值 | 说明 |
|---|---|---|
| port | 3210 | 本机 HTTP 端口，始终绑定 127.0.0.1 |
| dataDir | ./data | SQLite、DPAPI 密文、PID、日志位置，相对于启动工作目录 |
| timezone | Asia/Shanghai | IANA 时区，用于解析、显示日期 |
| codexBin | codex | 可配置 `codex.exe` 完整路径；安装脚本自动检测 |
| codexMode / wechatMode | real | real 或 mock，不会因真实连接失败偷偷切换 Mock |
| collectionMinutes | 15 | 普通消息整理延迟，0 为下一次调度立即处理 |
| staleMinutes | 10 | 没有任务活动事件多久变 UNKNOWN，0 禁用 |
| timeoutMinutes | 120 | 总运行超时，请求中断，0 禁用 |
| approvalMinutes | 30 | 一次审批有效期 |
| notifyProgress | true | 是否发送阶段完成通知 |
| autoContinueLowRisk | false | 仅当下一阶段 `lowRisk=true` 且 `requiresApproval=false` 才自动继续 |

环境变量用于启动位置与开发模式覆盖，不放账号凭证：

- `BRIDGE_CONFIG`：配置文件路径。
- `BRIDGE_DATA_DIR`：覆盖数据目录。
- `BRIDGE_CODEX_BIN`：覆盖官方 CLI 路径。
- `BRIDGE_PORT`：覆盖端口。
- `BRIDGE_MOCK=1`：启用两个 Mock 适配器。`start.ps1 -Mock` 另外隔离数据目录。

不存在 `OPENAI_API_KEY` 必填配置。微信 bot token 只能由官方扫码产生，保存在 `data/secrets/*.dpapi`。context token 同样加密；不进入 SQLite、日志或 UI 状态。DPAPI CurrentUser 意味着换 Windows 用户/机器后通常需要重新扫码。安装脚本移除数据目录继承 ACL，只授权当前用户与 SYSTEM；现存备份仍需妥善管理。

SQLite 使用 `schema_migrations` 记录迁移。十张业务表包含主键、JSON 记录和更新时间，关键去重字段使用唯一索引。迁移在 BEGIN IMMEDIATE 事务中执行；数据库开启 WAL 与 busy_timeout。备份请先停止服务再复制整个数据目录，避免遗漏 WAL。

本机 API 需要从 `/api/bootstrap` 获取当前启动周期的管理 token，并在 `X-Bridge-Token` 提交；所有修改接口仅接受 JSON。Host/Origin 与本机地址必须一致。没有公网监听选项，不支持在反向代理中暴露这些接口。

主要接口：`GET /api/state`；`POST /api/projects/add`、`tasks/create`、`tasks/stop`、`approvals/decide`、`todos/add`、`todos/confirm`、`reminders/add`、`settings`、`codex/check`、`sessions/list`、`sessions/fork`、`wechat/login`、`wechat/poll`、`wechat/bind`、`wechat/unbind`。字段定义见 `src/api/server.ts`，优先使用本机 UI。

创建多阶段任务的 JSON 示例：

```json
{
  "projectId": "本机授权项目ID",
  "title": "检查并总结代码",
  "stages": [
    { "title": "只读检查", "prompt": "只检查代码，不修改文件", "requiresApproval": false, "lowRisk": true },
    { "title": "汇总", "prompt": "仅用文字总结问题，不运行命令", "requiresApproval": false, "lowRisk": true }
  ]
}
```

只有本机已打开 `autoContinueLowRisk` 时，上例第二阶段才会自动继续；工具审批不会受此配置影响。通知默认仅摘要，内容脱敏和截断；不能保证模型生成的摘要绝不含敏感信息，不应把敏感原文写进任务标题。
