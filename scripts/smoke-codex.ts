import { AppServerClient, appServerArgs } from "../src/codex/client.js";
import { loadConfig } from "../src/app/config.js";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
const config = loadConfig();
const c = new AppServerClient(
  config.codexBin,
  appServerArgs(config.codexTransport),
);
const report: Record<string, unknown> = {
  startedAt: new Date().toISOString(),
  kind: "REAL_CODEX",
};
let threadId: string | undefined;
const finished = new Map<string, any>();
let events = 0;
const eventTypes = new Map<string, number>();
const errors: string[] = [];
const startup: unknown[] = [];
const started = new Set<string>();
c.onEvent((e) => {
  events++;
  eventTypes.set(e.method, (eventTypes.get(e.method) ?? 0) + 1);
  if (e.id !== undefined)
    c.reject(e.id, "Smoke test does not approve any tool operation");
  if (e.method === "turn/completed")
    finished.set(e.params.turn.id, e.params.turn);
  if (e.method === "turn/started") started.add(e.params.turn.id);
  if (e.method === "error")
    errors.push(String(e.params.error?.message ?? "error").slice(0, 600));
  if (e.method === "mcpServer/startupStatus/updated")
    startup.push({
      status: e.params.status,
      failureReason: e.params.failureReason,
    });
});
async function waitTurn(id: string) {
  const until = Date.now() + 45000;
  while (Date.now() < until) {
    if (finished.has(id)) return finished.get(id);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("turn completion timeout");
}
try {
  await c.connect();
  report.handshake = "PASS";
  try {
    const a = await c.request("account/read", { refreshToken: false });
    report.accountType = a.account?.type ?? null;
  } catch (e) {
    report.accountError = String(e); // Keep testing inference independently of account metadata availability.
  }
  const listed = await c.request("thread/list", { limit: 5 });
  report.listCount = listed.data.length;
  const r = await c.request("thread/start", {
    cwd: process.cwd(),
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "read-only",
    config: {
      "features.apps": false,
      "features.plugins": false,
      "features.shell_tool": false,
      web_search: "disabled",
    },
  });
  report.model = r.model;
  console.log(
    "thread/start:",
    JSON.stringify({ model: r.model, sandbox: r.sandbox?.type }),
  );
  threadId = r.thread.id;
  report.threadId = threadId;
  report.threadStart = "PASS";
  const turn = await c.request("turn/start", {
    effort: "low",
    threadId,
    input: [
      {
        type: "text",
        text: "This is an integration connectivity smoke test. Do not call any tools, do not inspect or change files. Reply exactly BRIDGE_OK.",
      },
    ],
    sandboxPolicy: { type: "readOnly", networkAccess: false },
  });
  console.log("turn/start:", JSON.stringify({ status: turn.turn.status }));
  try {
    report.firstTurn = (await waitTurn(turn.turn.id)).status;
  } catch {
    report.firstTurn = "TIMEOUT";
    await c.request("turn/interrupt", { threadId, turnId: turn.turn.id });
    report.firstInterrupt = (await waitTurn(turn.turn.id)).status;
  }
  await c.reconnect();
  report.reconnect = "PASS";
  await c.request("thread/resume", {
    threadId,
    cwd: process.cwd(),
    excludeTurns: true,
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: "read-only",
  });
  report.resume = "PASS";
  const t2 = await c.request("turn/start", {
    effort: "low",
    threadId,
    input: [
      {
        type: "text",
        text: "Connectivity cancellation test. Do not use tools or change files. Write a detailed explanation of arithmetic.",
      },
    ],
  });
  report.secondTurnResponse = { id: t2.turn.id, status: t2.turn.status };
  const deadline = Date.now() + 15000;
  while (
    !started.has(t2.turn.id) &&
    !finished.has(t2.turn.id) &&
    Date.now() < deadline
  )
    await new Promise((r) => setTimeout(r, 100));
  if (finished.has(t2.turn.id)) report.interrupt = "turn already finished";
  else {
    await c.request("turn/interrupt", { threadId, turnId: t2.turn.id });
    report.interrupt = (await waitTurn(t2.turn.id)).status;
  }
  report.eventCount = events;
  report.threadId = threadId;
} catch (e) {
  report.error = e instanceof Error ? e.message : String(e);
  process.exitCode = 1;
} finally {
  report.eventTypes = Object.fromEntries(eventTypes);
  report.errors = errors;
  report.mcpStartup = startup;
  if (report.firstTurn !== "completed") process.exitCode = 1;
  await c.disconnect();
  mkdirSync("test-output", { recursive: true });
  writeFileSync(
    path.join("test-output", "real-codex.json"),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report, null, 2));
}
