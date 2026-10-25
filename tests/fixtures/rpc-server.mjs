import { createInterface } from "node:readline";
const send = (m) => process.stdout.write(JSON.stringify(m) + "\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.id === undefined) return;
  if (m.method === "hang") return;
  if (m.method === "drop") {
    process.exit(0);
  }
  if (m.method === "initialize")
    send({ id: m.id, result: { userAgent: "fixture" } });
  else if (m.method === "thread/start")
    send({ id: m.id, result: { thread: { id: "thread-test" } } });
  else if (m.method === "turn/start") {
    send({ id: m.id, result: { turn: { id: "turn-test" } } });
    send({
      method: "item/started",
      params: {
        threadId: "thread-test",
        turnId: "turn-test",
        item: { type: "commandExecution", id: "item" },
      },
    });
  } else send({ id: m.id, result: { ok: true } });
});
