import { AppServerClient } from "../src/codex/client.js";
import { loadConfig } from "../src/app/config.js";

// Register only the provider definition, never change the user's default model/provider.
// No thread is started, resumed, or interrupted by this repair.
const config = loadConfig();
const client = new AppServerClient(config.codexBin);
const provider = {
  name: "ChatGPT HTTP",
  requires_openai_auth: true,
  supports_websockets: false,
};
try {
  await client.connect();
  const before = await client.request("config/read", { includeLayers: true });
  const current = before.config?.model_providers?.bridge_http;
  const user = before.layers?.find((layer: any) => layer.name?.type === "user" && !layer.name?.profile);
  if (process.argv.includes("--apply") && !current) {
    if (!user?.name?.file || !user.version) throw new Error("无法确认用户配置文件及版本，未修改配置");
    await client.request("config/value/write", {
      keyPath: "model_providers.bridge_http",
      value: provider,
      mergeStrategy: "upsert",
      filePath: user.name.file,
      expectedVersion: user.version,
    });
  }
  const after = await client.request("config/read", { includeLayers: true });
  const registered = after.config?.model_providers?.bridge_http;
  console.log(JSON.stringify({
    mode: process.argv.includes("--apply") ? "repair" : "inspect",
    userConfig: user?.name?.file,
    userVersionAvailable: Boolean(user?.version),
    providerPresent: Boolean(registered),
    providerCompatible: Boolean(registered && Object.entries(provider).every(([key, value]) => registered[key] === value)),
    defaultProviderUnchanged: before.config?.model_provider === after.config?.model_provider,
    defaultModelUnchanged: before.config?.model === after.config?.model,
  }));
} finally {
  await client.disconnect();
}
