import { DatabaseSync } from "node:sqlite";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
const config = JSON.parse(
  readFileSync("config.local.json", "utf8").replace(/^\uFEFF/, ""),
);
const db = new DatabaseSync(
  path.join(config.dataDir ?? "data", "bridge.sqlite"),
  { readOnly: true },
);
const fingerprint = (value) =>
  value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null;
const rows = (table) =>
  db
    .prepare(`SELECT data FROM ${table} ORDER BY updated_at DESC`)
    .all()
    .map((r) => JSON.parse(r.data));
const question = rows("questions").find((q) => /鲁滨逊/.test(q.text));
const task = rows("tasks").find((t) => /鲁滨逊/.test(t.title));
const describe = (r) =>
  r
    ? {
        createdAt: new Date(r.createdAt).toISOString(),
        status: r.status,
        threadFingerprint: fingerprint(r.threadId),
        turnFingerprint: fingerprint(r.turnId),
        action: r.decision?.action,
        modelRecorded: typeof r.actualModel === "string" ? r.actualModel : null,
        tokensRecorded: r.tokens ?? null,
      }
    : null;
const report = {
  checkedAt: new Date().toISOString(),
  source: "project SQLite (read-only) and running Bridge account check",
  configured: {
    codexMode: config.codexMode,
    wechatMode: config.wechatMode,
    transport: config.codexTransport,
  },
  wechatEntry: describe(question),
  projectExecution: describe(task),
  account: null,
  limitation:
    "Historical rows do not establish the actual model or per-turn tokens. Current account state is not historical billing proof. Quota must be verified via Bridge account/rateLimits/read; no balance is inferred.",
};
db.close();
try {
  const base = `http://127.0.0.1:${config.port ?? 3210}/api/`;
  const boot = await (
    await fetch(base + "bootstrap", { signal: AbortSignal.timeout(3000) })
  ).json();
  const r = await fetch(base + "codex/check", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-bridge-token": boot.csrf,
    },
    body: "{}",
    signal: AbortSignal.timeout(5000),
  });
  const data = await r.json();
  report.account = r.ok
    ? {
        checkedAt: new Date().toISOString(),
        connected: data.connected,
        accountType: data.accountType,
        requiresOpenaiAuth: data.requiresOpenaiAuth,
      }
    : { available: false };
} catch {
  report.account = { available: false };
}
mkdirSync("test-output", { recursive: true });
writeFileSync(
  "test-output/robinson-runtime-audit.json",
  JSON.stringify(report, null, 2) + "\n",
);
console.log(JSON.stringify(report, null, 2));
