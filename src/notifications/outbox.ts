import { randomUUID } from "node:crypto";
import type { Delivery, WeChatAdapter } from "../app/types.js";
import { Store } from "../storage/store.js";
import { safeText } from "../security/policy.js";
import { DeliveryUncertainError } from "../channels/wechat/ilink.js";
export class NotificationManager {
  private busy = false;
  constructor(
    private store: Store,
    private channel: WeChatAdapter,
  ) {}
  enqueue(
    text: string,
    key: string = randomUUID(),
    userId = this.store.setting<string | undefined>("boundUser", undefined),
  ): string | undefined {
    if (!userId) return undefined;
    const existing = this.store
      .all<Delivery>("notification_deliveries")
      .find((d) => d.dedupeKey === key);
    if (existing) return existing.id;
    const d: Delivery = {
      id: randomUUID(),
      userId,
      text: safeText(text, 3500),
      status: "pending",
      attempts: 0,
      nextAttemptAt: Date.now(),
      createdAt: Date.now(),
      clientVisible: false,
      dedupeKey: key,
    };
    this.store.insert("notification_deliveries", d);
    return d.id;
  }
  recover() {
    for (const d of this.store.all<Delivery>("notification_deliveries"))
      if (d.status === "sending") {
        d.status = "delivery_unverified";
        d.error = "服务重启前已开始发送，结果未知，未自动重放";
        this.store.put("notification_deliveries", d);
      }
  }
  async flush(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      const ds = this.store
        .all<Delivery>("notification_deliveries")
        .filter(
          (d) =>
            ["pending", "retry"].includes(d.status) && d.nextAttemptAt <= now,
        )
        .sort((a, b) => a.createdAt - b.createdAt)
        .slice(0, 20);
      for (const d of ds) {
        if (d.userId !== this.store.setting("boundUser", "")) {
          d.status = "cancelled";
          d.error = "绑定用户已改变";
          this.store.put("notification_deliveries", d);
          continue;
        }
        d.status = "sending";
        d.attempts++;
        this.store.put("notification_deliveries", d);
        try {
          const result = await this.channel.sendMessage(d.userId, d.text, d.id);
          d.status = result.status;
          d.acceptedAt = Date.now();
          d.error = undefined;
        } catch (e) {
          d.error = safeText(e instanceof Error ? e.message : "发送失败");
          d.status =
            e instanceof DeliveryUncertainError
              ? "delivery_unverified"
              : d.attempts >= 6
                ? "failed"
                : "retry";
          d.nextAttemptAt = now + Math.min(300000, 1000 * 2 ** d.attempts);
        }
        this.store.put("notification_deliveries", d);
      }
    } finally {
      this.busy = false;
    }
  }
}
