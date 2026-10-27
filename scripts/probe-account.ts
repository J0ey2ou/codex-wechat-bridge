import { AppServerClient, appServerArgs } from "../src/codex/client.js";
import { loadConfig } from "../src/app/config.js";
import { answerAccount } from "../src/codex/account.js";
import { safeText } from "../src/security/policy.js";
const config = loadConfig();
const c = new AppServerClient(
  config.codexBin,
  appServerArgs(config.codexTransport),
);
try {
  await c.connect();
  console.log(await answerAccount(c, "我还有多少token", config.timezone));
} catch (e) {
  console.log(safeText(String(e)));
  process.exitCode = 1;
} finally {
  await c.disconnect();
}
