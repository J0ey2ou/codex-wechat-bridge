import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { Delivery, Task } from "../src/app/types.js";

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function complete(
  f: Fixture,
  taskId: string,
  result?: Record<string, unknown>,
  status = "completed",
  error?: string,
) {
  const current = f.store.get<Task>("tasks", taskId)!;
  if (result) {
    f.codex.emit("item/completed", {
      threadId: current.threadId,
      turnId: current.turnId,
      item: {
        type: "agentMessage",
        id: `result-${current.turnId}`,
        text: JSON.stringify(result),
      },
    });
  }
  f.codex.emit("turn/completed", {
    threadId: current.threadId,
    turn: {
      id: current.turnId,
      status,
      ...(error ? { error: { message: error } } : {}),
    },
  });
  await f.tasks.drained();
  await f.questions.drained();
  return f.store.get<Task>("tasks", taskId)!;
}

function finished(f: Fixture, taskId: string) {
  const deliveries = f.store
    .all<Delivery>("notification_deliveries")
    .filter((delivery) => delivery.dedupeKey === `finished:${taskId}`);
  assert.equal(deliveries.length, 1, "one final notification per task");
  return deliveries[0]!;
}

const technical = {
  summary:
    "Patched D:\\workspace\\src\\main.ts; command exit code 0; technical verification complete.",
  files: ["D:\\workspace\\src\\main.ts", "D:\\workspace\\tests\\main.test.ts"],
  tests: [
    "node --test tests/main.test.ts: exit code 0",
    "npm run build: exit code 0",
  ],
  next: "Review D:\\workspace\\dist\\main.js before deployment.",
};

test("completed tasks send friendly user text while retaining technical details in task storage", async () => {
  const f = await fixture();
  const task = f.tasks.create(f.project.id, "修好列表显示");
  await f.tasks.pump();
  const start = f.codex.calls.find((call) => call.method === "turn/start")!;
  assert.ok(start.params.outputSchema.required.includes("userMessage"));
  assert.equal(start.params.outputSchema.properties.userMessage.type, "string");
  const friendly =
    "列表显示已经修好，重复的项目不会再出现。修改已检查通过，服务还没有重启，重启后才能使用新效果。";
  const current = await complete(f, task.id, {
    ...technical,
    userMessage: friendly,
  });
  const notice = finished(f, task.id);
  assert.equal(current.status, "COMPLETED");
  assert.equal(current.userMessage, friendly);
  assert.equal(
    current.summary,
    `${technical.summary}\n建议：${technical.next}`,
  );
  assert.deepEqual(current.files, technical.files);
  assert.deepEqual(current.tests, technical.tests);
  assert.ok(notice.text.includes(friendly));
  assert.doesNotMatch(
    notice.text,
    /D:\\|main\.ts|main\.test|dist\\|exit code|COMPLETED|耗时|主要文件|验证：|npm run build|node --test/,
  );
  assert.ok(
    notice.text.includes("还没有重启"),
    "user-relevant incomplete deployment is preserved",
  );
});

test("a later stage clears the previous friendly message and never sends it as the final result", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  const task = f.tasks.create(f.project.id, "分两步整理", [
    {
      title: "第一步",
      prompt: "第一步整理",
      requiresApproval: false,
      lowRisk: false,
    },
    {
      title: "第二步",
      prompt: "第二步检查",
      requiresApproval: false,
      lowRisk: false,
    },
  ]);
  await f.tasks.pump();
  const oldMessage = "第一步已经整理完成，接着检查第二步。";
  const first = await complete(f, task.id, {
    ...technical,
    userMessage: oldMessage,
  });
  assert.equal(first.status, "QUEUED");
  assert.equal(first.userMessage, oldMessage);
  assert.equal(
    f.store
      .all<Delivery>("notification_deliveries")
      .filter((delivery) => delivery.dedupeKey === `finished:${task.id}`)
      .length,
    0,
  );
  await f.tasks.pump();
  assert.equal(f.store.get<Task>("tasks", task.id)!.userMessage, undefined);
  const final = await complete(f, task.id, {
    summary: "Second stage checked D:\\workspace\\results.json; exit code 0.",
    userMessage: "",
    files: [],
    tests: ["second-stage check: exit code 0"],
    next: "",
  });
  assert.equal(final.status, "COMPLETED");
  assert.equal(final.userMessage, undefined);
  assert.ok(final.summary!.includes("Second stage"));
  assert.ok(final.tests.includes("second-stage check: exit code 0"));
  const notice = finished(f, task.id);
  assert.ok(notice.text.trim());
  assert.ok(!notice.text.includes(oldMessage));
  assert.doesNotMatch(notice.text, /D:\\|exit code|COMPLETED|耗时/);
});

test("a failed later stage reports failure instead of reusing a prior stage success message", async () => {
  const f = await fixture();
  f.config.executionAuthorization = "bound-user";
  const task = f.tasks.create(f.project.id, "修改并发布", [
    {
      title: "修改",
      prompt: "完成修改",
      requiresApproval: false,
      lowRisk: false,
    },
    {
      title: "发布",
      prompt: "发布修改",
      requiresApproval: false,
      lowRisk: false,
    },
  ]);
  await f.tasks.pump();
  const oldMessage = "修改已经完成，检查也通过了。";
  await complete(f, task.id, { ...technical, userMessage: oldMessage });
  await f.tasks.pump();
  const failure = "Deploy D:\\workspace\\dist\\main.js failed: exit code 23";
  const current = await complete(f, task.id, undefined, "failed", failure);
  assert.equal(current.status, "FAILED");
  assert.equal(current.userMessage, undefined);
  assert.equal(current.error, failure);
  assert.deepEqual(current.files, technical.files);
  assert.deepEqual(current.tests, technical.tests);
  const notice = finished(f, task.id);
  assert.ok(!notice.text.includes(oldMessage));
  assert.match(notice.text, /未完成|没完成|没能|失败|未能/);
  assert.doesNotMatch(notice.text, /D:\\|exit code|COMPLETED|FAILED|耗时/);
});

test("a failed model turn cannot publish its optimistic success text as a completed result", async () => {
  const f = await fixture();
  const task = f.tasks.create(f.project.id, "发布新版本");
  await f.tasks.pump();
  const premature = "新版本已经全部发布，现在就能使用。";
  const current = await complete(
    f,
    task.id,
    { ...technical, userMessage: premature },
    "failed",
    "deployment connection closed",
  );
  assert.equal(current.status, "FAILED");
  const notice = finished(f, task.id);
  assert.ok(!notice.text.includes(premature));
  assert.match(notice.text, /未完成|没完成|没能|失败|未能/);
  assert.doesNotMatch(notice.text, /COMPLETED|FAILED|耗时|D:\\|exit code/);
});
