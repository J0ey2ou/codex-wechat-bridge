// Produce an immutable backend-only build. Does not install, stop or start services.
import {
  readdirSync,
  lstatSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "dist", "src");
const name = `bridge-original-thread-v1-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 6)}`;
const output = path.join(root, "release", name);
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = {};
function copy(relative = "") {
  for (const entry of readdirSync(path.join(source, relative), {
    withFileTypes: true,
  })) {
    const local = path.join(relative, entry.name);
    const from = path.join(source, local);
    if (lstatSync(from).isSymbolicLink())
      throw new Error("Build output must not contain links");
    if (entry.isDirectory()) {
      copy(local);
      continue;
    }
    if (
      !entry.isFile() ||
      !/\.(?:js|js\.map|json|html|css|svg|txt|webmanifest)$/.test(entry.name)
    )
      throw new Error(`Unexpected build file: ${local}`);
    const bytes = readFileSync(from);
    const to = path.join(output, "dist", "src", local);
    mkdirSync(path.dirname(to), { recursive: true });
    writeFileSync(to, bytes, { flag: "wx" });
    if (digest(readFileSync(to)) !== digest(bytes))
      throw new Error(`Build copy mismatch: ${local}`);
    files[`dist/src/${local.replaceAll(path.sep, "/")}`] = digest(bytes);
  }
}
mkdirSync(output, { recursive: false });
copy();
const metadata = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
);
writeFileSync(
  path.join(output, "build-manifest.json"),
  JSON.stringify(
    {
      kind: "backend-overlay-not-exe",
      capability: "original-thread-v1",
      version: metadata.version,
      builtAt: new Date().toISOString(),
      engines: metadata.engines,
      dependencies: metadata.dependencies,
      installed: false,
      restarted: false,
      actualThreadExecutionVerified: false,
      files,
    },
    null,
    2,
  ) + "\n",
  { flag: "wx" },
);
writeFileSync(
  path.join(output, "READ-ME.txt"),
  "这是后端构建快照，不是独立 EXE，也没有安装或重启服务。\n" +
    "依赖现有鲁滨逊的 Node 运行时和清单所列依赖。由受管理更新流程在当前任务安全结束后部署，先备份旧 app/dist/src，保留配置、用户数据及无关修改。\n" +
    "检查实际运行服务 /api/state 的 capabilities.originalThreadContinuation 是否为 original-thread-v1，再按后台项目问题记录验收原对话续接。\n" +
    "不使用此目录启动第二个真实 Bridge；版本号相同不代表新构建已运行。原生 R 图标 EXE 尚未更新。\n",
  { flag: "wx" },
);
console.log(
  JSON.stringify({
    output,
    filesVerified: Object.keys(files).length,
    installed: false,
    restarted: false,
  }),
);
