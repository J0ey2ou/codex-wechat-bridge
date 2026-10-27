import path from "node:path";
import type { CodexController, WeChatAdapter } from "./types.js";
import type { Config } from "./config.js";
import { Store } from "../storage/store.js";
import { AppServerClient, appServerArgs } from "../codex/client.js";
import { MockCodex } from "../codex/mock.js";
import { DesktopSessionAdapter } from "../codex/desktop.js";
import { ILinkAdapter } from "../channels/wechat/ilink.js";
import { MockWeChat } from "../channels/wechat/mock.js";
import { DpapiVault, MemoryVault } from "../security/vault.js";
import { NotificationManager } from "../notifications/outbox.js";
import { TaskOrchestrator } from "../tasks/orchestrator.js";
import { TodoManager } from "../scheduler/todos.js";
import { MessageRouter } from "./router.js";
import { safeText } from "../security/policy.js";
import { QuestionManager } from "../codex/questions.js";
import { IntentDispatcher } from "./intent.js";
import { ComputerService } from "../computer/service.js";
import { WorkspaceCatalog } from "../computer/workspaces.js";
import { MemoryManager } from "./memory.js";
import { OpenAIAuth } from "../codex/auth.js";
import { ObservedCodex } from "../codex/evidence.js";
import { CodexCompletionWatcher } from "../codex/completion-watcher.js";
import { PdfReports } from "../reports/pdf.js";
import { CodexActivityMonitor } from "../codex/activity.js";
export class Bridge {
  readonly store: Store;
  readonly codex: CodexController;
  readonly channel: WeChatAdapter;
  readonly notices: NotificationManager;
  readonly tasks: TaskOrchestrator;
  readonly todos: TodoManager;
  readonly router: MessageRouter;
  readonly desktop: DesktopSessionAdapter;
  readonly questions: QuestionManager;
  readonly computer: ComputerService;
  readonly memory: MemoryManager;
  readonly auth: OpenAIAuth;
  readonly completions: CodexCompletionWatcher;
  readonly reports: PdfReports;
  readonly activity: CodexActivityMonitor;
  onShutdown?: () => void;
  private timers: NodeJS.Timeout[] = [];
  private busy = false;
  private reconnecting = false;
  private nextReconnect = 0;
  private stopped = false;
  constructor(
    readonly config: Config,
    overrides: {
      store?: Store;
      codex?: CodexController;
      channel?: WeChatAdapter;
    } = {},
  ) {
    this.store =
      overrides.store ?? new Store(path.join(config.dataDir, "bridge.sqlite"));
    Object.assign(config, this.store.setting("preferences", {}));
    const baseCodex =
      overrides.codex ??
      (config.codexMode === "mock"
        ? new MockCodex(true)
        : new AppServerClient(
            config.codexBin,
            appServerArgs(config.codexTransport),
          ));
    this.codex = new ObservedCodex(
      baseCodex,
      this.store,
      config.codexMode === "mock",
    );
    this.auth = new OpenAIAuth(this.codex, config.codexMode === "mock");
    this.memory = new MemoryManager(this.store);
    this.channel =
      overrides.channel ??
      (config.wechatMode === "mock"
        ? new MockWeChat()
        : new ILinkAdapter(
            this.store,
            new DpapiVault(path.join(config.dataDir, "secrets")),
          ));
    this.notices = new NotificationManager(
      this.store,
      this.channel,
      config.wechatPushEnabled,
    );
    this.completions = new CodexCompletionWatcher(
      this.store,
      this.codex,
      this.notices,
    );
    this.reports = new PdfReports(this.store, this.notices, config.dataDir);
    this.tasks = new TaskOrchestrator(
      this.store,
      this.codex,
      this.notices,
      config,
    );
    this.todos = new TodoManager(this.store, this.notices, config);
    this.computer = new ComputerService(
      new WorkspaceCatalog(
        this.codex,
        config,
        () => this.tasks.projects(),
        () => this.store.setting("boundUser", ""),
      ),
    );
    this.activity = new CodexActivityMonitor(
      this.store,
      this.codex,
      this.computer.workspaces,
    );
    this.questions = new QuestionManager(
      this.store,
      this.codex,
      this.notices,
      config,
      new IntentDispatcher(
        this.store,
        this.tasks,
        this.todos,
        this.codex,
        config,
        this.computer,
        this.reports,
      ),
    );
    this.router = new MessageRouter(
      this.store,
      this.tasks,
      this.todos,
      this.notices,
      config,
      this.questions,
      this.computer.workspaces,
    );
    this.desktop = new DesktopSessionAdapter(this.codex);
    this.channel.receiveMessage((m) => this.router.receive(m));
    this.questions.onQueued = () => {
      setImmediate(() => {
        if (!this.stopped && !this.auth.busy)
          void this.questions.pump().catch((e) => this.backgroundError(e));
      });
    };
  }
  async start() {
    this.tasks.recover();
    this.router.recover();
    this.notices.recover();
    this.questions.recover();
    this.notices.start();
    try {
      await this.channel.connect();
    } catch (e) {
      this.backgroundError(e);
    }
    await this.connectCodex();
    this.timers.push(
      setInterval(() => {
        this.questions.monitor();
        if (!this.auth.busy)
          void this.questions.pump().catch((e) => this.backgroundError(e));
      }, 500),
    );
    this.timers.push(
      setInterval(
        () => void this.tick().catch((e) => this.backgroundError(e)),
        1000,
      ),
    );
    this.timers.push(
      setInterval(
        () => void this.notices.flush().catch((e) => this.backgroundError(e)),
        500,
      ),
    );
  }
  async connectCodex() {
    if (this.reconnecting || this.stopped) return;
    this.reconnecting = true;
    try {
      await this.codex.connect();
      await this.tasks.reconcile();
      this.store.setSetting("codexError", null);
      void this.computer.prepare().catch((e) => this.backgroundError(e));
    } catch (e) {
      this.store.setSetting(
        "codexError",
        safeText(e instanceof Error ? e.message : e),
      );
      this.nextReconnect = Date.now() + 30000;
    } finally {
      this.reconnecting = false;
    }
  }
  private backgroundError(e: unknown) {
    this.store.setSetting(
      "lastBackgroundError",
      safeText(e instanceof Error ? e.message : e),
    );
  }
  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      this.store.setSetting("heartbeat", Date.now());
      this.todos.collect();
      this.todos.tick();
      await this.auth.expire();
      await this.tasks.monitor();
      for (const task of this.tasks
        .tasks()
        .filter(
          (t) =>
            t.pdfRequested &&
            !t.pdfReportId &&
            (t.pdfAttempts ?? 0) < 3 &&
            (t.pdfRetryAfter ?? 0) <= Date.now() &&
            ["COMPLETED", "FAILED", "INTERRUPTED"].includes(t.status),
        )) {
        try {
          await this.reports.task(task);
        } catch (error) {
          task.pdfAttempts = (task.pdfAttempts ?? 0) + 1;
          task.pdfRetryAfter = Date.now() + 30000;
          task.pdfError = safeText(
            error instanceof Error ? error.message : error,
          );
          this.store.put("tasks", task);
          this.backgroundError(error);
          if (task.pdfAttempts >= 3)
            this.notices.enqueue(
              "这次 PDF 没能生成，文字结果和具体原因已留在软件里。",
              `pdf-generation:${task.id}`,
              undefined,
              "reply",
            );
        }
      }
      if (this.codex.connected && !this.auth.busy) await this.tasks.reconcile();
      if (!this.codex.connected && Date.now() >= this.nextReconnect)
        await this.connectCodex();
      if (!this.auth.busy) await this.tasks.pump();
      void this.completions.tick().catch((e) => this.backgroundError(e));
      if (!this.auth.busy)
        void this.activity.tick().catch((e) => this.backgroundError(e));
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    this.notices.stop();
    for (const t of this.timers) clearInterval(t);
    await this.channel.disconnect();
    await this.codex.disconnect();
    await this.questions.drained();
    await this.tasks.drained(); /* Store stays open until process exit, so in-flight HTTP promises can settle safely. */
  }
}
