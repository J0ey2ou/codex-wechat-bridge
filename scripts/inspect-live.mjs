import { DatabaseSync } from "node:sqlite";
const base = process.env.BRIDGE_URL || "http://127.0.0.1:3210";
const boot = await (await fetch(base + "/api/bootstrap")).json();
const state = await (
  await fetch(base + "/api/state", { headers: { "X-Bridge-Token": boot.csrf } })
).json();
const db = new DatabaseSync("data/bridge.sqlite", { readOnly: true });
const messages = db
  .prepare("SELECT data FROM messages ORDER BY updated_at DESC LIMIT 10")
  .all()
  .map((r) => {
    const m = JSON.parse(r.data);
    return {
      kind: m.kind,
      command: m.text.match(/^\/\w+/)?.[0] ?? "natural-text",
      status: m.status,
      receivedAt: m.receivedAt,
    };
  });
db.close();
console.log(
  JSON.stringify(
    {
      connections: state.connections,
      bound: !!state.boundUser,
      messages,
      deliveries: state.deliveries.map((d) => ({
        status: d.status,
        attempts: d.attempts,
        error: d.error,
        createdAt: d.createdAt,
      })),
      tasks: state.tasks.map((t) => ({
        id: t.id,
        status: t.status,
        lastEvent: t.lastEvent,
      })),
    },
    null,
    2,
  ),
);
