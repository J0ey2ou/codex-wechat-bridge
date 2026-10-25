import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/storage/store.js";
import { MemoryVault } from "../src/security/vault.js";
import {
  ILinkAdapter,
  trustedBase,
  DeliveryUncertainError,
} from "../src/channels/wechat/ilink.js";
function setup(fetcher: typeof fetch) {
  const store = new Store(":memory:");
  store.setSetting("boundUser", "owner");
  const vault = new MemoryVault();
  vault.set("wechat-credentials", {
    token: "test-secret",
    botId: "bot",
    userId: "owner",
    baseUrl: "https://ilinkai.weixin.qq.com",
  });
  vault.set("wechat-contexts", {
    owner: { token: "context", updatedAt: Date.now() },
  });
  return { store, vault, channel: new ILinkAdapter(store, vault, fetcher) };
}
const response = (value: unknown) =>
  new Response(JSON.stringify(value), { status: 200 });
test("QR request follows current POST wire format and requires explicit local confirmation", async () => {
  const calls: any[] = [];
  const f = setup((async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("get_bot_qrcode"))
      return response({
        qrcode: "qr",
        qrcode_img_content: "https://example.test/scan",
      });
    if (String(url).includes("get_qrcode_status"))
      return response({
        status: "confirmed",
        bot_token: "new-secret",
        ilink_bot_id: "bot",
        ilink_user_id: "owner",
        baseurl: "https://ilinkai.weixin.qq.com",
      });
    return response({ ret: 0, msgs: [] });
  }) as typeof fetch);
  const q = await f.channel.startLogin();
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { local_token_list: [] });
  assert.equal(calls[0].init.headers.Authorization, undefined);
  const s = await f.channel.pollLogin(q.id);
  assert.equal(s.status, "local_confirmation_required");
  assert.equal(f.vault.get<any>("wechat-credentials").token, "test-secret");
  await assert.rejects(f.channel.confirmBinding("attacker"));
  await f.channel.confirmBinding("owner");
  assert.equal(f.vault.get<any>("wechat-credentials").token, "new-secret");
  await f.channel.disconnect();
});
test("redirect validation prevents sending bot credentials to another host", () => {
  for (const bad of [
    "http://ilinkai.weixin.qq.com",
    "https://evil.test",
    "https://weixin.qq.com.evil.test",
    "https://ilinkai.weixin.qq.com:8443",
    "https://user@ilinkai.weixin.qq.com",
    "https://ilinkai.weixin.qq.com/path",
  ])
    assert.throws(() => trustedBase(bad));
  assert.equal(
    trustedBase("ilinkai.weixin.qq.com"),
    "https://ilinkai.weixin.qq.com",
  );
});
test("long poll stores cursor after handler succeeds, updates protected context and dedupes downstream", async () => {
  let received = 0;
  const f = setup((async () =>
    response({
      ret: 0,
      get_updates_buf: "cursor-2",
      msgs: [
        {
          message_id: "9876543210123456789",
          from_user_id: "owner",
          message_type: 1,
          message_state: 2,
          create_time_ms: Date.now(),
          context_token: "new-context",
          item_list: [{ type: 1, text_item: { text: "/status" } }],
        },
      ],
    })) as typeof fetch);
  f.channel.receiveMessage(async (m) => {
    assert.equal(m.id, "bot:9876543210123456789");
    received++;
  });
  await f.channel.connect();
  await new Promise((r) => setTimeout(r, 30));
  await f.channel.disconnect();
  assert.ok(received);
  assert.equal(f.store.setting("wechatCursor", ""), "cursor-2");
  assert.equal(f.vault.get<any>("wechat-contexts").owner.token, "new-context");
});
test("send uses conversation context, stable client id and reports server acceptance only", async () => {
  let payload: any;
  const f = setup((async (url, init) => {
    if (String(url).includes("sendmessage"))
      payload = JSON.parse(String(init?.body));
    return response({ ret: 0, msgs: [] });
  }) as typeof fetch);
  await f.channel.connect();
  const result = await f.channel.sendMessage("owner", "hello", "client-id");
  assert.equal(result.status, "server_accepted");
  assert.equal(result.clientVisible, false);
  assert.equal(payload.msg.context_token, "context");
  assert.equal(payload.msg.client_id, "client-id");
  assert.equal(payload.msg.item_list[0].text_item.text, "hello");
  await f.channel.disconnect();
});
test("send transport timeout is delivery_unverified and not success", async () => {
  const f = setup((async (url) => {
    if (String(url).includes("sendmessage")) throw new Error("timeout");
    return response({ ret: 0, msgs: [] });
  }) as typeof fetch);
  await f.channel.connect();
  await assert.rejects(
    f.channel.sendMessage("owner", "hello", "client-id"),
    DeliveryUncertainError,
  );
  await f.channel.disconnect();
});
test("expired bot authorization stops polling and requests re-login", async () => {
  const f = setup((async () => response({ ret: -14 })) as typeof fetch);
  await f.channel.connect();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.channel.getConnectionStatus(), "AUTH_REQUIRED");
  await f.channel.disconnect();
});
test("failed receive handler does not advance persistent cursor; disconnect aborts backoff", async () => {
  const f = setup((async () =>
    response({
      ret: 0,
      get_updates_buf: "new",
      msgs: [
        {
          message_id: 1,
          from_user_id: "owner",
          message_type: 1,
          message_state: 2,
          create_time_ms: Date.now(),
          item_list: [{ type: 1, text_item: { text: "hello" } }],
        },
      ],
    })) as typeof fetch);
  f.channel.receiveMessage(async () => {
    throw new Error("storage failed");
  });
  await f.channel.connect();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(f.store.setting("wechatCursor", ""), "");
  assert.equal(f.channel.getConnectionStatus(), "RECONNECTING");
  await f.channel.disconnect();
});
