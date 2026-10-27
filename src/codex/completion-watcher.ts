import { createHash } from "node:crypto";
import path from "node:path";
import type { CodexController } from "../app/types.js";
import { NotificationManager } from "../notifications/outbox.js";
import { desktopCompletionMessage } from "../notifications/task-message.js";
import { safeText } from "../security/policy.js";
import { Store } from "../storage/store.js";

interface ThreadMetadata {
  id: string;
  name?: string | null;
  cwd?: string;
  preview?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
  historyMode?: string;
  ephemeral?: boolean;
  parentThreadId?: string | null;
  source?: unknown;
  status?: { type?: string };
  turns?: Turn[];
}
interface Turn {
  id: string;
  status: string;
  completedAt?: number | null;
  startedAt?: number | null;
  error?: unknown;
  itemsView?: string;
  items?: { type: string; text?: string; phase?: string | null }[];
}
interface Checkpoint {
  revision: string;
  updatedAt: number;
  metadata: Pick<ThreadMetadata, "id" | "name" | "cwd" | "historyMode">;
  pending: boolean;
  lastReadAt?: number;
  retryAt?: number;
  retryCount: number;
  unsettled: boolean;
  hydrated: boolean;
  known: string[];
  watching: string[];
  completed: string[];
}
interface WatchState {
  version: 1;
  baselineAt: number;
  baselineComplete: boolean;
  cursor?: string;
  threads: Record<string, Checkpoint>;
}
export interface CompletionWatcherOptions {
  intervalMs?: number;
  overlapMs?: number;
  pageSize?: number;
  maxPagesPerTick?: number;
  /** Content RPC budget; a paginated thread consumes two requests. */
  maxReadsPerTick?: number;
  /** Additional internal threads, if an integration tracks them elsewhere. */
  excludedThreadIds?: () => Iterable<string>;
}
export interface CompletionWatcherSnapshot {
  status: "waitingForBinding" | "disconnected" | "baselining" | "watching";
  baselineAt?: number;
  lastPollAt?: number;
  lastSuccessAt?: number;
  lastEnqueuedAt?: number;
  trackedThreads: number;
  pendingThreads: number;
  error?: string;
}

const PREFIX = "codex-completion-watch:";
const ACTIVE_OWNER = `${PREFIX}active-owner`;
const DAY = 24 * 60 * 60_000;
function millis(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value < 100_000_000_000
      ? value * 1000
      : value
    : 0;
}
function finalAnswer(turn: Turn): string | undefined {
  if (
    turn.status !== "completed" ||
    turn.error ||
    (turn.itemsView && !["full", "summary"].includes(turn.itemsView)) ||
    !Array.isArray(turn.items)
  )
    return;
  const final = turn.items.findLast(
    (item) => item.type === "agentMessage" && item.phase === "final_answer",
  );
  // Older history lacks phase. Only a terminal assistant message qualifies;
  // commentary before a tool call is never a completion result.
  const last = turn.items.at(-1);
  const item =
    final ??
    (turn.itemsView !== "summary" &&
    last?.type === "agentMessage" &&
    last.phase == null
      ? last
      : undefined);
  return typeof item?.text === "string" && item.text.trim()
    ? safeText(item.text.trim(), 2200)
    : undefined;
}
function smokeThread(thread: ThreadMetadata): boolean {
  const cwd = (thread.cwd ?? "").replaceAll("\\", "/");
  return (
    /(?:^|\/)test-output\/[^/]*smoke(?:\/|$)/i.test(cwd) ||
    /\b(?:BRIDGE_OK|BOUND_OK|COMPUTER_OK|connectivity smoke test|integration smoke test)\b/i.test(
      `${thread.name ?? ""}\n${thread.preview ?? ""}`,
    ) ||
    /^\[?(?:bridge[- _])?smoke(?:[- _\]]|$)/i.test(thread.name ?? "")
  );
}

/** Observes persisted public history. Never acquires or resumes another client's turn. */
export class CodexCompletionWatcher {
  private busy = false;
  private lastAttemptAt?: number;
  private activeOwner?: string;
  private info: CompletionWatcherSnapshot = {
    status: "waitingForBinding",
    trackedThreads: 0,
    pendingThreads: 0,
  };
  private readonly interval: number;
  private readonly overlap: number;
  private readonly pageSize: number;
  private readonly pages: number;
  private readonly reads: number;
  constructor(
    private store: Store,
    private codex: CodexController,
    private notifications: NotificationManager,
    private options: CompletionWatcherOptions = {},
  ) {
    this.interval = Math.max(0, options.intervalMs ?? 15_000);
    this.overlap = Math.max(1_000, options.overlapMs ?? 60_000);
    this.pageSize = Math.max(1, Math.min(100, options.pageSize ?? 50));
    this.pages = Math.max(1, Math.min(10, options.maxPagesPerTick ?? 2));
    this.reads = Math.max(2, Math.min(20, options.maxReadsPerTick ?? 4));
  }
  snapshot(): CompletionWatcherSnapshot {
    return { ...this.info };
  }
  private owner(): string | undefined {
    return this.store.setting<string | undefined>("boundUser", undefined);
  }
  private excluded(): Set<string> {
    const ids = new Set(this.options.excludedThreadIds?.() ?? []);
    for (const table of ["tasks", "questions"] as const)
      for (const entry of this.store.all<{ threadId?: string }>(table))
        if (entry.threadId) ids.add(entry.threadId);
    for (const entry of this.store.all<{ id: string; origin?: string }>(
      "codex_sessions",
    ))
      if (["qa", "bridge", "desktop-fork"].includes(entry.origin ?? ""))
        ids.add(entry.id);
    return ids;
  }
  private eligible(thread: ThreadMetadata, excluded: Set<string>): boolean {
    return (
      typeof thread.id === "string" &&
      !!thread.id &&
      !excluded.has(thread.id) &&
      !thread.ephemeral &&
      !thread.parentThreadId &&
      !(typeof thread.source === "object" && thread.source !== null) &&
      !(
        typeof thread.source === "string" && /^subAgent/i.test(thread.source)
      ) &&
      !smokeThread(thread)
    );
  }
  async tick(now = Date.now()): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      const owner = this.owner();
      if (!owner) {
        // A later rebind must establish a new baseline, even for the old owner.
        this.store.setSetting(ACTIVE_OWNER, null);
        this.activeOwner = undefined;
        this.info = {
          status: "waitingForBinding",
          trackedThreads: 0,
          pendingThreads: 0,
        };
        return;
      }
      if (owner !== this.activeOwner) {
        this.lastAttemptAt = undefined;
        this.activeOwner = owner;
        this.info = {
          status: "baselining",
          trackedThreads: 0,
          pendingThreads: 0,
        };
      }
      if (!this.codex.connected) {
        this.info.status = "disconnected";
        return;
      }
      if (
        this.lastAttemptAt !== undefined &&
        now - this.lastAttemptAt < this.interval
      )
        return;
      this.lastAttemptAt = now;
      this.info.lastPollAt = now;
      this.info.error = undefined;
      const ownerHash = createHash("sha256").update(owner).digest("hex");
      const key = PREFIX + ownerHash;
      let state = this.store.setting<WatchState | undefined>(key, undefined);
      if (
        !state ||
        state.version !== 1 ||
        this.store.setting(ACTIVE_OWNER, "") !== ownerHash
      ) {
        state = {
          version: 1,
          baselineAt: now,
          baselineComplete: false,
          threads: {},
        };
        this.store.setSetting(ACTIVE_OWNER, ownerHash);
        this.store.setSetting(key, state);
      }
      const excluded = this.excluded();
      // Resume metadata pagination between ticks, with a bounded RPC budget.
      for (let page = 0; page < this.pages; page++) {
        const response = await this.codex.request<{
          data: ThreadMetadata[];
          nextCursor?: string | null;
        }>("thread/list", {
          limit: this.pageSize,
          modelProviders: [],
          sourceKinds: ["cli", "vscode", "appServer"],
          sortKey: "updated_at",
          sortDirection: "desc",
          useStateDbOnly: true,
          ...(state.cursor ? { cursor: state.cursor } : {}),
        });
        if (this.owner() !== owner) return;
        if (!Array.isArray(response.data))
          throw new Error("Codex thread/list 返回了无效列表");
        for (const thread of response.data) {
          if (!this.eligible(thread, excluded)) {
            delete state.threads[thread.id];
            continue;
          }
          const updatedAt = millis(thread.updatedAt);
          const revision = JSON.stringify([
            thread.updatedAt,
            thread.recencyAt,
            thread.status?.type,
          ]);
          const previous = state.threads[thread.id];
          const changed = !!previous && previous.revision !== revision;
          const recent = updatedAt >= now - this.overlap;
          const active = thread.status?.type === "active";
          const row: Checkpoint = previous ?? {
            revision,
            updatedAt,
            metadata: { id: thread.id },
            pending: state.baselineComplete || recent || active,
            retryCount: 0,
            unsettled: false,
            hydrated: false,
            known: [],
            watching: [],
            completed: [],
          };
          row.metadata = {
            id: thread.id,
            name: thread.name,
            cwd: thread.cwd,
            historyMode: thread.historyMode,
          };
          row.revision = revision;
          row.updatedAt = updatedAt;
          if (changed || recent || active) row.pending = true;
          if (changed || recent) {
            row.retryCount = 0;
            row.retryAt = undefined;
          }
          state.threads[thread.id] = row;
        }
        if (response.nextCursor && response.nextCursor === state.cursor)
          throw new Error("Codex thread/list 分页未前进");
        state.cursor = response.nextCursor ?? undefined;
        if (!state.cursor) {
          state.baselineComplete = true;
          break;
        }
      }
      this.store.setSetting(key, state);
      let budget = this.reads;
      const ready = Object.values(state.threads)
        .filter(
          (row) =>
            !excluded.has(row.metadata.id) &&
            (row.pending || (row.unsettled && row.updatedAt >= now - DAY)) &&
            (!row.retryAt || row.retryAt <= now),
        )
        .sort((a, b) => (a.lastReadAt ?? 0) - (b.lastReadAt ?? 0));
      for (const row of ready) {
        const paginated = row.metadata.historyMode === "paginated";
        const cost = paginated ? 2 : 1;
        if (budget < cost) continue;
        budget -= cost;
        const before = structuredClone(row);
        try {
          const result = await this.codex.request<{ thread: ThreadMetadata }>(
            "thread/read",
            { threadId: row.metadata.id, includeTurns: !paginated },
          );
          if (this.owner() !== owner) return;
          const thread = result.thread;
          if (thread?.id !== row.metadata.id)
            throw new Error("Codex thread/read 返回了不匹配的会话");
          if (!this.eligible(thread, this.excluded())) {
            delete state.threads[row.metadata.id];
            this.store.setSetting(key, state);
            continue;
          }
          const turns = paginated
            ? (
                await this.codex.request<{ data: Turn[] }>(
                  "thread/turns/list",
                  {
                    threadId: thread.id,
                    limit: 20,
                    // The public summary includes the original final_answer text,
                    // without loading a long project's tool output into the Bridge.
                    itemsView: "summary",
                    sortDirection: "desc",
                  },
                )
              ).data.toReversed()
            : thread.turns;
          if (this.owner() !== owner) return;
          if (!Array.isArray(turns))
            throw new Error("Codex 未提供可核验的会话轮次");
          const known = new Set(row.known);
          const watching = new Set(row.watching);
          const completed = new Set(row.completed);
          const candidates: { turn: Turn; text: string }[] = [];
          let deferred = false;
          const lastCompleted = turns.findLast(
            (turn) => turn.status === "completed" && !completed.has(turn.id),
          );
          for (const turn of turns) {
            if (!turn.id || completed.has(turn.id)) continue;
            if (turn.status !== "completed") {
              // In particular, interrupted can be a cross-process projection.
              // It is an observation to revisit, never a failure notification.
              watching.add(turn.id);
              continue;
            }
            const end = millis(turn.completedAt);
            const start = millis(turn.startedAt);
            const fresh =
              (end > state.baselineAt && end <= now + 60_000) ||
              (start > state.baselineAt && start <= now + 60_000) ||
              watching.has(turn.id) ||
              (!paginated && row.hydrated && !known.has(turn.id));
            if (!fresh) {
              completed.add(turn.id);
              continue;
            }
            watching.add(turn.id);
            let text = finalAnswer(turn);
            if (!text && paginated && turn === lastCompleted && budget > 0) {
              budget--;
              const items = await this.codex.request<{
                data: {
                  turnId: string;
                  item: NonNullable<Turn["items"]>[number];
                }[];
              }>("thread/items/list", {
                threadId: thread.id,
                turnId: turn.id,
                limit: 10,
                sortDirection: "desc",
              });
              if (this.owner() !== owner) return;
              text = finalAnswer({
                ...turn,
                itemsView: "full",
                items: items.data
                  .filter((entry) => entry.turnId === turn.id)
                  .map((entry) => entry.item)
                  .reverse(),
              });
            }
            if (text && state.baselineComplete) candidates.push({ turn, text });
            else if (text) deferred = true;
          }
          for (const turn of turns) known.add(turn.id);
          // Coalesce rounds completed between polls into the latest final result.
          // Recording all of them avoids a burst of stale follow-up notifications.
          const latest = candidates.at(-1);
          for (const { turn } of candidates) {
            completed.add(turn.id);
            watching.delete(turn.id);
          }
          row.known = [...known];
          row.watching = [...watching];
          row.completed = [...completed];
          row.hydrated = true;
          row.lastReadAt = now;
          row.pending = deferred;
          const last = turns.at(-1);
          row.unsettled =
            !!last &&
            !completed.has(last.id) &&
            (last.status !== "failed" || !last.completedAt);
          row.retryAt = row.unsettled
            ? now +
              Math.min(
                300_000,
                Math.max(this.interval, 1000) * 2 ** row.retryCount++,
              )
            : undefined;
          if (this.owner() !== owner) return;
          // A desktop thread may have been adopted by a Bridge task while an
          // asynchronous history request was in flight. Its task owns the reply.
          if (this.excluded().has(thread.id)) {
            delete state.threads[thread.id];
            this.store.setSetting(key, state);
            continue;
          }
          this.store.transaction(() => {
            if (latest) {
              const label = safeText(
                thread.name ||
                  row.metadata.name ||
                  path.basename(thread.cwd || row.metadata.cwd || "Codex"),
                100,
              ).replace(/[\r\n\t]+/g, " ");
              const id = this.notifications.enqueue(
                desktopCompletionMessage(label, latest.text),
                `${PREFIX}${ownerHash}:${thread.id}:${latest.turn.id}`,
                owner,
                "notification",
                millis(latest.turn.completedAt) || now,
              );
              if (id) this.info.lastEnqueuedAt = now;
            }
            // Muted notifications are consumed too: enabling push does not replay them.
            this.store.setSetting(key, state);
          });
        } catch (error) {
          // An enqueue/storage failure must not commit the turn as delivered.
          Object.assign(row, before);
          row.pending = true;
          row.lastReadAt = now;
          row.retryAt =
            now +
            Math.min(
              300_000,
              Math.max(this.interval, 1000) * 2 ** row.retryCount++,
            );
          this.info.error = safeText(
            error instanceof Error ? error.message : "Codex 完成通知检查失败",
            300,
          );
          if (this.owner() === owner) this.store.setSetting(key, state);
        }
      }
      if (this.owner() !== owner) return;
      this.info.status = state.baselineComplete ? "watching" : "baselining";
      this.info.baselineAt = state.baselineAt;
      this.info.trackedThreads = Object.keys(state.threads).length;
      this.info.pendingThreads = Object.values(state.threads).filter(
        (row) => row.pending || row.unsettled,
      ).length;
      this.info.lastSuccessAt = now;
    } catch (error) {
      this.info.error = safeText(
        error instanceof Error ? error.message : "Codex 完成通知检查失败",
        300,
      );
    } finally {
      this.busy = false;
    }
  }
}
