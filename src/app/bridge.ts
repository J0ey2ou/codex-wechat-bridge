import path from "node:path";
import type { CodexController, WeChatAdapter } from "./types.js";
import type { Config } from "./config.js";
import { Store } from "../storage/store.js";
import { AppServerClient } from "../codex/client.js";
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
export class Bridge {
  readonly store: Store;
  readonly codex: CodexController;
  readonly channel: WeChatAdapter;
  readonly notices: NotificationManager;
  readonly tasks: TaskOrchestrator;
  readonly todos: TodoManager;
  readonly router: MessageRouter;
  readonly desktop: DesktopSessionAdapter;
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
    this.codex =
      overrides.codex ??
      (config.codexMode === "mock"
        ? new MockCodex(true)
        : new AppServerClient(config.codexBin));
    this.channel =
      overrides.channel ??
      (config.wechatMode === "mock"
        ? new MockWeChat()
        : new ILinkAdapter(
            this.store,
            new DpapiVault(path.join(config.dataDir, "secrets")),
          ));
    this.notices = new NotificationManager(this.store, this.channel);
    this.tasks = new TaskOrchestrator(
      this.store,
      this.codex,
      this.notices,
      config,
    );
    this.todos = new TodoManager(this.store, this.notices, config);
    this.router = new MessageRouter(
      this.store,
      this.tasks,
      this.todos,
      this.notices,
      config,
    );
    this.desktop = new DesktopSessionAdapter(this.codex);
    this.channel.receiveMessage((m) => this.router.receive(m));
  }
  async start() {
    this.tasks.recover();
    this.router.recover();
    this.notices.recover();
    try{await this.channel.connect();}catch(e){this.backgroundError(e);}
    await this.connectCodex();
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
      await this.tasks.monitor();
      if (!this.codex.connected && Date.now() >= this.nextReconnect)
        await this.connectCodex();
      await this.tasks.pump();
    } finally {
      this.busy = false;
    }
  }
  async stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    await this.channel.disconnect();
    await this.codex.disconnect();
    await this.tasks.drained(); /* Store stays open until process exit, so in-flight HTTP promises can settle safely. */
  }
}
