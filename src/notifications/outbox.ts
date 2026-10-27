import { randomUUID } from "node:crypto";
import { replyLayout, type ReplyLayout } from "../app/dialogue.js";
import type { Delivery, WeChatAdapter } from "../app/types.js";
import { Store } from "../storage/store.js";
import { safeText } from "../security/policy.js";
import { DeliveryUncertainError } from "../channels/wechat/ilink.js";
import {
  notificationPresentation,
  PRESENTATION_REVISION,
  receiptText,
  RECEIPT_DELAY_MS,
  RECEIPT_TTL_MS,
} from "./presentation.js";
type DeliveryOptions = Pick<
  Delivery,
  | "messageId"
  | "receipt"
  | "backendOnly"
  | "detailText"
  | "layout"
  | "documentId"
> & { availableAt?: number };
export class NotificationManager {
  documentReader?: (
    id: string,
    userId: string,
  ) => { name: string; bytes: Buffer };
  private busy = false;
  private wake?: NodeJS.Timeout;
  private wakeAt = Infinity;
  private automatic = false;
  constructor(
    private store: Store,
    private channel: WeChatAdapter,
    private defaultEnabled = true,
  ) {}
  start() {
    this.automatic = true;
    this.kick();
  }
  stop() {
    this.automatic = false;
    clearTimeout(this.wake);
    this.wake = undefined;
    this.wakeAt = Infinity;
  }
  private kick(delay = 0) {
    if (!this.automatic || (this.wake && this.wakeAt <= Date.now() + delay))
      return;
    clearTimeout(this.wake);
    this.wakeAt = Date.now() + delay;
    // Leave any caller's SQLite transaction before starting asynchronous delivery.
    this.wake = setTimeout(() => {
      this.wake = undefined;
      this.wakeAt = Infinity;
      void this.flush().catch((error) =>
        this.store.setSetting("lastSendError", safeText(String(error))),
      );
    }, delay);
    this.wake.unref();
  }
  scheduleReceipt(messageId: string, userId: string, receivedAt = Date.now()) {
    if (userId !== this.store.setting("boundUser", "")) return;
    const all = this.store.all<Delivery>("notification_deliveries");
    if (
      all.some(
        (d) => d.userId === userId && d.dedupeKey === `receipt:${messageId}`,
      )
    )
      return;
    for (const d of all)
      if (
        d.userId === userId &&
        d.receipt &&
        ["pending", "retry"].includes(d.status)
      ) {
        d.status = "cancelled";
        d.error = "新消息合并接收回执";
        this.store.put("notification_deliveries", d);
      }
    if (
      all.some(
        (d) =>
          d.userId === userId &&
          d.receipt &&
          ["sending", "server_accepted", "delivery_unverified"].includes(
            d.status,
          ) &&
          Date.now() - (d.sendStartedAt ?? d.createdAt) < 8000,
      )
    )
      return;
    const index = this.store.setting<number>(`receipt-variant:${userId}`, 0);
    this.store.setSetting(`receipt-variant:${userId}`, index + 1);
    this.enqueue(
      receiptText(index),
      `receipt:${messageId}`,
      userId,
      "reply",
      undefined,
      { messageId, receipt: true, availableAt: receivedAt + RECEIPT_DELAY_MS },
    );
  }
  reply(
    text: string,
    key: string,
    userId: string,
    messageId: string,
    acknowledgementOnly = false,
  ) {
    const receipts = this.store
      .all<Delivery>("notification_deliveries")
      .filter(
        (d) => d.userId === userId && d.messageId === messageId && d.receipt,
      );
    const alreadyAcknowledged =
      receipts.some((d) =>
        ["sending", "server_accepted", "delivery_unverified"].includes(
          d.status,
        ),
      ) ||
      this.store
        .all<Delivery>("notification_deliveries")
        .some(
          (d) =>
            d.userId === userId &&
            d.messageId === messageId &&
            !this.isReply(d) &&
            !d.backendOnly,
        );
    const pendingReceipt = receipts.find((d) =>
      ["pending", "retry"].includes(d.status),
    );
    for (const d of receipts)
      if (["pending", "retry"].includes(d.status)) {
        d.status = "cancelled";
        d.error = "已有正式回应，取消延迟回执";
        this.store.put("notification_deliveries", d);
      }
    // Only action-only acknowledgements may use receipt wording. Never replace
    // a real answer or clarification with a generic confirmation.
    if (acknowledgementOnly && !alreadyAcknowledged) {
      if (pendingReceipt) text = pendingReceipt.text;
      else {
        const index = this.store.setting<number>(
          `receipt-variant:${userId}`,
          0,
        );
        this.store.setSetting(`receipt-variant:${userId}`, index + 1);
        text = receiptText(index);
      }
    }
    return this.enqueue(text, key, userId, "reply", undefined, {
      messageId,
      backendOnly: acknowledgementOnly && alreadyAcknowledged,
    });
  }
  isPushEnabled(): boolean {
    const preferences = this.store.setting<Record<string, unknown>>(
      "preferences",
      {},
    );
    return typeof preferences.wechatPushEnabled === "boolean"
      ? preferences.wechatPushEnabled
      : this.defaultEnabled;
  }
  private epoch(): number {
    const epoch = this.store.setting("wechatPushMuteEpoch", 0);
    return Number.isSafeInteger(epoch) && epoch >= 0 ? epoch : 0;
  }
  private isReply(delivery: Delivery): boolean {
    return (
      delivery.kind === "reply" ||
      (delivery.kind === undefined &&
        /^(?:answer|reply):/.test(delivery.dedupeKey))
    );
  }
  private requestLayout(
    messageId: string | undefined,
    userId: string,
  ): ReplyLayout {
    if (!messageId) return "paragraph";
    for (const table of ["messages", "questions"] as const) {
      const request = this.store.get<{ userId: string; text?: string }>(
        table,
        messageId,
      );
      if (request?.userId === userId && request.text)
        return replyLayout(request.text);
    }
    return "paragraph";
  }
  private shouldSuppress(delivery: Delivery): boolean {
    return (
      delivery.backendOnly === true ||
      (!this.isReply(delivery) &&
        (!this.isPushEnabled() ||
          (delivery.notificationEpoch ?? 0) < this.epoch() ||
          (delivery.occurredAt !== undefined &&
            delivery.occurredAt <
              this.store.setting("wechatPushResumedAt", 0))))
    );
  }
  private suppress(delivery: Delivery) {
    delivery.status = "suppressed";
    delivery.suppressedAt = Date.now();
    delivery.error =
      (delivery.backendOnly
        ? "详细进度或重复回执仅留在软件后台。"
        : "微信主动推送已关闭，此通知不再投递。") +
      (delivery.error ? `先前投递原因：${safeText(delivery.error, 300)}` : "");
    this.store.put("notification_deliveries", delivery);
  }
  private suppressPending() {
    for (const delivery of this.store.all<Delivery>("notification_deliveries"))
      if (
        ["pending", "retry"].includes(delivery.status) &&
        this.shouldSuppress(delivery)
      )
        this.suppress(delivery);
  }
  setPushEnabled(enabled: boolean): void {
    if (typeof enabled !== "boolean")
      throw new Error("微信推送开关必须为布尔值");
    this.store.transaction(() => {
      this.store.setSetting("preferences", {
        ...this.store.setting("preferences", {}),
        wechatPushEnabled: enabled,
      });
      // A delivery started before muting must not become a retry after a quick re-enable.
      if (!enabled)
        this.store.setSetting("wechatPushMuteEpoch", this.epoch() + 1);
      else
        // A later scan can discover a completion that happened while muted.
        this.store.setSetting("wechatPushResumedAt", Date.now());
      this.suppressPending();
    });
  }
  enqueue(
    text: string,
    key: string = randomUUID(),
    userId = this.store.setting<string | undefined>("boundUser", undefined),
    kind: "reply" | "notification" = "notification",
    occurredAt?: number,
    options: DeliveryOptions = {},
  ): string | undefined {
    if (!userId) return undefined;
    const existing = this.store
      .all<Delivery>("notification_deliveries")
      .find((d) => d.dedupeKey === key);
    if (existing) {
      if (
        ["pending", "retry"].includes(existing.status) &&
        this.shouldSuppress(existing)
      )
        this.suppress(existing);
      return existing.id;
    }
    const taskId = key.match(
      /^(?:finished|start-error|target-error|boundary-unknown|stale|timeout|model-mismatch|unsupported):([^:]+)/,
    )?.[1];
    const messageId =
      options.messageId ??
      (taskId
        ? this.store.get<{ sourceMessageId?: string }>("tasks", taskId)
            ?.sourceMessageId
        : key.match(/^(?:answer|reply):(.+)$/)?.[1]);
    const layout =
      options.layout ??
      (kind === "reply" ? this.requestLayout(messageId, userId) : "paragraph");
    const presented = notificationPresentation(text, key, layout);
    const sequence = this.store.setting<number>("deliverySequence", 0) + 1;
    this.store.setSetting("deliverySequence", sequence);
    const d: Delivery = {
      id: randomUUID(),
      userId,
      text: safeText(presented.text, 3500),
      detailText: safeText(options.detailText ?? text, 12000),
      backendOnly: options.backendOnly || presented.backendOnly,
      messageId,
      receipt: options.receipt,
      documentId: options.documentId,
      expiresAt: options.receipt ? Date.now() + RECEIPT_TTL_MS : undefined,
      sequence,
      policyRevision: PRESENTATION_REVISION,
      layout,
      kind,
      notificationEpoch: this.epoch(),
      occurredAt,
      status: "pending",
      attempts: 0,
      nextAttemptAt: options.availableAt ?? Date.now(),
      createdAt: Date.now(),
      clientVisible: false,
      dedupeKey: key,
    };
    if (this.shouldSuppress(d)) {
      d.status = "suppressed";
      d.suppressedAt = Date.now();
      d.error = d.backendOnly
        ? "详细进度或重复回执仅留在软件后台。"
        : "微信主动推送已关闭，此通知不再投递。";
    }
    this.store.insert("notification_deliveries", d);
    this.kick();
    return d.id;
  }
  recover() {
    for (const d of this.store.all<Delivery>("notification_deliveries"))
      if (d.status === "sending") {
        d.status = "delivery_unverified";
        d.error = "服务重启前已开始发送，结果未知，未自动重放";
        this.store.put("notification_deliveries", d);
      }
    for (const d of this.store.all<Delivery>("notification_deliveries"))
      if (d.receipt && ["pending", "retry"].includes(d.status)) {
        d.status = "cancelled";
        d.error = "重启后不补发过期接收回执";
        this.store.put("notification_deliveries", d);
      }
    this.suppressPending();
  }
  async flush(now = Date.now()) {
    if (this.busy) return;
    this.busy = true;
    try {
      this.suppressPending();
      const ds = this.store
        .all<Delivery>("notification_deliveries")
        .filter((d) => ["pending", "retry"].includes(d.status))
        .sort(
          (a, b) =>
            a.createdAt - b.createdAt || (a.sequence ?? 0) - (b.sequence ?? 0),
        );
      const blockedUsers = new Set<string>();
      let sent = 0;
      for (const queued of ds) {
        // Settings can change while an earlier channel call is awaiting its response.
        const d = this.store.get<Delivery>(
          "notification_deliveries",
          queued.id,
        );
        if (!d || !["pending", "retry"].includes(d.status)) continue;
        if (d.policyRevision !== PRESENTATION_REVISION) {
          d.messageId ??= d.dedupeKey.match(/^(?:answer|reply):(.+)$/)?.[1];
          d.layout ??= this.isReply(d)
            ? this.requestLayout(d.messageId, d.userId)
            : "paragraph";
          const presented = notificationPresentation(
            d.text,
            d.dedupeKey,
            d.layout,
            true,
          );
          d.detailText ??= d.text;
          d.text = presented.text;
          d.backendOnly ||= presented.backendOnly;
          d.policyRevision = PRESENTATION_REVISION;
          this.store.put("notification_deliveries", d);
        }
        if (d.userId !== this.store.setting("boundUser", "")) {
          d.status = "cancelled";
          d.error = "绑定用户已改变";
          this.store.put("notification_deliveries", d);
          continue;
        }
        if (this.shouldSuppress(d)) {
          this.suppress(d);
          continue;
        }
        if (d.receipt) {
          const question = this.store.get<{ status: string }>(
            "questions",
            d.messageId ?? "",
          );
          const reply = this.store
            .all<Delivery>("notification_deliveries")
            .some(
              (r) =>
                r.userId === d.userId &&
                !r.receipt &&
                r.messageId === d.messageId,
            );
          if (
            reply ||
            (question && ["completed", "failed"].includes(question.status)) ||
            now >= (d.expiresAt ?? 0)
          ) {
            d.status = "cancelled";
            d.error = "回应已生成或回执已过期";
            this.store.put("notification_deliveries", d);
            continue;
          }
        }
        if (blockedUsers.has(d.userId)) continue;
        if (d.nextAttemptAt > now) {
          if (!d.receipt) blockedUsers.add(d.userId);
          continue;
        }
        if (d.messageId && (!this.isReply(d) || d.documentId)) {
          const q = this.store.get<{ status: string }>(
            "questions",
            d.messageId,
          );
          if (q && !["completed", "failed"].includes(q.status)) continue;
          if (
            this.store
              .all<Delivery>("notification_deliveries")
              .some(
                (r) =>
                  r.userId === d.userId &&
                  r.id !== d.id &&
                  !r.documentId &&
                  r.messageId === d.messageId &&
                  !r.receipt &&
                  this.isReply(r) &&
                  ["pending", "retry", "sending"].includes(r.status),
              )
          )
            continue;
        }
        if (sent++ >= 20) break;
        d.status = "sending";
        d.attempts++;
        d.sendStartedAt = Date.now();
        this.store.put("notification_deliveries", d);
        try {
          const result = d.documentId
            ? await this.sendDocument(d)
            : await this.channel.sendMessage(d.userId, d.text, d.id);
          d.status = result.status;
          d.acceptedAt = Date.now();
          d.error = undefined;
        } catch (e) {
          d.error = safeText(e instanceof Error ? e.message : "发送失败");
          if (e instanceof DeliveryUncertainError)
            d.status = "delivery_unverified";
          else if (this.shouldSuppress(d)) this.suppress(d);
          else d.status = d.receipt || d.attempts >= 6 ? "failed" : "retry";
          d.nextAttemptAt = now + Math.min(300000, 1000 * 2 ** d.attempts);
          if (
            d.documentId &&
            ["failed", "delivery_unverified"].includes(d.status)
          )
            this.enqueue(
              d.status === "failed"
                ? "PDF 没能发出去，报告已留在软件里，可以下载。"
                : "PDF 已尝试发送，但暂时确认不了结果；软件里也能下载，先不重复发。",
              `pdf-problem:${d.id}`,
              d.userId,
              "reply",
            );
        }
        d.sendFinishedAt = Date.now();
        if (d.status === "retry") blockedUsers.add(d.userId);
        this.store.put("notification_deliveries", d);
      }
    } finally {
      this.busy = false;
      if (this.automatic) {
        const pending = this.store
          .all<Delivery>("notification_deliveries")
          .filter((d) => ["pending", "retry"].includes(d.status));
        if (pending.length)
          this.kick(
            Math.max(
              25,
              Math.min(
                500,
                Math.min(...pending.map((d) => d.nextAttemptAt)) - Date.now(),
              ),
            ),
          );
      }
    }
  }
  private async sendDocument(d: Delivery) {
    if (!this.channel.sendFile || !this.documentReader)
      throw new Error("当前微信通道不支持 PDF 文件发送");
    return this.channel.sendFile(
      d.userId,
      this.documentReader(d.documentId!, d.userId),
      d.id,
    );
  }
}
