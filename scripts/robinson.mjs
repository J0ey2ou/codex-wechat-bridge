import { spawn } from "node:child_process";
import {
  existsSync,
  readFileSync,
  mkdirSync,
  openSync,
  closeSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveLaunchConfig } from "./launch-config.mjs";
import { createInterface } from "node:readline";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(
  readFileSync(path.join(root, "package.json"), "utf8"),
).version;
const build = JSON.parse(
  readFileSync(path.join(root, "dist/src/build-info.json"), "utf8"),
);
const launch = resolveLaunchConfig(root);
const { data, port } = launch;
const url = `http://127.0.0.1:${port}`;
const entry = path.join(root, "dist/src/app/main.js");
const browser = [
  path.join(
    process.env["ProgramFiles(x86)"] || "",
    "Microsoft/Edge/Application/msedge.exe",
  ),
  path.join(
    process.env.ProgramFiles || "",
    "Microsoft/Edge/Application/msedge.exe",
  ),
  path.join(
    process.env.ProgramFiles || "",
    "Google/Chrome/Application/chrome.exe",
  ),
  path.join(
    process.env.LOCALAPPDATA || "",
    "Google/Chrome/Application/chrome.exe",
  ),
].find((p) => path.isAbsolute(p) && existsSync(p));
if (!browser || !existsSync(entry))
  throw new Error(
    "请安装 Microsoft Edge / Chrome，并使用完整的鲁滨逊应用目录。",
  );

async function ready() {
  let response;
  try {
    response = await fetch(url + "/api/bootstrap", {
      signal: AbortSignal.timeout(1000),
    });
  } catch {
    return false;
  }
  let body;
  try {
    body = await response.json();
  } catch {
    /* An occupied port is not a free port. */
  }
  if (
    !response.ok ||
    body?.name !== "鲁滨逊" ||
    body.version !== version ||
    body.build?.id !== build.id
  )
    throw new Error(
      `当前仍在运行旧服务（${body?.build?.id ?? "无构建编号"}），新程序 ${build.id} 尚未生效。请等当前任务结束后退出旧服务，再打开此 EXE；不会中断任务或假装已更新。`,
    );
  return true;
}

let service;
if (!(await ready())) {
  mkdirSync(data, { recursive: true });
  mkdirSync(launch.cwd, { recursive: true });
  const stdout = openSync(path.join(data, "bridge.stdout.log"), "a");
  const stderr = openSync(path.join(data, "bridge.stderr.log"), "a");
  try {
    service = spawn(process.execPath, [entry], {
      cwd: launch.cwd,
      env: { ...launch.env, ROBINSON_MANAGED: "1" },
      detached: false,
      stdio: ["ignore", stdout, stderr],
      windowsHide: true,
    });
  } finally {
    closeSync(stdout);
    closeSync(stderr);
  }
  let launchError;
  service.on("error", (error) => {
    launchError = error;
  });
  service.once("exit", (code) => {
    process.exitCode = code || 0;
    process.exit();
  });
  let started = false;
  for (let i = 0; i < 60; i++) {
    if (launchError) throw launchError;
    if (await ready()) {
      started = true;
      break;
    }
    if (service.exitCode !== null)
      throw new Error(
        `鲁滨逊服务启动失败，请查看 ${path.join(data, "bridge.stderr.log")}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!started)
    throw new Error(
      `服务启动超时，请查看 ${path.join(data, "bridge.stderr.log")}`,
    );
}
function openWindow() {
  mkdirSync(data, { recursive: true });
  const windowProcess = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${path.join(data, "app-browser")}`,
      "--no-first-run",
      "--disable-background-mode",
    ],
    { stdio: "ignore", windowsHide: false },
  );
  windowProcess.on("error", (error) => console.error(error.message));
}
openWindow();
console.log(
  "STATUS\t鲁滨逊在托盘里运行；关闭页面仍能接收微信，退出请用托盘菜单。",
);
async function stop() {
  try {
    const boot = await (
      await fetch(url + "/api/bootstrap", { signal: AbortSignal.timeout(2000) })
    ).json();
    if (boot.build?.id !== build.id)
      throw new Error("服务已变化，请在当前软件中退出。");
    const response = await fetch(url + "/api/runtime/stop", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Bridge-Token": boot.csrf,
      },
      body: "{}",
      signal: AbortSignal.timeout(5000),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "暂时无法退出");
    if (!service) process.exit(0);
  } catch (error) {
    console.log("STATUS\t" + error.message);
  }
}
const commands = createInterface({ input: process.stdin });
commands.on("line", (command) => {
  if (command === "open") openWindow();
  if (command === "stop") void stop();
});
// If the host window process disappears, leave running work intact and exit when idle.
commands.on("close", () => {
  void stop();
  const timer = setInterval(() => void stop(), 5000);
  timer.unref();
});
