# 微信新建正式 Codex 项目

已实现消息决策、Bridge 创建服务、正式项目登记、发现和任务执行链路。**当前运行的 Bridge 尚未重启，新功能未在微信现场验收。** 本次没有创建任何真实新项目，也没有重启、停止或改动文献打包任务。

## 使用

待现有任务结束，由 Bridge 的管理入口正常重启已构建的应用。首次运行仍使用 `Robinson.cmd` 或 `npm run app`；不要在已有实例运行时再启动第二个真实实例。

微信示例：

> 新建 Codex 项目「阅读助手」，使用 6.1sol，初始任务是整理需求并写一份 README。

也可以说「新建 Codex 项目『阅读助手』，目录用 books/reader」。目录表示**目标目录**，相对于默认的当前用户创建根目录；不是父目录。仅名称是必需信息，缺名称时追问，不能自行命名。没有初始任务时只创建项目，不调用执行模型；提供任务时在正式项目确认后排队。成功回复使用官方返回的名称、项目 ID 和实际目录，后续可以直接说「在阅读助手中继续实现……」，或指定正式项目 ID。

`projectCreationRoot` 默认 `./projects`，相对于 Bridge 工作目录。它必须是当前工作目录内的独立子目录，不能用配置扩大本轮授权边界。实际默认根为 `<projectCreationRoot>/<用户哈希前16位>`，最终目录默认为 `<默认根>/<名称>`。允许在自己的默认根下指定相对路径或绝对目标路径；越界路径、链接、保留目录、Bridge 数据目录和已有目录会被拒绝。不会复用或覆盖已有目录，也不会要求逐项目注册或重复授权。默认 `/projects/` 已加入仓库忽略规则。

## 正式项目与恢复语义

- `create_project` 使用严格的 `newProject: {name,directory,initialTask,model}` 结构，各可选项显式为 `null`。协议版本更新后自动更换旧问答策略上下文，不修改微信绑定。
- 通过完整分页的 `project/list` 检查重名，再独占创建目录，随后调用官方实验性 `project/create`。请求含稳定幂等键、名称、`roots: [{path}]` 及归属标记。只在返回项目 ID、名称、目录全部匹配后登记内部项目。
- SQLite 版本 4 增加按用户隔离的 `project_creations`。提交前落盘；重复请求、并发请求和初始任务均去重。超时或响应不匹配不自动重放创建，只按官方返回的创建标记、名称和根目录核对唯一记录；未找到时明确保持未确认。不同请求不能绕过未确认的同名或同目录操作。
- 官方接口不支持、目录创建失败或结果未确认时不启动任务；不把仅建目录说成正式项目成功。残留目录保留，不冒险递归删除。已确认的正式项目立即加入发现，即使列表存在延迟，也能用其正式 ID 执行。
- 创建记录、内部项目、任务和模型偏好沿用用户隔离；异步调用前后校验绑定。正式项目元数据带不可逆用户哈希，发现目录也按用户根过滤，换绑后的缓存不能暴露这些新建项目或允许后续执行。

## 模型与证据

官方 [Models](https://learn.chatgpt.com/docs/models) 确认 `6.1sol` 对应 `gpt-6.1-sol`。[App Server 文档](https://learn.chatgpt.com/docs/app-server) 要求通过 `model/list` 查询执行端目录，并允许在线程及轮次中指定模型。目录中出现不等于账户调用一定成功。

创建时查询当前执行端的实际 `model` 字段，拒绝用展示名称或其他型号替代。项目保存原始要求和执行标识；初始任务、后续任务及恢复会话都显式携带该模型。每次执行前重新查询目录，检查线程响应中的模型配置；没有明确确认或返回不一致则不启动轮次。轮次报告不同模型或发生服务端改路时，记录并请求停止，等待停止确认，不把结果记为指定模型成功。没有指定模型的既有任务不受影响。

推理证据区分 `requestedModel`、`threadModel`、轮次明确报告的 `actualModel` 和 `reroutedModel`，不能把线程默认配置当成实际模型。2026-10-26 对运行中 Bridge 的只读检查显示：本次开发任务属于 `project-execution`，线程配置是 `gpt-6-astra`，`actualModel=null`；记录的计费来源是 `chatgpt-plan`。本开发代理没有切换当前模型的接口，不能声称已改用 6.1sol。该记录不等于账户余额，也不等于独立 OpenAI API 额度；余额/订阅剩余额度需通过 Bridge 的账户查询官方接口核实。

## 验证与限制（2026-10-26）

从当前安装的官方 CLI 生成了包含实验性接口的协议：`codex app-server generate-json-schema --experimental --out .test-tmp/project-protocol`。实际 schema 确认 `project/create` 的 `idempotencyKey/name/roots/metadata`、项目响应及线程/轮次模型参数；通用网页没有列出项目创建接口，因此没有凭网页内容猜测该结构。运行中 Bridge 的只读状态仍能发现 22 个正式项目。

TypeScript 构建和 UI 复制已通过；编译后回归测试 **224 项通过、0 项失败**。`tests/project-creation.test.ts` 覆盖微信路由与结构化决策、成功创建与返回 ID 的传递、缺名追问、目录重名、并发与重放、创建失败与不匹配响应、超时恢复、初始任务及后续执行、模型分页/拒绝/改路、用户隔离、链接和越界、迁移保留已有任务，以及正式项目关联失效时禁止降级为本地目录执行。测试使用模拟官方 RPC，没有消耗真实推理额度，也没有向微信发测试消息。

```powershell
node node_modules/typescript/bin/tsc -p tsconfig.json
node scripts/copy-ui.mjs
$env:TEMP='D:\codex-wechat\.test-tmp'
$env:TMP=$env:TEMP
node --test --test-isolation=none --test-skip-pattern='real stdio transport|stdio request timeout' dist/tests/*.test.js
```

两项真实 stdio 子进程测试因当前沙箱的子进程限制未纳入本次通过数。新增 `node dist/scripts/probe-project-support.js` 仅查询项目目录和模型目录，不建项目、不启推理、不输出认证数据；本环境独立探测未完成，尚未核实该账户此刻的 6.1sol 目录和真实推理可用性。真实「微信请求 → 官方项目创建 → 模型执行」须在安全重启后，使用用户实际指定的项目名称验收；本次没有为验收擅自创建项目。服务源代码及构建输出已更新，未重打 Windows 便携包。
