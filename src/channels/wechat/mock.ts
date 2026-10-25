import type {
  WeChatAdapter,
  InboundMessage,
  SendResult,
} from "../../app/types.js";
export class MockWeChat implements WeChatAdapter {
  sent: { userId: string; text: string; clientId: string }[] = [];
  fail = false;
  connected = false;
  private handler?: (m: InboundMessage) => Promise<void>;
  async connect() {
    this.connected = true;
  }
  async disconnect() {
    this.connected = false;
  }
  async reconnect() {
    await this.connect();
  }
  receiveMessage(h: (m: InboundMessage) => Promise<void>) {
    this.handler = h;
  }
  async inject(m: InboundMessage) {
    await this.handler?.(m);
  }
  async sendMessage(
    userId: string,
    text: string,
    clientId: string,
  ): Promise<SendResult> {
    if (this.fail || !this.connected) throw new Error("模拟网络断开");
    this.sent.push({ userId, text, clientId });
    return { status: "server_accepted", clientVisible: false };
  }
  getConnectionStatus() {
    return this.connected ? ("MOCK" as const) : ("DISCONNECTED" as const);
  }
}
