import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
const proc = spawn(
  process.env.BRIDGE_CODEX_BIN || "codex",
  ["app-server", "--listen", "stdio://"],
  { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
);
let seq = 0;
const pending = new Map();
const request = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`${method}: timeout`));
    }, 20000);
    pending.set(id, { resolve, reject, timer });
    proc.stdin.write(JSON.stringify({ id, method, params }) + "\n");
  });
createInterface({ input: proc.stdout }).on("line", (line) => {
  try {
    const m = JSON.parse(line);
    const p = pending.get(m.id);
    if (p) {
      clearTimeout(p.timer);
      pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else if (m.id !== undefined && m.method) {
      proc.stdin.write(
        JSON.stringify({
          id: m.id,
          error: { code: -32601, message: "Probe does not approve actions" },
        }) + "\n",
      );
    }
  } catch {}
});
proc.stderr.on("data", () => {});
proc.on("error", (e) => console.error(e.message));
try {
  const init = await request("initialize", {
    clientInfo: { name: "codex_wechat_bridge_probe", version: "0.1.0" },
    capabilities: { experimentalApi: false },
  });
  proc.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
  console.log("initialize:", JSON.stringify(init));
  const a = await request("account/read", { refreshToken: false });
  console.log(
    "account:",
    JSON.stringify({
      type: a.account?.type ?? null,
      requiresOpenaiAuth: a.requiresOpenaiAuth,
    }),
  );
  const t = await request("thread/list", { limit: 5 });
  console.log(
    "thread/list:",
    JSON.stringify({
      count: t.data?.length,
      nextCursor: !!t.nextCursor,
      statuses: t.data?.map((x) => x.status?.type),
    }),
  );
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
} finally {
  proc.stdin.end();
  proc.kill();
}
