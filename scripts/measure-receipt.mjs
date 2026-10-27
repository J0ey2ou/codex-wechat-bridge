// Isolated mock-channel timing only. Never connects to WeChat or a real model.
import { fixture } from "../dist/tests/helpers.js";
import { distribution } from "../dist/src/notifications/latency.js";

const samples = [];
for (let i = 0; i < 5; i++) {
  const f = await fixture();
  f.notices.start();
  const started = Date.now();
  try {
    await f.router.receive({
      id: `timing-${i}`,
      userId: "owner",
      text: "请帮我优化项目里的通知功能",
      kind: "direct",
      sentAt: started,
    });
    await f.questions.pump(); // The mock turn remains unfinished throughout the measurement.
    while (!f.channel.sent.length && Date.now() - started < 3000)
      await new Promise((resolve) => setTimeout(resolve, 10));
    const receipt = f.store
      .all("notification_deliveries")
      .find((d) => d.receipt);
    if (!receipt?.sendStartedAt || f.channel.sent.length !== 1)
      throw new Error("Receipt timing check failed");
    samples.push(receipt.sendStartedAt - started);
  } finally {
    f.notices.stop();
    await f.codex.disconnect();
    await f.questions.drained();
    f.store.close();
  }
}
console.log(
  JSON.stringify(
    {
      mode: "mock-channel-local-clock",
      delayThresholdMs: 800,
      samplesMs: samples,
      ...distribution(samples),
      phoneVisibility: "not measured",
      realModelSpeedup: "not measured",
    },
    null,
    2,
  ),
);
