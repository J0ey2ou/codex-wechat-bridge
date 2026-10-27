import test from "node:test";
import assert from "node:assert/strict";
import { fixture } from "./helpers.js";
import type { Question } from "../src/codex/questions.js";
import type { Intent } from "../src/app/intent.js";

function decision(values: Partial<Intent>): Intent {
  return {
    action: "answer",
    reply: "回答",
    computer: null,
    projectId: null,
    taskId: null,
    todoId: null,
    approvalId: null,
    text: null,
    date: null,
    repeatMinutes: null,
    newProject: null,
    ...values,
  };
}

function deferTurnStart(f: Awaited<ReturnType<typeof fixture>>) {
  const original = f.codex.request.bind(f.codex);
  let entered!: () => void;
  let release!: (value: { turn: { id: string; status: string } }) => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const response = new Promise<{ turn: { id: string; status: string } }>(
    (resolve) => {
      release = resolve;
    },
  );
  f.codex.request = async <T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    if (method !== "turn/start") return original<T>(method, params);
    entered();
    return (await response) as T;
  };
  return { started, release };
}

function complete(
  f: Awaited<ReturnType<typeof fixture>>,
  threadId: string,
  turnId: string,
  value: Intent,
) {
  f.codex.emit("item/completed", {
    threadId,
    turnId,
    item: { type: "agentMessage", text: JSON.stringify(value) },
  });
  f.codex.emit("turn/completed", {
    threadId,
    turn: { id: turnId, status: "completed" },
  });
}

test("a previous turn replay during the next turn/start RPC cannot repeat its side effect", async () => {
  const f = await fixture();
  const originalDecision = decision({
    action: "run",
    projectId: f.project.id,
    text: "检查项目",
  });
  f.questions.enqueue("检查项目", "owner", "first");
  const previous = await f.decide("first", originalDecision);
  assert.equal(f.tasks.tasks().length, 1);

  const deferred = deferTurnStart(f);
  f.questions.enqueue("列出项目", "owner", "second");
  const pump = f.questions.pump();
  await deferred.started;
  try {
    complete(f, previous.threadId!, previous.turnId!, originalDecision);
    await f.questions.drained();
    assert.equal(
      f.tasks.tasks().length,
      1,
      "the old run decision must not execute again",
    );
    assert.equal(
      f.store.get<Question>("questions", "second")?.status,
      "running",
    );
  } finally {
    deferred.release({
      turn: { id: "second-real-turn", status: "inProgress" },
    });
    await pump;
    await f.questions.drained();
  }

  assert.equal(
    f.tasks.tasks().length,
    1,
    "old buffered events must be discarded after the RPC reply",
  );
  complete(
    f,
    previous.threadId!,
    "second-real-turn",
    decision({ reply: "这是当前项目列表。" }),
  );
  await f.questions.drained();
  assert.equal(
    f.store.get<Question>("questions", "second")?.answer,
    "这是当前项目列表。",
  );
  assert.equal(f.tasks.tasks().length, 1);
});

test("genuine new-turn events arriving before the turn/start RPC reply are retained and handled once", async () => {
  const f = await fixture();
  const deferred = deferTurnStart(f);
  f.questions.enqueue("回答这个问题", "owner", "early");
  const pump = f.questions.pump();
  await deferred.started;
  const pending = f.store.get<Question>("questions", "early")!;
  const result = decision({ reply: "这是新一轮的真实回答。" });
  try {
    f.codex.emit("turn/started", {
      threadId: pending.threadId,
      turn: { id: "early-real-turn", status: "inProgress" },
    });
    complete(f, pending.threadId!, "early-real-turn", result);
    await f.questions.drained();
    assert.equal(
      f.store.get<Question>("questions", "early")?.status,
      "running",
      "wait for the RPC to establish the authoritative turn ID",
    );
  } finally {
    deferred.release({ turn: { id: "early-real-turn", status: "inProgress" } });
    await pump;
    await f.questions.drained();
  }

  const finished = f.store.get<Question>("questions", "early")!;
  assert.equal(finished.status, "completed");
  assert.equal(finished.turnId, "early-real-turn");
  assert.equal(finished.answer, result.reply);
  complete(f, pending.threadId!, "early-real-turn", result);
  await f.questions.drained();
  assert.equal(f.store.all("notification_deliveries").length, 1);
});
