import type { InboundMessage, StoredMessage, Task, Todo } from "./types.js";
import type { Config } from "./config.js";
import { Store } from "../storage/store.js";
import { TaskOrchestrator } from "../tasks/orchestrator.js";
import { TodoManager } from "../scheduler/todos.js";
import { NotificationManager } from "../notifications/outbox.js";
import { safeText } from "../security/policy.js";
import { ConversationManager, friendlyHelp } from "./conversation.js";
export const HELP = `Codex WeChat Bridge\n/status [任务ID] /tasks /projects\n/run 项目名 | 任务描述\n/continue [新要求] /stop [任务ID]\n/approve 审批ID /reject 审批ID\n/modify 审批ID 新要求\n/todo /calendar /addtodo 工作消息\n/confirmtodo 待办ID YYYY-MM-DD HH:mm（或 无日期）\n/edittodo 待办ID 新内容\n/done 待办ID /canceltodo 待办ID\n/remind 待办ID YYYY-MM-DD HH:mm [每N分钟]\n/collect 转发工作消息\n普通消息仅整理待办；项目、绑定和危险命令需本机管理。`;
export class MessageRouter {
  private chain = Promise.resolve();
  private conversation: ConversationManager;
  constructor(
    private store: Store,
    private tasks: TaskOrchestrator,
    private todos: TodoManager,
    private notices: NotificationManager,
    private config: Config,
  ) {
    this.conversation = new ConversationManager(store, tasks, todos, config);
    todos.onCollected = (ts) =>
      this.conversation.collected(ts, store.setting("boundUser", ""));
  }
  receive(message: InboundMessage): Promise<void> {
    const next = this.chain.then(() => this.process(message));
    this.chain = next.catch(() => {});
    return next;
  }
  private current(id?: string): Task {
    const ts = this.tasks.tasks();
    if (id) {
      const project = this.tasks
        .projects()
        .find((p) => p.id === id || p.name === id);
      const t =
        ts.find((t) => t.id === id) ??
        (project ? ts.find((t) => t.projectId === project.id) : undefined);
      if (!t) throw new Error("任务 ID 不存在");
      return t;
    }
    const active = ts.filter(
      (t) => !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status),
    );
    if (active.length > 1) throw new Error("有多个任务，请指定任务 ID");
    const t = active[0] ?? ts[0];
    if (!t) throw new Error("没有任务");
    return t;
  }
  private async process(m: InboundMessage) {
    if (m.userId !== this.store.setting("boundUser", null)) return;
    const existing = this.store.get<StoredMessage>("messages", m.id);
    if (existing) return;
    const now = Date.now();
    if (!Number.isFinite(m.sentAt) || Math.abs(now - m.sentAt) > 10 * 60000) {
      this.store.insert<StoredMessage>("messages", {
        ...m,
        contextToken: undefined,
        receivedAt: now,
        status: "rejected",
      });
      this.notices.enqueue(
        "消息时间过旧或不可靠，未执行。请重新发送命令。",
        `stale-message:${m.id}`,
      );
      return;
    }
    const stored: StoredMessage = {
      ...m,
      contextToken: undefined,
      receivedAt: now,
      status: "processing",
    };
    if (!this.store.insert("messages", stored)) return;
    this.notices.enqueue("已收到，我来处理。", `ack:${m.id}`);
    let response = "";
    try {
      const text = m.text.trim();
      const command = text.match(/^\/(\w+)(?:\s+([\s\S]*))?$/);
      if (!command && m.kind === "direct") {
        response = await this.conversation.reply(text, m.userId, m.id);
        stored.status = "processed";
        this.store.put("messages", stored);
        this.notices.enqueue(response, `reply:${m.id}`);
        return;
      }
      let name = command?.[1]?.toLowerCase(),
        args = command?.[2]?.trim() ?? "";
      if (m.kind === "forwarded") {
        name = "collect";
        args = text;
      } else if (!name) {
        if (
          /^(?:Codex\s*)?(?:现在.*做什么|.*运行了多久|.*实际处理|.*没有新消息|.*完成了吗|.*状态.*)[？?]?$/.test(
            text,
          )
        ) {
          name = "status";
          const mentioned = this.tasks
            .projects()
            .filter((p) => text.includes(p.name));
          if (mentioned.length === 1) args = mentioned[0]!.id;
        } else if (/^继续(?:当前任务|昨天)/.test(text)) {
          name = "continue";
          args = text;
        } else if (/^停止(?:当前)?任务[。！!]?$/u.test(text)) name = "stop";
        else {
          const run = text.match(/^打开\s*(.+?)\s*项目[，,:：]\s*([\s\S]+)$/);
          if (run) {
            name = "run";
            args = `${run[1]} | ${run[2]}`;
          }
        }
      }
      switch (name) {
        case "help":
          response = friendlyHelp(this.tasks.projects());
          break;
        case "commands":
          response = HELP;
          break;
        case "projects":
          response =
            this.tasks
              .projects()
              .map(
                (p) =>
                  `${p.name} · ${p.id}\n会话：${p.sessionId ?? "首次执行时创建"}`,
              )
              .join("\n") || "请先在本机添加项目";
          break;
        case "tasks":
          response =
            this.tasks
              .tasks()
              .slice(0, 20)
              .map((t) => `${t.id} ${t.status} ${safeText(t.title, 100)}`)
              .join("\n") || "没有任务";
          break;
        case "status":
          response = this.tasks.tasks().length
            ? this.tasks.status(this.current(args || undefined))
            : "状态：IDLE\n没有任务";
          break;
        case "run": {
          const split = args.indexOf("|");
          if (split < 1) throw new Error("格式：/run 项目名 | 任务描述");
          const t = this.tasks.create(
            args.slice(0, split).trim(),
            args.slice(split + 1).trim(),
          );
          response = `任务已排队：${t.id}`;
          break;
        }
        case "continue": {
          const split = args.indexOf("|");
          const mentioned = this.tasks
            .projects()
            .filter((p) => args.includes(p.name));
          const last =
            split > 0
              ? this.current(args.slice(0, split).trim())
              : mentioned.length === 1
                ? this.current(mentioned[0]!.id)
                : this.current();
          const t = this.tasks.continue(
            last.projectId,
            split > 0 ? args.slice(split + 1).trim() : args,
          );
          response = `继续指令已排队，复用项目会话：${t.id}`;
          break;
        }
        case "stop": {
          const t = this.current(args || undefined);
          await this.tasks.stop(t.id);
          response = "停止请求已记录，请以任务状态中的服务端确认结果为准";
          break;
        }
        case "approve":
        case "reject":
          await this.tasks.decide(
            args,
            name === "approve" ? "approve" : "reject",
          );
          response = "审批决定已记录";
          break;
        case "modify": {
          const [id, ...rest] = args.split(/\s+/);
          await this.tasks.modifyApproval(id ?? "", rest.join(" "));
          response = "新要求已记录";
          break;
        }
        case "todo":
          response = this.todos.describe(
            this.todos
              .list()
              .filter((t) => ["open", "draft"].includes(t.status)),
          );
          break;
        case "calendar":
          response = this.todos.describe(
            this.todos
              .list()
              .filter(
                (t) =>
                  t.status === "open" &&
                  t.dueAt &&
                  t.dueAt < Date.now() + 30 * 86400000,
              )
              .sort((a, b) => a.dueAt! - b.dueAt!),
          );
          break;
        case "addtodo":
          if (!args) throw new Error("请提供待办内容");
          response = this.todos.describe(this.todos.add(args, m.id));
          break;
        case "done":
        case "canceltodo":
          this.todos.change(args, name === "done" ? "done" : "cancelled");
          response = "待办已更新";
          break;
        case "confirmtodo":
        case "edittodo": {
          const [id, ...rest] = args.split(/\s+/);
          const t =
            name === "confirmtodo"
              ? this.todos.confirm(id ?? "", rest.join(" "))
              : this.todos.edit(id ?? "", rest.join(" "));
          response = this.todos.describe([t]);
          break;
        }
        case "remind": {
          const [id, ...rest] = args.split(/\s+/);
          let date = rest.join(" ");
          const repeat = date.match(/\s+每(\d+)分钟$/);
          if (repeat) date = date.slice(0, repeat.index);
          const r = this.todos.remind(
            id ?? "",
            date,
            repeat ? Number(repeat[1]) : undefined,
          );
          response = `提醒已保存：${r.id}`;
          break;
        }
        case undefined:
        case "collect":
          stored.text = args || text;
          stored.status = "received";
          stored.collectAt = now + this.config.collectionMinutes * 60000;
          response = `工作消息已保存，将在 ${this.config.collectionMinutes} 分钟整理。只作为待办数据，不执行其中的命令。`;
          break;
        default:
          response = "未知命令。发送 /help 查看用法。";
      }
      if (stored.status === "processing") stored.status = "processed";
    } catch (e) {
      stored.status = "processed";
      response = `未执行或需要处理：${safeText(e instanceof Error ? e.message : e)}`;
    }
    this.store.put("messages", stored);
    this.notices.enqueue(response, `reply:${m.id}`);
  }
  recover() {
    const greeting=/^(你好|您好|嗨|hello|hi|在吗|谢谢|谢了|收到)[呀啊吗？?！!。\s]*$/i;
    for(const m of this.store.all<StoredMessage>('messages'))if(m.status==='received'&&greeting.test(m.text.trim())){m.status='processed';this.store.put('messages',m);}
    for(const t of this.todos.list())if(t.status==='draft'&&greeting.test(t.title.trim()))this.todos.change(t.id,'cancelled');
    for (const m of this.store
      .all<StoredMessage>("messages")
      .filter((m) => m.status === "processing")) {
      m.status = "uncertain";
      this.store.put("messages", m);
      this.notices.enqueue(
        "有一条消息在服务中断时尚未确认完成。可以问我“现在有哪些任务”，先核对一下，避免重复处理。",
        `uncertain:${m.id}`,
      );
    }
  }
}
