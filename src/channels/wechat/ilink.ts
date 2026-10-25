import { randomBytes, randomUUID } from "node:crypto";
import type {
  ChannelStatus,
  InboundMessage,
  SendResult,
  WeChatAdapter,
} from "../../app/types.js";
import type { SecretVault } from "../../security/vault.js";
import type { Store } from "../../storage/store.js";
const BASE = "https://ilinkai.weixin.qq.com";
interface Credentials {
  token: string;
  botId: string;
  userId: string;
  baseUrl: string;
}
interface Context {
  token: string;
  updatedAt: number;
}
export class DeliveryUncertainError extends Error {}
export function trustedBase(value: string): string {
  const u = new URL(value.includes("://") ? value : `https://${value}`);
  if (
    u.protocol !== "https:" ||
    u.port ||
    u.username ||
    u.password ||
    !(
      u.hostname === "ilinkai.weixin.qq.com" ||
      u.hostname.endsWith(".weixin.qq.com")
    ) ||
    u.pathname !== "/" ||
    u.search ||
    u.hash
  )
    throw new Error("微信返回了不受信任的 API 地址");
  return u.origin;
}
export class ILinkAdapter implements WeChatAdapter {
  private state: ChannelStatus = "DISCONNECTED";
  private credentials?: Credentials;
  private contexts: Record<string, Context> = {};
  private controller?: AbortController;
  private loop?: Promise<void>;
  private handler?: (m: InboundMessage) => Promise<void>;
  private qr?: {
    id: string;
    code: string;
    content: string;
    base: string;
    createdAt: number;
  };
  private candidate?: Credentials;
  lastError?: string;
  constructor(
    private store: Store,
    private vault: SecretVault,
    private fetcher: typeof fetch = fetch,
  ) {}
  receiveMessage(h: (m: InboundMessage) => Promise<void>) {
    this.handler = h;
  }
  getConnectionStatus() {
    return this.state;
  }
  private headers(post: boolean, token?: string): Record<string, string> {
    return {
      "iLink-App-Id": "bot",
      "iLink-App-ClientVersion": String(0x000100),
      ...(post
        ? {
            "Content-Type": "application/json",
            AuthorizationType: "ilink_bot_token",
            "X-WECHAT-UIN": Buffer.from(
              String(randomBytes(4).readUInt32BE()),
            ).toString("base64"),
          }
        : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }
  private async api(
    base: string,
    endpoint: string,
    body?: unknown,
    token?: string,
    timeout = 15000,
    external?: AbortSignal,
  ): Promise<any> {
    const signal = external
      ? AbortSignal.any([external, AbortSignal.timeout(timeout)])
      : AbortSignal.timeout(timeout);
    const r = await this.fetcher(`${trustedBase(base)}/${endpoint}`, {
      method: body === undefined ? "GET" : "POST",
      headers: this.headers(body !== undefined, token),
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
      redirect: "error",
    });
    if (!r.ok) throw new Error(`微信 HTTP ${r.status}`);
    const raw = await r.text();
    if (raw.length > 4_000_000) throw new Error("微信响应过大");
    const data = JSON.parse(raw, ((
      _: string,
      v: unknown,
      c?: { source: string },
    ) =>
      typeof v === "number" && !Number.isSafeInteger(v) && c
        ? c.source
        : v) as any);
    if (data.ret === -14 || data.errcode === -14) {
      this.state = "AUTH_REQUIRED";
      throw new Error("微信授权失效，请重新扫码");
    }
    if (
      (data.ret !== undefined && data.ret !== 0) ||
      (data.errcode !== undefined && data.errcode !== 0)
    )
      throw new Error(`微信业务错误 ${data.errcode ?? data.ret}`);
    return data;
  }
  async startLogin() {
    await this.disconnect();
    this.candidate = undefined;
    const r = await this.api(BASE, "ilink/bot/get_bot_qrcode?bot_type=3", {
      local_token_list: [],
    });
    if (
      typeof r.qrcode !== "string" ||
      typeof r.qrcode_img_content !== "string"
    )
      throw new Error("微信未返回有效二维码");
    this.qr = {
      id: randomUUID(),
      code: r.qrcode,
      content: r.qrcode_img_content,
      base: BASE,
      createdAt: Date.now(),
    };
    return { id: this.qr.id, content: this.qr.content };
  }
  async pollLogin(id: string, verifyCode?: string) {
    const q = this.qr;
    if (!q || q.id !== id) throw new Error("扫码会话不匹配");
    if (Date.now() - q.createdAt > 300000) return { status: "expired" };
    if (this.candidate)
      return {
        status: "local_confirmation_required",
        userId: this.candidate.userId,
      };
    const r = await this.api(
      q.base,
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(q.code)}${verifyCode ? `&verify_code=${encodeURIComponent(verifyCode)}` : ""}`,
      undefined,
      undefined,
      40000,
    );
    if (r.status === "scaned_but_redirect" && r.redirect_host)
      q.base = trustedBase(r.redirect_host);
    if (r.status === "confirmed") {
      if (!r.bot_token || !r.ilink_user_id || !r.ilink_bot_id)
        throw new Error("扫码响应缺少身份信息");
      this.candidate = {
        token: r.bot_token,
        botId: r.ilink_bot_id,
        userId: r.ilink_user_id,
        baseUrl: trustedBase(r.baseurl || BASE),
      };
      return {
        status: "local_confirmation_required",
        userId: this.candidate.userId,
      };
    }
    return { status: String(r.status ?? "wait") };
  }
  async confirmBinding(userId: string) {
    if (!this.candidate || this.candidate.userId !== userId)
      throw new Error("待绑定身份不匹配");
    const existing = this.store.setting<string | undefined>(
      "boundUser",
      undefined,
    );
    if (existing && existing !== userId)
      throw new Error("请先在本机解除旧用户绑定");
    this.vault.set("wechat-credentials", this.candidate);
    this.store.setSetting("boundUser", userId);
    this.candidate = undefined;
    this.qr = undefined;
    await this.connect();
  }
  async unbind() {
    await this.disconnect();
    this.credentials = undefined;
    this.contexts = {};
    this.candidate = undefined;
    this.qr = undefined;
    this.vault.delete("wechat-credentials");
    this.vault.delete("wechat-contexts");
    this.store.setSetting("boundUser", null);
    this.store.setSetting("wechatCursor", "");
  }
  async connect() {
    if (this.loop) return;
    this.credentials = this.vault.get<Credentials>("wechat-credentials");
    if (!this.credentials) {
      this.state = "AUTH_REQUIRED";
      return;
    }
    trustedBase(this.credentials.baseUrl);
    this.contexts =
      this.vault.get<Record<string, Context>>("wechat-contexts") ?? {};
    this.controller = new AbortController();
    this.state = "CONNECTING";
    this.loop = this.poll(this.controller.signal).finally(() => {
      this.loop = undefined;
    });
  }
  async disconnect() {
    this.controller?.abort();
    await this.loop;
    this.state = "DISCONNECTED";
  }
  async reconnect() {
    await this.disconnect();
    await this.connect();
  }
  private async poll(signal: AbortSignal) {
    let failures = 0;
    while (!signal.aborted && this.credentials) {
      try {
        const r = await this.api(
          this.credentials.baseUrl,
          "ilink/bot/getupdates",
          {
            get_updates_buf: this.store.setting("wechatCursor", ""),
            base_info: {
              channel_version: "0.1.0",
              bot_agent: "CodexWeChatBridge",
            },
          },
          this.credentials.token,
          40000,
          signal,
        );
        this.state = "CONNECTED";
        this.lastError = undefined;
        failures = 0;
        for (const raw of r.msgs ?? []) {
          if (
            raw.message_type !== 1 ||
            raw.message_state !== 2 ||
            !raw.from_user_id ||
            raw.from_user_id !== this.store.setting("boundUser", null) ||
            raw.group_id
          )
            continue;
          const id = raw.message_id ?? raw.client_id;
          if (id === undefined) continue;
          const items = Array.isArray(raw.item_list) ? raw.item_list : [];
          const text = items
            .filter((i: any) => i.type === 1)
            .map((i: any) => i.text_item?.text ?? "")
            .join("\n");
          if (!text) continue;
          if (raw.context_token) {
            this.contexts[raw.from_user_id] = {
              token: raw.context_token,
              updatedAt: Date.now(),
            };
            this.vault.set("wechat-contexts", this.contexts);
          }
          await this.handler?.({
            id: `${this.credentials.botId}:${String(id)}`,
            userId: raw.from_user_id,
            text: text.slice(0, 12000),
            sentAt: Number(raw.create_time_ms),
            kind: items.some((i: any) => i.ref_msg || i.type !== 1)
              ? "forwarded"
              : "direct",
          });
        }
        if (typeof r.get_updates_buf === "string" && r.get_updates_buf)
          this.store.setSetting("wechatCursor", r.get_updates_buf);
        // Avoid a tight loop when a server immediately returns empty results.
        await this.pause(100, signal);
      } catch {
        if (signal.aborted) break;
        if (this.state === "AUTH_REQUIRED") {
          this.lastError = "授权失效，需要重新扫码";
          break;
        }
        this.state = "RECONNECTING";
        this.lastError = "微信连接或消息处理失败，正在退避重试";
        await this.pause(
          Math.min(60000, 1000 * 2 ** Math.min(++failures, 6)),
          signal,
        );
      }
    }
  }
  private pause(ms: number, signal: AbortSignal) {
    return new Promise<void>((resolve) => {
      const done = () => {
        clearTimeout(t);
        signal.removeEventListener("abort", done);
        resolve();
      };
      const t = setTimeout(done, ms);
      signal.addEventListener("abort", done, { once: true });
      if (signal.aborted) done();
    });
  }
  async sendMessage(
    userId: string,
    text: string,
    clientId: string,
  ): Promise<SendResult> {
    const c = this.credentials;
    const context = this.contexts[userId];
    if (!c || this.state === "AUTH_REQUIRED") throw new Error("微信尚未授权");
    if (!context) throw new Error("缺少回复上下文，请先在微信发送 /help");
    if (Date.now() - context.updatedAt > 24 * 3600000)
      throw new Error("回复上下文已超过本地有效期，请在微信发送新消息");
    try {
      await this.api(
        c.baseUrl,
        "ilink/bot/sendmessage",
        {
          msg: {
            from_user_id: "",
            to_user_id: userId,
            client_id: clientId,
            message_type: 2,
            message_state: 2,
            context_token: context.token,
            item_list: [{ type: 1, text_item: { text } }],
          },
          base_info: {
            channel_version: "0.1.0",
            bot_agent: "CodexWeChatBridge",
          },
        },
        c.token,
      );
      return { status: "server_accepted", clientVisible: false };
    } catch (e) {
      if (e instanceof Error && /业务错误|授权失效|HTTP 4\d\d/.test(e.message))
        throw e;
      throw new DeliveryUncertainError(
        "请求可能已到达微信服务端，投递未验证；不自动重发",
      );
    }
  }
}
