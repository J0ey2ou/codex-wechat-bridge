import { randomBytes } from "node:crypto";
import type { Approval } from "../app/types.js";
import type { Store } from "../storage/store.js";
import type { NotificationManager } from "../notifications/outbox.js";
export class ApprovalManager {
  constructor(
    private store: Store,
    private notifications: NotificationManager,
    private minutes: () => number,
  ) {}
  create(
    input: Omit<Approval, "id" | "createdAt" | "expiresAt" | "status">,
  ): Approval {
    const a: Approval = {
      ...input,
      id: randomBytes(8).toString("hex"),
      createdAt: Date.now(),
      expiresAt: Date.now() + this.minutes() * 60000,
      status: "pending",
    };
    this.store.put("approvals", a);
    this.notifications.enqueue(
      `这一步需要你确认：\n${a.description}\n${a.risk}\n${!a.allowed ? "这项操作需要在电脑上处理。" : a.localOnly ? "请在电脑管理页检查后批准。" : `可以直接回复“确认继续 ${a.id}”或“拒绝 ${a.id}”。\n编号只用于避免批准错操作，不需要记住。`}`,
      `approval:${a.id}`,
    );
    return a;
  }
  claim(id: string, decision: "approve" | "reject", local: boolean): Approval {
    const a = this.store.get<Approval>("approvals", id);
    if (!a || a.status !== "pending")
      throw new Error("审批不存在、已处理或已过期");
    if (a.expiresAt <= Date.now()) {
      a.status = "expired";
      this.store.put("approvals", a);
      throw new Error("审批已过期");
    }
    if (decision === "approve" && (!a.allowed || (a.localOnly && !local)))
      throw new Error(a.localOnly ? "此操作需要本机审批" : "此操作不允许批准");
    a.status = "resolving";
    this.store.put("approvals", a);
    return a;
  }
  finish(a: Approval, accepted: boolean) {
    a.status = accepted ? "approved" : "rejected";
    this.store.put("approvals", a);
  }
  expireTask(taskId: string) {
    for (const a of this.store.all<Approval>("approvals"))
      if (a.taskId === taskId && ["pending", "resolving"].includes(a.status)) {
        a.status = "expired";
        this.store.put("approvals", a);
      }
  }
}
