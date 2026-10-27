import type { Delivery, StoredMessage } from "../app/types.js";
import type { Question } from "../codex/questions.js";
import type { Store } from "../storage/store.js";

export function distribution(values: number[]) {
  const data = values
    .filter((v) => Number.isFinite(v) && v >= 0)
    .sort((a, b) => a - b);
  return {
    samples: data.length,
    medianMs: data.length
      ? (data[Math.floor((data.length - 1) / 2)]! +
          data[Math.floor(data.length / 2)]!) /
        2
      : null,
    p95Ms: data.length ? data[Math.ceil(data.length * 0.95) - 1] : null,
  };
}
export function messageLatency(store: Store) {
  const owner = store.setting("boundUser", "");
  const messages = store
    .all<StoredMessage>("messages")
    .filter((m) => m.userId === owner)
    .slice(0, 200);
  const questions = store
    .all<Question>("questions")
    .filter((q) => q.userId === owner)
    .slice(0, 200);
  const deliveries = store
    .all<Delivery>("notification_deliveries")
    .filter((d) => d.userId === owner)
    .slice(0, 500);
  const delta = (end?: number, start?: number) =>
    end !== undefined && start !== undefined ? end - start : NaN;
  return {
    measuredAt: Date.now(),
    note: "毫秒；仅统计当前绑定用户有成对时间戳的样本。发送确认只代表服务端响应，不代表手机已显示。缺失数据不估算。",
    ingress: distribution(
      messages.map((m) => delta(m.receivedAt, m.transportReceivedAt)),
    ),
    routing: distribution(messages.map((m) => delta(m.routedAt, m.receivedAt))),
    queue: distribution(questions.map((q) => delta(q.startedAt, q.createdAt))),
    preparation: distribution(
      questions.map((q) => delta(q.preparedAt, q.startedAt)),
    ),
    modelRound: distribution(
      questions.flatMap((q) =>
        (q.turnTimings ?? []).map((r) => delta(r.completedAt, r.startedAt)),
      ),
    ),
    dispatch: distribution(
      questions.map((q) => delta(q.endedAt, q.decisionAt)),
    ),
    sendQueue: distribution(
      deliveries.map((d) => delta(d.sendStartedAt, d.createdAt)),
    ),
    sendRequest: distribution(
      deliveries.map((d) => delta(d.sendFinishedAt, d.sendStartedAt)),
    ),
    receipt: distribution(
      deliveries
        .filter((d) => d.receipt && d.sendStartedAt)
        .map((d) => {
          const m = messages.find((m) => m.id === d.messageId);
          return delta(d.sendStartedAt, m?.receivedAt);
        }),
    ),
  };
}
