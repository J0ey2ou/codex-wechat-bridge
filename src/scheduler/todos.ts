import { createHash, randomBytes } from "node:crypto";
import type { Delivery, Reminder, StoredMessage, Todo } from "../app/types.js";
import type { Config } from "../app/config.js";
import { Store } from "../storage/store.js";
import { NotificationManager } from "../notifications/outbox.js";
import { extractCandidates, parseDate } from "./dates.js";
const id = () => randomBytes(6).toString("hex");
export class TodoManager {
  onCollected?: (todos: Todo[]) => string;
  constructor(
    private store: Store,
    private notices: NotificationManager,
    private config: Config,
  ) {}
  list() {
    return this.store.all<Todo>("todos");
  }
  add(text: string, sourceId: string, now = Date.now()): Todo[] {
    const candidates = extractCandidates(text, this.config.timezone, now);
    const result: Todo[] = [];
    this.store.transaction(() => {
      for (const c of candidates) {
        if (!c.title) continue;
        const key = createHash("sha256")
          .update(
            c.title.replace(/\s+/g, "").toLowerCase() +
              "|" +
              (c.at ?? "undated"),
          )
          .digest("hex");
        const existing = this.list().find((t) => t.dedupeKey === key);
        if (existing) {
          result.push(existing);
          continue;
        }
        const t: Todo = {
          id: id(),
          title: c.title,
          status: c.ambiguity ? "draft" : "open",
          dueAt: c.at,
          sourceId,
          sourceText: text.slice(0, 12000),
          parsedAt: now,
          ambiguity: c.ambiguity,
          dedupeKey: key,
        };
        this.store.put("todos", t);
        if (t.dueAt)
          this.store.put<Reminder>("reminders", {
            id: id(),
            todoId: t.id,
            dueAt: t.dueAt,
            status: "scheduled",
          });
        result.push(t);
      }
    });
    return result;
  }
  describe(ts: Todo[]): string {
    return (
      ts
        .map(
          (t) =>
            `${t.status === "draft" ? "待确认" : "待办"} ${t.id}：${t.title}\n${t.dueAt ? new Date(t.dueAt).toLocaleString("zh-CN", { timeZone: this.config.timezone }) : (t.ambiguity ?? "无日期")}${t.status === "draft" ? `\n确认：/confirmtodo ${t.id} YYYY-MM-DD HH:mm（或 无日期）` : ""}`,
        )
        .join("\n\n") || "没有待办"
    );
  }
  change(id: string, status: "done" | "cancelled") {
    const t = this.store.get<Todo>("todos", id);
    if (!t) throw new Error("待办不存在");
    t.status = status;
    this.store.put("todos", t);
    this.cancelReminders(id);
    return t;
  }
  private cancelReminders(todoId: string) {
    for (const r of this.store
      .all<Reminder>("reminders")
      .filter((r) => r.todoId === todoId)) {
      r.status = "cancelled";
      this.store.put("reminders", r);
      for (const d of this.store
        .all<Delivery>("notification_deliveries")
        .filter((d) => d.dedupeKey.startsWith(`reminder:${r.id}:`))) {
        if (["pending", "retry"].includes(d.status)) {
          d.status = "cancelled";
          this.store.put("notification_deliveries", d);
        }
      }
    }
  }
  confirm(id: string, date: string) {
    const t = this.store.get<Todo>("todos", id);
    if (!t || !["draft", "open"].includes(t.status))
      throw new Error("待办不可修改");
    const d = date === "无日期" ? {} : parseDate(date, this.config.timezone);
    if ("ambiguity" in d && d.ambiguity) throw new Error(d.ambiguity);
    this.cancelReminders(id);
    t.dueAt = d.at;
    t.status = "open";
    t.ambiguity = undefined;
    this.store.put("todos", t);
    if (t.dueAt)
      this.store.put<Reminder>("reminders", {
        id: id + "-confirmed-" + Date.now(),
        todoId: id,
        dueAt: t.dueAt,
        status: "scheduled",
      });
    return t;
  }
  edit(todoId: string, text: string) {
    const t = this.store.get<Todo>("todos", todoId);
    if (!t || !["open", "draft"].includes(t.status))
      throw new Error("待办不可修改");
    const d = parseDate(text, this.config.timezone);
    this.cancelReminders(todoId);
    t.title = text;
    t.dueAt = d.at;
    t.ambiguity = d.ambiguity;
    t.status = d.ambiguity ? "draft" : "open";
    t.parsedAt = Date.now();
    this.store.put("todos", t);
    if (t.dueAt)
      this.store.put<Reminder>("reminders", {
        id: id(),
        todoId,
        dueAt: t.dueAt,
        status: "scheduled",
      });
    return t;
  }
  remind(todoId: string, date: string, repeatMinutes?: number) {
    const t = this.store.get<Todo>("todos", todoId);
    if (!t || t.status !== "open") throw new Error("请先确认一个未完成待办");
    const d = parseDate(date, this.config.timezone);
    if (!d.at) throw new Error(d.ambiguity ?? "缺少提醒时间");
    if (
      repeatMinutes !== undefined &&
      (!Number.isInteger(repeatMinutes) ||
        repeatMinutes < 1 ||
        repeatMinutes > 525600)
    )
      throw new Error("重复间隔必须是 1–525600 分钟");
    const r: Reminder = {
      id: id(),
      todoId,
      dueAt: d.at,
      status: "scheduled",
      repeatMinutes,
    };
    this.store.put("reminders", r);
    return r;
  }
  collect(now = Date.now()) {
    for (const m of this.store
      .all<StoredMessage>("messages")
      .filter(
        (m) =>
          m.userId === this.store.setting("boundUser", "") &&
          m.status === "received" &&
          m.collectAt !== undefined &&
          m.collectAt <= now,
      )) {
      const ts = this.add(m.text, m.id, m.receivedAt);
      m.status = "processed";
      this.store.put("messages", m);
      this.notices.enqueue(
        this.onCollected?.(ts) ?? this.describe(ts),
        `collected:${m.id}`,
      );
    }
  }
  tick(now = Date.now()) {
    for (const r of this.store
      .all<Reminder>("reminders")
      .filter((r) => r.status === "scheduled" && r.dueAt <= now)) {
      const t = this.store.get<Todo>("todos", r.todoId);
      if (!t || t.status !== "open") {
        r.status = "cancelled";
        this.store.put("reminders", r);
        continue;
      }
      this.store.transaction(() => {
        const deliveryId = this.notices.enqueue(
          `提醒：${t.title}\n完成后直接告诉我“这件事做完了”，或说出事情的名字。`,
          `reminder:${r.id}:${r.dueAt}`,
          undefined,
          "notification",
          r.dueAt,
        );
        if (!deliveryId) return;
        r.deliveryId = deliveryId;
        if (r.repeatMinutes) {
          const step = r.repeatMinutes * 60000;
          r.dueAt += Math.max(1, Math.floor((now - r.dueAt) / step) + 1) * step;
        } else r.status = "queued";
        this.store.put("reminders", r);
      });
    }
  }
}
