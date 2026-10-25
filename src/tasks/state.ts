import type { TaskStatus } from "../app/types.js";
export const terminal = (s: TaskStatus) =>
  ["COMPLETED", "FAILED", "INTERRUPTED"].includes(s);
const edges: Record<TaskStatus, TaskStatus[]> = {
  QUEUED: ["RUNNING", "WAITING_APPROVAL", "FAILED", "INTERRUPTED", "UNKNOWN"],
  RUNNING: [
    "WAITING_APPROVAL",
    "WAITING_PROCESS",
    "COMPLETED",
    "FAILED",
    "INTERRUPTED",
    "UNKNOWN",
    "QUEUED",
  ],
  WAITING_APPROVAL: [
    "QUEUED",
    "RUNNING",
    "WAITING_PROCESS",
    "INTERRUPTED",
    "FAILED",
    "UNKNOWN",
  ],
  WAITING_PROCESS: [
    "RUNNING",
    "WAITING_APPROVAL",
    "COMPLETED",
    "FAILED",
    "INTERRUPTED",
    "UNKNOWN",
  ],
  IDLE: ["QUEUED"],
  COMPLETED: [],
  FAILED: [],
  INTERRUPTED: [],
  UNKNOWN: [
    "QUEUED",
    "RUNNING",
    "WAITING_PROCESS",
    "WAITING_APPROVAL",
    "COMPLETED",
    "FAILED",
    "INTERRUPTED",
  ],
};
export function assertTransition(from: TaskStatus, to: TaskStatus) {
  if (from !== to && !edges[from].includes(to))
    throw new Error(`不允许状态转换 ${from} → ${to}`);
}
