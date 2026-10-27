import type { CodexController, Task } from "../app/types.js";
import type { WorkspaceCatalog } from "../computer/workspaces.js";
import { safeText } from "../security/policy.js";
import type { Store } from "../storage/store.js";

export type ActivityState =
  | "pending"
  | "running"
  | "waiting"
  | "recentActivity"
  | "unconfirmed"
  | "completed"
  | "failed"
  | "interrupted"
  | "idle";
export interface DesktopActivity {
  id: string;
  name: string;
  cwd: string;
  projectId?: string;
  projectName: string;
  source: "codex";
  status: ActivityState;
  runtimeStatus: string;
  turnId?: string;
  turnStatus?: string;
  startedAt?: number;
  completedAt?: number;
  updatedAt?: number;
  checkedAt: number;
  stale: boolean;
  evidence: string;
  configuredModel?: string;
  actualModel: null;
  summary?: string;
  error?: string;
}
const terminal = new Set(["COMPLETED", "FAILED", "INTERRUPTED"]);
const ms = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) && v > 0
    ? v < 100_000_000_000
      ? v * 1000
      : v
    : undefined;
const important = (s: ActivityState) =>
  ["running", "waiting", "recentActivity", "unconfirmed"].includes(s);

/** Read-only observation, independent of task dispatch and WeChat notifications.
 * notLoaded/interrupted-without-end from another app-server is NOT proof of a stopped turn.
 */
export class CodexActivityMonitor {
  private rows = new Map<string, DesktopActivity>();
  private owner?: string;
  private connection?: string;
  private pending?: Promise<void>;
  private lastAttempt = 0;
  private lastSuccessAt?: number;
  private error?: string;
  private cursor?: string;
  private scanIds = new Set<string>();
  private paginationComplete = false;
  constructor(
    private store: Store,
    private codex: CodexController,
    private catalog: Pick<WorkspaceCatalog, "refresh" | "observationScope">,
    private interval = 5000,
  ) {}
  private currentOwner() {
    return this.store.setting("boundUser", "");
  }
  private hidden(id: string) {
    if (this.store.isForeign("codex_sessions", id)) return true;
    if (
      this.store.get<{ origin?: string }>("codex_sessions", id)?.origin === "qa"
    )
      return true;
    if (
      this.store
        .all<{ threadId?: string }>("questions")
        .some((q) => q.threadId === id)
    )
      return true;
    return this.store
      .all<Task>("tasks")
      .some(
        (t) =>
          (t.threadId === id || t.targetThreadId === id) &&
          !terminal.has(t.status),
      );
  }
  private eligible(t: any) {
    return (
      t &&
      typeof t.id === "string" &&
      t.id &&
      !this.hidden(t.id) &&
      !t.ephemeral &&
      !t.parentThreadId &&
      !/subAgent/i.test(JSON.stringify(t.source ?? "")) &&
      !/(?:test-output|qa-workspace)(?:[\\/]|$)/i.test(t.cwd ?? "") &&
      !/\b(?:BRIDGE_OK|BOUND_OK|COMPUTER_OK|connectivity smoke test|integration smoke test)\b/i.test(
        `${t.name ?? ""}\n${t.preview ?? ""}`,
      )
    );
  }
  snapshot(now = Date.now()) {
    const same =
      this.owner === this.currentOwner() &&
      this.connection === this.codex.connectionId;
    const rows = same
      ? [...this.rows.values()]
          .filter((r) => !this.hidden(r.id) && this.catalog.observationScope(r))
          .map((r) => {
            const stale =
              !!r.error ||
              !!this.error ||
              !this.codex.connected ||
              now - r.checkedAt > 20_000;
            const status =
              r.status === "recentActivity" && now - (r.updatedAt ?? 0) > 90_000
                ? "unconfirmed"
                : r.status;
            return { ...r, status, stale };
          })
      : [];
    rows.sort(
      (a, b) =>
        Number(important(b.status)) - Number(important(a.status)) ||
        (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
    return {
      status: !this.currentOwner()
        ? "waitingForBinding"
        : !this.codex.connected
          ? "disconnected"
          : this.error
            ? "degraded"
            : this.lastSuccessAt && same
              ? "watching"
              : "loading",
      intervalMs: this.interval,
      lastSuccessAt: same ? this.lastSuccessAt : undefined,
      error: same ? this.error : undefined,
      paginationComplete: same && this.paginationComplete,
      crossClientRuntime: false,
      running: rows.filter((r) => !r.stale && r.status === "running").length,
      waiting: rows.filter((r) => !r.stale && r.status === "waiting").length,
      recentActivity: rows.filter(
        (r) => !r.stale && r.status === "recentActivity",
      ).length,
      unconfirmed: rows.filter(
        (r) =>
          important(r.status) &&
          (r.stale || ["recentActivity", "unconfirmed"].includes(r.status)),
      ).length,
      threads: rows,
    };
  }
  tick(now = Date.now(), force = false): Promise<void> {
    if (this.pending) return this.pending;
    const owner = this.currentOwner();
    if (owner !== this.owner || this.connection !== this.codex.connectionId) {
      this.owner = owner;
      this.connection = this.codex.connectionId;
      this.rows.clear();
      this.cursor = undefined;
      this.scanIds.clear();
      this.paginationComplete = false;
      this.lastAttempt = 0;
      this.lastSuccessAt = undefined;
      this.error = undefined;
    }
    if (
      !owner ||
      !this.codex.connected ||
      now - this.lastAttempt < (force ? 1000 : this.interval)
    )
      return Promise.resolve();
    this.lastAttempt = now;
    const connection = this.connection;
    const valid = () =>
      this.currentOwner() === owner && this.codex.connectionId === connection;
    const promise = this.poll(now, valid)
      .catch((error) => {
        if (valid())
          this.error = safeText(
            error instanceof Error ? error.message : error,
            250,
          );
      })
      .finally(() => {
        if (this.pending === promise) this.pending = undefined;
      });
    this.pending = promise;
    return promise;
  }
  private async poll(now: number, valid: () => boolean) {
    const workspaces = await this.catalog.refresh();
    if (!valid()) return;
    if (workspaces.error)
      throw new Error(`项目范围暂不可核实：${workspaces.error}`);
    const params = {
      limit: 50,
      modelProviders: [],
      sortKey: "updated_at",
      sortDirection: "desc",
    };
    const head = await this.codex.request("thread/list", params);
    if (!valid()) return;
    if (!Array.isArray(head?.data)) throw new Error("Codex 未返回有效对话列表");
    const metadata = new Map<string, any>(head.data.map((t: any) => [t.id, t]));
    for (const id of metadata.keys()) this.scanIds.add(id);
    if (this.cursor) {
      const page = await this.codex.request("thread/list", {
        ...params,
        cursor: this.cursor,
      });
      if (!valid()) return;
      if (!Array.isArray(page?.data) || page.nextCursor === this.cursor)
        throw new Error("Codex 对话分页未正常前进");
      for (const t of page.data) {
        if (!metadata.has(t.id)) metadata.set(t.id, t);
        this.scanIds.add(t.id);
      }
      this.cursor = page.nextCursor ?? undefined;
    } else this.cursor = head.nextCursor ?? undefined;
    if (!this.cursor) {
      for (const id of this.rows.keys())
        if (!this.scanIds.has(id)) this.rows.delete(id);
      this.scanIds.clear();
      this.paginationComplete = true;
    }
    for (const [id, t] of metadata) {
      const scope = this.eligible(t) && this.catalog.observationScope(t);
      if (!scope) {
        this.rows.delete(id);
        continue;
      }
      const prior = this.rows.get(id);
      this.rows.set(id, {
        ...prior,
        id,
        ...scope,
        name: safeText(t.name || t.preview || "未命名对话", 160),
        source: "codex",
        status: prior?.status ?? "pending",
        runtimeStatus: t.status?.type ?? "unknown",
        updatedAt: ms(t.updatedAt),
        checkedAt: prior?.checkedAt ?? 0,
        stale: true,
        evidence: prior?.evidence ?? "已发现对话，等待核对最近轮次",
        configuredModel: t.model ?? undefined,
        actualModel: null,
      });
    }
    // Read the newest conversations first, then rotate older history with a bounded budget.
    const ordered = [...this.rows.values()].sort(
      (a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0),
    );
    const newest = ordered.slice(0, 4);
    const others = ordered
      .filter((r) => !newest.includes(r))
      .sort((a, b) => a.checkedAt - b.checkedAt)
      .slice(0, 2);
    for (const row of [...newest, ...others]) {
      try {
        const response = await this.codex.request("thread/turns/list", {
          threadId: row.id,
          limit: 1,
          itemsView: "summary",
          sortDirection: "desc",
        });
        if (!valid()) return;
        if (!Array.isArray(response?.data))
          throw new Error("执行端未提供最近轮次");
        const t = response.data[0];
        const ended = ms(t?.completedAt);
        const raw = metadata.get(row.id);
        const runtime = raw?.status?.type ?? "unknown";
        let status: ActivityState = "unconfirmed";
        let evidence = "其他客户端的实时状态不可用，不能据此认定任务停止";
        if (runtime === "active") {
          status = raw.status.activeFlags?.length ? "waiting" : "running";
          evidence = raw.status.activeFlags?.length
            ? `官方运行状态 active：${raw.status.activeFlags.join("、")}`
            : "官方运行状态 active";
        } else if (
          t &&
          (["completed", "failed"].includes(t.status) ||
            (ended && t.status === "interrupted"))
        ) {
          status = t.status;
          evidence = ended
            ? "官方最近轮次状态及结束时间"
            : "官方最近轮次已报告终态，未提供结束时间";
        } else if (
          t &&
          !ended &&
          ["inProgress", "interrupted"].includes(t.status)
        ) {
          status =
            now - (row.updatedAt ?? 0) <= 90_000
              ? "recentActivity"
              : "unconfirmed";
          evidence = `最近轮次 ${t.status}，未报告结束时间；${runtime} 只代表本观察连接`;
        } else if (!t) {
          status = "idle";
          evidence = "尚无执行轮次";
        } else if (runtime === "idle") {
          status = "idle";
          evidence = "官方运行状态 idle";
        }
        const summary =
          status === "completed"
            ? t?.items?.findLast(
                (i: any) =>
                  i.type === "agentMessage" && i.phase === "final_answer",
              )?.text
            : undefined;
        Object.assign(row, {
          status,
          evidence,
          runtimeStatus: runtime,
          turnId: t?.id,
          turnStatus: t?.status,
          startedAt: ms(t?.startedAt),
          completedAt: ended,
          checkedAt: now,
          stale: false,
          error: undefined,
          summary:
            typeof summary === "string" ? safeText(summary, 600) : undefined,
        });
      } catch (error) {
        if (!valid()) return;
        row.error = safeText(
          error instanceof Error ? error.message : error,
          200,
        );
        row.stale = true;
      }
    }
    if (!valid()) return;
    // Retain a bounded metadata cache, prioritizing recent conversations.
    for (const row of ordered.slice(200)) this.rows.delete(row.id);
    this.lastSuccessAt = now;
    this.error = undefined;
  }
}
