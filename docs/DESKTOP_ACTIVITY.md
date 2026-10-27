# Codex 页面任务的操作台观察（2026-10-27）

用户反馈：同时有两个从 Codex 页面发起的对话运行，但鲁滨逊操作台没有任何记录。

根因有两层。原 `/api/state.tasks` 仅查询 Bridge 自有任务表，UI 的执行卡片与列表也仅渲染该表。已有完成通知观察器不提供任务列表，还会排除曾由 Bridge 管理的线程，因此不能充当通用桌面对话状态源。独立 App Server 的运行态又是本连接的视角：实测桌面工具返回两个 active，而独立官方接口对同一 ID 返回 notLoaded、最近轮次 interrupted 且 completedAt=null，不能按字面认定它们已经停止。

实现：新增只读 CodexActivityMonitor、认证后的 `/api/activity/refresh`、`/api/state.desktopActivity` 和 `read-only-observation-v1` 能力标识。概览和任务页都展示外部对话，含项目、真实对话 ID、最近轮次及活动时间、状态证据、配置模型和实际模型未报告。Bridge 未结束任务按 threadId/targetThreadId 去重；历史 Bridge 任务完成后，该线程在桌面再运行仍可出现。

每 5 秒轮询，不调用模型、不产生微信提醒、不恢复/接管/打断原对话、不修改 Codex 存储。每次读最新一页与至多一页历史元数据、至多 6 个最近轮次摘要；重复刷新合并，错误/断线保留记录但标记过期。内存缓存不跨重启继承“运行中”。跨绑定用户或连接变化立即隐藏旧观察结果，官方项目 ID 与真实目录及 bridgeOwner 再校验；隐藏问答内部线程、测试线程、子代理及已知其他用户的线程。无专属 owner 标记的桌面对话限于当前本机 Codex 账户，不声称提供不同系统账户间的隔离。

状态说明：官方 runtime active 才标“执行中/等待操作”；其他客户端最近轮次无结束时间且近期有元数据更新，标“有活动 · 运行待确认”。90 秒无更新改为“状态待确认”；读取超过 20 秒或失败时标“状态待刷新”。中断没有结束时间绝不显示“已中断”；完成与失败依赖官方轮次终态；中断还需结束时间。配置模型不是实际推理模型。跨客户端实时状态无法从独立 App Server 得到完整保证，仍明确暴露 crossClientRuntime=false，不伪造精确实时运行数量。

验证：2026-10-27 只读真实接口探测核实上述两条对话的差异，原始允许字段保存在本地 test-output/desktop-observation-probe.json。新增 8 个回归用例覆盖双任务、等待审批、跨客户端状态投影、完成/断线/错误、Bridge 去重、用户隔离、重启/连接变化、分页/归档和只读调用。完整 323 项测试通过（含本机报告隔离），包含本机 HTTP/stdio 测试，无真实微信测试消息。最终部署状态以操作台实时构建编号、能力标识和最近成功观察时间为准，不能用源码构建成功代替实际生效。

官方接口依据：[Codex App Server](https://learn.chatgpt.com/docs/app-server)，本轮已搜索并打开核对 thread/list、thread/turns/list、thread/read、thread/status/changed 的含义。桌面连接器只用于此次独立对照，不把仅在 Codex 客户端工具环境可用的连接器伪装成 EXE 的依赖。
