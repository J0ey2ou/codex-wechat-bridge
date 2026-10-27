export type TaskStatus =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "WAITING_PROCESS"
  | "IDLE"
  | "COMPLETED"
  | "FAILED"
  | "INTERRUPTED"
  | "UNKNOWN";
export interface Project {
  id: string;
  name: string;
  path: string;
  codexProjectId?: string;
  requestedModel?: string;
  executionModel?: string;
  creationId?: string;
  visibilityError?: string;
  sessionCodexProjectId?: string;
  sessionsByCodexProject?: Record<string, string>;
  sessionId?: string;
  sessionOrigin?: "bridge" | "desktop-fork";
  createdAt: number;
}
export interface Stage {
  title: string;
  prompt: string;
  requiresApproval: boolean;
  lowRisk: boolean;
}
export interface Task {
  id: string;
  projectId: string;
  codexProjectId?: string;
  requestedModel?: string;
  executionModel?: string;
  modelMismatch?: string;
  creationId?: string;
  title: string;
  sourceMessageId?: string;
  sourceMessageIds?: string[];
  routingRequestId?: string;
  targetThreadId?: string;
  targetThreadName?: string;
  targetVerifiedAt?: number;
  targetResumedAt?: number;
  targetWaitReason?: string;
  targetCheckAfter?: number;
  continuesTaskId?: string;
  continuationFingerprint?: string;
  expectedHistoryRevision?: string;
  dispatchAttemptId?: string;
  reconciliationAfter?: number;
  reconciliationNote?: string;
  pdfRequested?: boolean;
  pdfReportId?: string;
  pdfRetryAfter?: number;
  pdfAttempts?: number;
  pdfError?: string;
  status: TaskStatus;
  stages: Stage[];
  stageIndex: number;
  threadId?: string;
  turnId?: string;
  createdAt: number;
  startedAt?: number;
  queueOrder?: number;
  endedAt?: number;
  lastActivityAt: number;
  lastEvent: string;
  summary?: string;
  userMessage?: string;
  files: string[];
  tests: string[];
  processIds: string[];
  error?: string;
}
export interface Approval {
  id: string;
  taskId: string;
  kind: "stage" | "command" | "file" | "unsupported";
  status: "pending" | "resolving" | "approved" | "rejected" | "expired";
  createdAt: number;
  expiresAt: number;
  description: string;
  risk: string;
  rpcId?: number | string;
  connectionId?: string;
  threadId?: string;
  turnId?: string;
  method?: string;
  allowed: boolean;
  localOnly?: boolean;
}
export interface InboundMessage {
  id: string;
  userId: string;
  text: string;
  sentAt: number;
  kind: "direct" | "forwarded";
  contextToken?: string;
  transportReceivedAt?: number;
}
export interface StoredMessage extends InboundMessage {
  receivedAt: number;
  status: "received" | "processing" | "processed" | "uncertain" | "rejected";
  collectAt?: number;
  routedAt?: number;
}
export interface Todo {
  id: string;
  title: string;
  status: "open" | "draft" | "done" | "cancelled";
  dueAt?: number;
  sourceId: string;
  sourceText: string;
  parsedAt: number;
  ambiguity?: string;
  dedupeKey: string;
}
export interface Reminder {
  id: string;
  todoId: string;
  dueAt: number;
  repeatMinutes?: number;
  status: "scheduled" | "queued" | "cancelled";
  deliveryId?: string;
}
export interface Delivery {
  id: string;
  userId: string;
  text: string;
  kind?: "reply" | "notification";
  notificationEpoch?: number;
  occurredAt?: number;
  suppressedAt?: number;
  status:
    | "pending"
    | "sending"
    | "retry"
    | "server_accepted"
    | "delivery_unverified"
    | "failed"
    | "cancelled"
    | "suppressed";
  attempts: number;
  nextAttemptAt: number;
  createdAt: number;
  error?: string;
  acceptedAt?: number;
  clientVisible: false;
  dedupeKey: string;
  sequence?: number;
  messageId?: string;
  documentId?: string;
  receipt?: boolean;
  expiresAt?: number;
  backendOnly?: boolean;
  detailText?: string;
  policyRevision?: number;
  layout?: "paragraph" | "structured";
  sendStartedAt?: number;
  sendFinishedAt?: number;
}
export interface RpcEvent {
  method: string;
  params: Record<string, any>;
  id?: string | number;
  connectionId: string;
}
export interface CodexController {
  connectionId: string;
  connected: boolean;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  request<T = any>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T>;
  respond(id: string | number, result: unknown): void;
  reject(id: string | number, message: string): void;
  onEvent(handler: (event: RpcEvent) => void): void;
}
export type ChannelStatus =
  | "DISCONNECTED"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "AUTH_REQUIRED"
  | "MOCK";
export interface SendResult {
  status: "server_accepted" | "delivery_unverified";
  clientVisible: false;
}
export interface WeChatAdapter {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  reconnect(): Promise<void>;
  receiveMessage(handler: (message: InboundMessage) => Promise<void>): void;
  sendMessage(
    userId: string,
    text: string,
    clientId: string,
  ): Promise<SendResult>;
  sendFile?(
    userId: string,
    file: { name: string; bytes: Buffer },
    clientId: string,
  ): Promise<SendResult>;
  getConnectionStatus(): ChannelStatus;
}
