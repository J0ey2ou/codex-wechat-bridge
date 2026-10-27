import type { CodexController } from "../app/types.js";

export function billingSource(type: unknown) {
  return type === "chatgpt"
    ? "chatgpt-plan"
    : type === "apiKey" || type === "apikey"
      ? "openai-api"
      : type === "mock"
        ? "mock"
        : "unknown";
}
export function officialAuthUrl(value: unknown): string {
  const url = new URL(String(value));
  if (
    url.protocol !== "https:" ||
    !["auth.openai.com", "chatgpt.com"].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.port
  )
    throw new Error("登录服务未返回受支持的 OpenAI 官方地址");
  return url.href;
}
export class OpenAIAuth {
  private pending?: { id: string; url: string; expiresAt: number };
  private starting = false;
  private signingOut = false;
  private early = new Map<string, boolean>();
  private state = "idle";
  get busy() {
    return this.starting || this.signingOut || !!this.pending;
  }
  async expire() {
    if (this.pending && Date.now() > this.pending.expiresAt)
      await this.cancel();
  }
  constructor(
    private codex: CodexController,
    private mock = false,
  ) {
    codex.onEvent((e) => {
      if (e.connectionId !== codex.connectionId) return;
      if (e.method === "bridge/disconnected") {
        this.pending = undefined;
        this.state = "disconnected";
      }
      if (e.method === "account/login/completed") {
        const id = String(e.params.loginId);
        if (this.starting && !this.pending)
          this.early.set(id, e.params.success === true);
        if (id === this.pending?.id) this.complete(e.params.success === true);
      }
    });
  }
  private complete(success: boolean) {
    this.pending = undefined;
    this.state = success ? "completed" : "failed";
  }
  async status() {
    const r = await this.codex.request("account/read", { refreshToken: false });
    await this.expire();
    return {
      provider: "OpenAI",
      connected: this.codex.connected,
      accountType: r.account?.type ?? null,
      planType: r.account?.planType ?? null,
      billingSource: this.mock
        ? "mock"
        : r.requiresOpenaiAuth === true
          ? billingSource(r.account?.type)
          : "unknown",
      requiresOpenaiAuth: r.requiresOpenaiAuth,
      loginState: this.state,
      pending: !!this.pending,
      checkedAt: Date.now(),
    };
  }
  async start() {
    if (this.mock) throw new Error("Mock 模式不发起真实 OpenAI 登录");
    if (this.starting || this.signingOut)
      throw new Error("登录正在切换，请稍候");
    if (this.pending && Date.now() < this.pending.expiresAt)
      return { url: this.pending.url, expiresAt: this.pending.expiresAt };
    this.starting = true;
    try {
      if (this.pending) {
        await this.codex.request("account/login/cancel", {
          loginId: this.pending.id,
        });
        this.pending = undefined;
      }
      const r = await this.codex.request("account/login/start", {
        type: "chatgpt",
      });
      if (r.type !== "chatgpt" || typeof r.loginId !== "string")
        throw new Error("Codex 版本不支持此登录流程");
      let url: string;
      try {
        url = officialAuthUrl(r.authUrl);
      } catch (error) {
        await this.codex
          .request("account/login/cancel", { loginId: r.loginId })
          .catch(() => {});
        throw error;
      }
      this.pending = {
        id: r.loginId,
        url,
        expiresAt: Date.now() + 10 * 60_000,
      };
      this.state = "pending";
      const response = { url, expiresAt: this.pending.expiresAt };
      if (this.early.has(r.loginId)) this.complete(this.early.get(r.loginId)!);
      return response;
    } finally {
      this.starting = false;
      this.early.clear();
    }
  }
  async cancel() {
    if (this.starting) throw new Error("登录正在启动，请稍候");
    if (this.pending)
      await this.codex.request("account/login/cancel", {
        loginId: this.pending.id,
      });
    this.pending = undefined;
    this.state = "cancelled";
  }
  async logout() {
    if (this.signingOut || this.starting)
      throw new Error("登录正在切换，请稍候");
    this.signingOut = true;
    try {
      await this.cancel();
      await this.codex.request("account/logout");
      this.state = "signed-out";
    } finally {
      this.signingOut = false;
    }
  }
}
