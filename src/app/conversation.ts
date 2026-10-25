import type { Approval, Project, Reminder, Task, Todo } from "./types.js";
import type { Config } from "./config.js";
import { Store } from "../storage/store.js";
import { TaskOrchestrator } from "../tasks/orchestrator.js";
import { TodoManager } from "../scheduler/todos.js";
import { parseDate } from "../scheduler/dates.js";
type Pending =
  | { kind: "project"; text: string }
  | { kind: "todo_date"; ids: string[] }
  | {
      kind: "todo_pick";
      ids: string[];
      action: "done" | "cancel" | "date";
      date?: string;
    }
  | { kind: "clarify"; text: string };
interface Context {
  projectId?: string;
  taskId?: string;
  todoIds?: string[];
  pending?: Pending;
  updatedAt: number;
}
const labels: Record<Task["status"], string> = {
  QUEUED: "排队中",
  RUNNING: "处理中",
  WAITING_APPROVAL: "等你确认",
  WAITING_PROCESS: "等待外部程序",
  IDLE: "空闲",
  COMPLETED: "已完成",
  FAILED: "执行失败",
  INTERRUPTED: "已停止",
  UNKNOWN: "暂时无法确认",
};
export function friendlyHelp(projects: Project[]): string {
  return `直接像平时聊天一样告诉我就行，不用记指令。\n\n你可以说：\n“现在在忙什么？”\n“帮我检查${projects[0]?.name ?? "某个项目"}的代码有没有问题。”\n“继续刚才的任务，但不要删除原始文件。”\n“明天下午三点提醒我交报告。”\n“我还有哪些事没做？”\n“报告已经交了。”\n\n${projects.length ? "已接入：" + projects.map((p) => p.name).join("、") + "。" : "先在电脑的管理页添加要处理的项目，我就能帮你执行项目任务。"}\n需要确认时间或操作时，我会具体问你。`;
}
export class ConversationManager {
  constructor(
    private store: Store,
    private tasks: TaskOrchestrator,
    private todos: TodoManager,
    private config: Config,
  ) {}
  private save(userId: string, c: Context) {
    c.updatedAt = Date.now();
    this.store.setSetting(`conversation:${userId}`, c);
  }
  collected(ts: Todo[], userId: string): string {
    const c = this.store.setting<Context>(`conversation:${userId}`, {
      updatedAt: Date.now(),
    });
    c.todoIds = ts.map((t) => t.id);
    const draftIds = ts.filter((t) => t.status === "draft").map((t) => t.id);
    if (draftIds.length) {
      const previous = c.pending?.kind === "todo_date" ? c.pending.ids : [];
      c.pending = {
        kind: "todo_date",
        ids: [...new Set([...previous, ...draftIds])],
      };
      const firstId=c.pending.ids[0];
      const first = this.todos.list().find((t) => t.id === firstId)!;
      this.save(userId, c);
      return `工作消息已整理。\n${this.promptDate(first)}`;
    }
    this.save(userId, c);
    return this.listTodos(ts, c);
  }
  private date(at?: number) {
    return at
      ? new Date(at).toLocaleString("zh-CN", {
          timeZone: this.config.timezone,
          hour12: false,
        })
      : "还没定时间";
  }
  private listTodos(ts: Todo[], c: Context) {
    c.todoIds = ts.map((t) => t.id);
    return ts.length
      ? `还有 ${ts.length} 件事：\n${ts.map((t, i) => `${i + 1}. ${t.title}\n   ${t.status === "draft" ? "时间待确认" : this.date(t.dueAt)}`).join("\n")}\n\n做完后告诉我事情的名字，或说“第二件做完了”就行。`
      : "目前没有未完成的待办。新事情直接告诉我就行。";
  }
  private chooseProject(text: string, c: Context): Project | undefined {
    const ps = this.tasks.projects();
    const named = ps.filter((p) =>
      text.toLowerCase().includes(p.name.toLowerCase()),
    );
    if (named.length === 1) return named[0];
    if (named.length > 1) return undefined;
    return (
      ps.find((p) => p.id === c.projectId) ??
      (ps.length === 1 ? ps[0] : undefined)
    );
  }
  private chooseTask(text: string, c: Context): Task | undefined {
    const named = this.tasks.projects().filter((p) => text.includes(p.name));
    const ts = this.tasks.tasks();
    if (named.length === 1) return ts.find((t) => t.projectId === named[0]!.id);
    const remembered = ts.find((t) => t.id === c.taskId);
    if (remembered) return remembered;
    const active = ts.filter(
      (t) => !["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status),
    );
    return active.length === 1
      ? active[0]
      : active.length === 0
        ? ts[0]
        : undefined;
  }
  private status(t?: Task): string {
    if (!t)
      return this.tasks.tasks().length
        ? "有几项任务，我需要知道你问的是哪个项目。告诉我项目名称就行。"
        : "现在没有正在执行的任务。你可以直接告诉我要处理哪个项目、做什么。";
    return `${this.tasks.project(t.projectId).name}：${labels[t.status]}。\n任务：${t.title}\n当前步骤：${t.stages[t.stageIndex]?.title ?? "待开始"}（${t.stageIndex + 1}/${t.stages.length}）\n${t.startedAt ? `从 ${this.date(t.startedAt)} 开始，已运行 ${Math.max(0, Math.round(((t.endedAt ?? Date.now()) - t.startedAt) / 60000))} 分钟。` : "任务尚未开始。"}\n最近活动：${this.date(t.lastActivityAt)}\n${t.lastEvent}\n${t.status === "WAITING_APPROVAL" ? "现在需要你确认操作。" : t.status === "UNKNOWN" ? "请在电脑上核查；目前无法确认是否还在有效处理。" : "暂时不需要你操作。"}\n还要多久暂时没有可靠依据。${t.summary ? "\n结果：" + t.summary : ""}`;
  }
  private ordinal(text: string): number | undefined {
    const m = text.match(/第?([一二三四五六七八九十\d]+)(?:个|件|项|条)?/);
    if (!m) return;
    const n = /^\d+$/.test(m[1]!)
      ? Number(m[1])
      : "一二三四五六七八九十".indexOf(m[1]!) + 1;
    return n > 0 ? n - 1 : undefined;
  }
  private matchTodos(text: string, c: Context): Todo[] {
    const open = this.todos
      .list()
      .filter((t) => ["open", "draft"].includes(t.status));
    const ordinal = this.ordinal(text);
    if (ordinal !== undefined && c.todoIds?.[ordinal])
      return open.filter((t) => t.id === c.todoIds![ordinal]);
    const quoted = text.match(/[“「"](.+?)[”」"]/);
    const subject = (quoted?.[1] ?? text)
      .replace(/^(?:帮我|把|那个|这项|这个|将)/, "")
      .replace(
        /(?:已经|已)?(?:完成了?|做完了?|交了|提交了|搞定了|做好了|取消了?|不用做了|不做了|改到|改成|推迟到|提前到)[\s\S]*$/,
        "",
      )
      .trim();
    if (subject.length >= 2) {
      const found = open.filter(
        (t) => t.title.includes(subject) || subject.includes(t.title),
      );
      if (found.length) return found;
    }
    if (/^(这个|那个|刚才那件)/.test(text) && c.todoIds?.length === 1)
      return open.filter((t) => t.id === c.todoIds![0]);
    return [];
  }
  private promptDate(t: Todo) {
    const day = t.ambiguity?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
    return `记下了：“${t.title}”。\n${day ? `你说的是 ${day}，具体几点？可以直接回“下午三点”。` : "什么时候提醒或截止？直接说“明天下午三点”，也可以说“先不定时间”。"}`;
  }
  private addTodo(text: string, id: string, c: Context): string {
    let source = text;
    const daily = /每天/.test(text);
    if (daily) {
      source = text.replace(/每天/g, "今天");
      if (!parseDate(source, this.config.timezone).at)
        source = text.replace(/每天/g, "明天");
    }
    const ts = this.todos.add(source, id);
    if (daily)
      for (const r of this.store
        .all<Reminder>("reminders")
        .filter((r) => ts.some((t) => t.id === r.todoId))) {
        r.repeatMinutes = 1440;
        this.store.put("reminders", r);
      }
    c.todoIds = ts.map((t) => t.id);
    const drafts = ts.filter((t) => t.status === "draft");
    if (drafts.length) {
      c.pending = { kind: "todo_date", ids: drafts.map((t) => t.id) };
      return `${ts.length > 1 ? `我拆成了 ${ts.length} 件事。先确认第一件：\n` : ""}${this.promptDate(drafts[0]!)}`;
    }
    c.pending = undefined;
    return ts
      .map(
        (t) =>
          `记下了：${t.title}\n我会在 ${this.date(t.dueAt)} 提醒你${daily ? "，之后每天同一时间提醒" : ""}。`,
      )
      .join("\n\n");
  }
  private start(text: string, c: Context): string {
    const p = this.chooseProject(text, c);
    if (!p) {
      if (!this.tasks.projects().length)
        return "可以。请先在电脑管理页添加项目目录，再告诉我项目名称；我不会自行访问未授权目录。";
      c.pending = { kind: "project", text };
      return `要处理哪个项目？\n${this.tasks
        .projects()
        .map((p) => p.name)
        .join("、")}\n直接回项目名称就行，刚才的要求我已记住。`;
    }
    const t = this.tasks.create(p.id, text);
    c.projectId = p.id;
    c.taskId = t.id;
    c.pending = undefined;
    return `收到，我来处理“${p.name}”：${text}\n任务已排队，开始和完成时都会告诉你。`;
  }
  private approvalsFor(text: string, c: Context) {
    const task = this.chooseTask(text, c);
    const all = this.store
      .all<Approval>("approvals")
      .filter((a) => a.status === "pending");
    return task ? all.filter((a) => a.taskId === task.id) : all;
  }
  async reply(
    text: string,
    userId: string,
    messageId: string,
  ): Promise<string> {
    let c = this.store.setting<Context>(`conversation:${userId}`, {
      updatedAt: Date.now(),
    });
    if (Date.now() - c.updatedAt > 15 * 60000)
      c = { projectId: c.projectId, updatedAt: Date.now() };
    const say = (s: string) => {
      this.save(userId, c);
      return s;
    };
    text = text.trim();
    const explicit = text.match(
      /^(确认继续|批准|同意|拒绝|不批准)\s*([a-f0-9]{16})[。.!！]?$/i,
    );
    if (explicit) {
      await this.tasks.decide(
        explicit[2]!,
        /拒绝|不批准/.test(explicit[1]!) ? "reject" : "approve",
      );
      return say(
        /拒绝|不批准/.test(explicit[1]!)
          ? "已拒绝这次操作。"
          : "已确认这次操作，我会继续跟进。",
      );
    }
    if (/^(你好|您好|嗨|hello|hi|在吗)[呀啊吗？?！!。\s]*$/i.test(text))
      return say("我在。想让我处理项目，还是帮你记一件待办？直接说就行。");
    if (/^(帮助|怎么用|你能做什么|你会做什么|使用说明)[？?。!！]*$/.test(text))
      return say(friendlyHelp(this.tasks.projects()));
    if (/^(谢谢|谢了|辛苦了|收到)[。!！~～]*$/.test(text))
      return say("不客气，有新进展我会告诉你。");
    if (/^(算了|取消刚才的请求|先不处理|不用了)[。!！]*$/.test(text)) {
      c.pending = undefined;
      return say(
        "好，先不继续刚才的请求。已经保存的待办和任务会保留，需要取消哪一件可以告诉我名字。",
      );
    }
    // Explicit queries remain available during a clarification and do not consume it.
    if (
      /待办|有哪些事|什么事没做|还有哪些事|还有什么要做|待完成|待处理的事情/.test(
        text,
      ) &&
      !/提醒我|记.*待办/.test(text)
    )
      return say(
        this.listTodos(
          this.todos.list().filter((t) => ["open", "draft"].includes(t.status)),
          c,
        ),
      );
    if (
      /(?:有哪些|哪些|什么|查看|看看|列出).*(?:项目)|项目.*(?:有哪些|列表)/.test(
        text,
      )
    )
      return say(
        this.tasks.projects().length
          ? `目前接入了：${this.tasks
              .projects()
              .map((p) => p.name)
              .join("、")}。\n直接说“帮我检查某项目的代码”就行。`
          : "还没有接入项目。先在电脑管理页添加项目目录即可。",
      );
    if (/任务列表|有哪些任务|所有任务|看看任务/.test(text))
      return say(
        this.tasks.tasks().length
          ? this.tasks
              .tasks()
              .slice(0, 10)
              .map(
                (t) =>
                  `${this.tasks.project(t.projectId).name} · ${labels[t.status]}\n${t.title}`,
              )
              .join("\n\n")
          : "目前还没有任务。",
      );
    if (
      /在忙什么|在做什么|做什么呢|进度|状态|运行了多久|还有多久|实际处理|还在.*(?:跑|处理|计算)|没有.*消息|完成了[吗没]|完成了吗|怎么样了/.test(
        text,
      ) &&
      !/提醒我|记一下/.test(text)
    ) {
      const t = this.chooseTask(text, c);
      if (t) {
        c.taskId = t.id;
        c.projectId = t.projectId;
      }
      return say(this.status(t));
    }
    if (c.pending?.kind === "project") {
      const p = this.tasks.projects().filter((p) => text.includes(p.name));
      if (p.length === 1) {
        c.projectId = p[0]!.id;
        return say(this.start(c.pending.text, c));
      }
    }
    if (
      c.pending?.kind === "todo_date" &&
      /不定时间|无日期|暂时不设|不用提醒|\d|点|今天|明天|后天|星期|周[一二三四五六日天]|小时后|分钟后/.test(
        text,
      )
    ) {
      const pending = c.pending;
      const t = this.todos.list().find((t) => t.id === pending.ids[0]);
      if (t) {
        let date = text;
        const day = t.ambiguity?.match(/\d{4}-\d{2}-\d{2}/)?.[0];
        const timeOnly = !/今天|明天|后天|周|星期|20\d{2}|后/.test(text);
        if (/不定时间|无日期|暂时不设|不用提醒/.test(text)) date = "无日期";
        else if (day && timeOnly)
          date =
            day +
            " " +
            (!/上午|下午|晚上|中午|早上/.test(text)
              ? (t.sourceText.match(/下午|晚上|上午|中午|早上/)?.[0] ?? "")
              : "") +
            text;
        this.todos.confirm(t.id, date);
        pending.ids.shift();
        c.todoIds = [t.id];
        const next = this.todos.list().find((t) => t.id === pending.ids[0]);
        if (!next) c.pending = undefined;
        return say(
          `已记好“${t.title}”${date === "无日期" ? "，暂不设置提醒。" : `，到 ${this.date(this.todos.list().find((x) => x.id === t.id)?.dueAt)} 提醒你。`}${next ? "\n\n接下来，" + this.promptDate(next) : ""}`,
        );
      }
    }
    if (c.pending?.kind === "todo_pick") {
      const index = this.ordinal(text);
      const chosen = index === undefined ? undefined : c.pending.ids[index];
      if (chosen) {
        const t = this.todos.list().find((t) => t.id === chosen);
        if (t) {
          if (c.pending.action === "date") {
            const updated = this.todos.confirm(t.id, c.pending.date!);
            c.pending = undefined;
            return say(
              `“${updated.title}”已改到 ${this.date(updated.dueAt)}。`,
            );
          }
          const done = c.pending.action === "done";
          this.todos.change(t.id, done ? "done" : "cancelled");
          c.pending = undefined;
          return say(
            `“${t.title}”已${done ? "完成" : "取消"}，相关提醒也停了。`,
          );
        }
      }
    }
    if (c.pending?.kind === "clarify") {
      if (/待办|记下来|提醒/.test(text))
        return say(this.addTodo(c.pending.text, messageId, c));
      if (/执行|处理项目|交给.*Codex|帮我做/.test(text))
        return say(this.start(c.pending.text, c));
    }
    if (/^(?:先)?(?:停一下|停下|停止|暂停|别继续|不要继续)/.test(text)) {
      const t = this.chooseTask(text, c);
      if (!t) return say("要停止哪个项目的任务？告诉我项目名称，我再处理。");
      await this.tasks.stop(t.id);
      return say(`已请求停止“${t.title}”，我会以 Codex 返回的停止结果为准。`);
    }
    if (/^(?:继续|接着|往下做|同意|好的|好|批准|修改为|改为)/.test(text)) {
      const approvals = this.approvalsFor(text, c);
      if (approvals.length) {
        if (approvals.length > 1)
          return say(
            "有多项操作在等确认。请告诉我要继续哪个项目，避免批准错任务。",
          );
        const a = approvals[0]!;
        if (/不要|但|仅|只|修改为|改为/.test(text)) {
          const current = this.store.get<Task>("tasks", a.taskId)!;
          await this.tasks.modifyApproval(
            a.id,
            current.stages[current.stageIndex]!.prompt +
              "\n用户新要求：" +
              text,
          );
          return say(
            "已按你的新要求更新任务；原来的操作不会被这句话直接批准。",
          );
        }
        if (a.localOnly || !a.allowed)
          return say(
            `这一步需要在电脑管理页检查：\n${a.description}\n我不会根据一句“好的”执行系统命令。`,
          );
        return say(
          `你要继续的是：${a.description}\n${a.risk}\n为避免批准错任务，请直接回复这一句：\n确认继续 ${a.id}`,
        );
      }
      if (/^(好的?|同意|批准)[。!！]*$/.test(text))
        return say("收到。目前没有需要你批准的操作。");
      const t = this.chooseTask(text, c);
      if (!t)
        return say("还没有可继续的任务。告诉我项目和接下来要做什么就行。");
      const next = this.tasks.continue(t.projectId, text);
      c.taskId = next.id;
      c.projectId = next.projectId;
      return say(
        `好，我会在“${this.tasks.project(next.projectId).name}”原来的会话里继续。${t.status === "RUNNING" || t.status === "WAITING_PROCESS" ? "当前步骤结束后处理你的新要求。" : ""}`,
      );
    }
    if (
      /改到|改成|推迟到|提前到|完成了|做完了|交了|提交了|搞定了|做好了|取消|不用做了/.test(
        text,
      )
    ) {
      const action = /改到|改成|推迟到|提前到/.test(text)
        ? "date"
        : /取消|不用做了/.test(text)
          ? "cancel"
          : "done";
      const matches = this.matchTodos(text, c);
      const newDate = text.split(/改到|改成|推迟到|提前到/)[1]?.trim();
      if (matches.length === 1) {
        const t = matches[0]!;
        c.todoIds = [t.id];
        if (action === "date") {
          this.todos.confirm(t.id, newDate ?? "");
          return say(
            `“${t.title}”已改到 ${this.date(this.todos.list().find((x) => x.id === t.id)?.dueAt)}。`,
          );
        }
        this.todos.change(t.id, action === "done" ? "done" : "cancelled");
        return say(
          `“${t.title}”已${action === "done" ? "完成" : "取消"}，相关提醒也停了。`,
        );
      }
      const candidates = matches.length
        ? matches
        : this.todos.list().filter((t) => ["open", "draft"].includes(t.status));
      if (candidates.length) {
        c.pending = {
          kind: "todo_pick",
          ids: candidates.map((t) => t.id),
          action,
          date: newDate,
        };
        return say(
          `你说的是哪一件？\n${candidates.map((t, i) => `${i + 1}. ${t.title}`).join("\n")}\n直接说“第一件”或事情名字就行。`,
        );
      }
    }
    if (
      /^(?:打开\s*.+?项目[，,:：]|(?:帮我|请|现在|麻烦).*(?:检查|分析|修复|排查|运行|执行|写代码|修改代码|生成.*报告|总结.*报告))/.test(
        text,
      )
    )
      return say(this.start(text, c));
    if (
      /提醒我|记一下|记个|记下来|待办|今天|明天|后天|下周|周[一二三四五六日天]|20\d{2}[-年/]|每天|分钟后|小时后/.test(
        text,
      )
    )
      return say(this.addTodo(text, messageId, c));
    c.pending = { kind: "clarify", text };
    return say(
      "这件事要我直接处理项目，还是先记成待办？你回“帮我处理”或“记下来”就行。",
    );
  }
}
