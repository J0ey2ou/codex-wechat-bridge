import { loadConfig } from "./config.js";
import { Bridge } from "./bridge.js";
import { createApi } from "../api/server.js";
import {
  mkdirSync,
  writeFileSync,
  existsSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import path from "node:path";
const config = loadConfig();
mkdirSync(config.dataDir, { recursive: true });
const lock = path.join(config.dataDir, "bridge.pid");
if (existsSync(lock)) {
  const pid = Number(readFileSync(lock, "utf8"));
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {}
  if (alive) throw new Error("Bridge 已在运行，或 PID 锁需要本机核查");
  unlinkSync(lock);
}
writeFileSync(lock, String(process.pid), { flag: "wx" });
const bridge = new Bridge(config);
const server = createApi(bridge);
bridge.onShutdown = () => void shutdown();
let closing = false;
const stopFile = path.join(config.dataDir, "stop.request");
const stopWatcher = setInterval(() => {
  if (existsSync(stopFile)) {
    if (bridge.tasks.tasks().some(t => !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status)) || bridge.store.all<{status:string}>("questions").some(q => ["queued","running","dispatching"].includes(q.status))) return;
    unlinkSync(stopFile);
    void shutdown();
  }
}, 500);
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(stopWatcher);
  server.close();
  await bridge.stop();
  if (existsSync(lock) && readFileSync(lock, "utf8") === String(process.pid))
    unlinkSync(lock);
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
process.on("uncaughtException", () => {
  console.error("Bridge 出现未捕获异常，正在安全关闭；请检查本机状态。");
  void shutdown();
});
process.on("unhandledRejection", () => {
  console.error("Bridge 后台请求失败，请查看管理页。");
});
server.on("error", (e) => {
  console.error(`HTTP 服务启动失败：${e.message}`);
  void shutdown();
});
server.listen(config.port, "127.0.0.1", () => {
  console.log(`鲁滨逊: http://127.0.0.1:${config.port}`);
  console.log(`模式 Codex=${config.codexMode}, WeChat=${config.wechatMode}`);
  void bridge.start().catch(() => {
    bridge.store.setSetting(
      "lastBackgroundError",
      "启动失败，请检查 Codex、微信凭证及权限",
    );
  });
});
