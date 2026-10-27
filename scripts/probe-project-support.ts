// Read-only: no project/thread creation, no inference, no credentials or messages printed.
import { loadConfig } from "../src/app/config.js";
import { AppServerClient, appServerArgs } from "../src/codex/client.js";
import { CodexVisibility } from "../src/codex/visibility.js";
import { requireModel } from "../src/codex/models.js";
const config = loadConfig();
const client = new AppServerClient(
  config.codexBin,
  appServerArgs(config.codexTransport),
  7000,
);
try {
  await client.connect();
  const projects = await new CodexVisibility(client).listProjects();
  const selected = await requireModel(client, "6.1sol");
  console.log(
    JSON.stringify({
      officialProjectList: true,
      projectCount: projects.length,
      catalogModel: selected,
      inferenceVerified: false,
      projectCreated: false,
    }),
  );
} catch {
  console.error(
    "只读探测未完成：执行端进程或元数据接口不可用；未创建项目、未调用模型、未修改运行中的 Bridge。",
  );
  process.exitCode = 1;
} finally {
  await client.disconnect();
}
