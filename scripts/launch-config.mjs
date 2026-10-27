import {
  existsSync,
  readFileSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import path from "node:path";

const readJson = (file) =>
  JSON.parse(readFileSync(file, "utf8").replace(/^\uFEFF/, ""));
const publicFields = [
  "port",
  "timezone",
  "codexBin",
  "codexMode",
  "codexTransport",
  "wechatMode",
  "collectionMinutes",
  "staleMinutes",
  "timeoutMinutes",
  "approvalMinutes",
  "notifyProgress",
  "wechatPushEnabled",
  "autoContinueLowRisk",
  "executionAuthorization",
  "projectCreationRoot",
];

function findExisting(root) {
  let directory = root;
  for (let i = 0; i < 5; i++) {
    const file = path.join(directory, "config.local.json");
    const manifest = path.join(directory, "package.json");
    if (existsSync(file) && existsSync(manifest)) {
      const name = readJson(manifest).name;
      if (["robinson-app", "codex-wechat-bridge"].includes(name))
        return { directory, config: readJson(file) };
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
}

function findCodex(localAppData) {
  if (!localAppData) return "codex";
  const bin = path.join(localAppData, "OpenAI/Codex/bin");
  if (!existsSync(bin)) return "codex";
  return (
    readdirSync(bin, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join(bin, entry.name, "codex.exe"))
      .filter(existsSync)
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] || "codex"
  );
}

export function resolveLaunchConfig(root, env = process.env) {
  const packaged = env.ROBINSON_PACKAGED === "1";
  const home = path.resolve(
    env.ROBINSON_HOME || path.join(env.LOCALAPPDATA || root, "Robinson"),
  );
  const file = path.resolve(
    root,
    env.BRIDGE_CONFIG ||
      (packaged ? path.join(home, "config.json") : "config.local.json"),
  );
  if (packaged && !env.BRIDGE_CONFIG && !existsSync(file)) {
    const previous = findExisting(root);
    const config = Object.fromEntries(
      publicFields
        .filter((key) => previous?.config[key] !== undefined)
        .map((key) => [key, previous.config[key]]),
    );
    config.dataDir = previous
      ? path.resolve(previous.directory, previous.config.dataDir || "data")
      : path.join(home, "data");
    config.workspaceDir = previous?.directory || home;
    if (env.CODEX_HOME) config.codexHome = path.resolve(env.CODEX_HOME);
    if (
      !config.codexBin ||
      (path.isAbsolute(config.codexBin) && !existsSync(config.codexBin))
    )
      config.codexBin = findCodex(env.LOCALAPPDATA);
    mkdirSync(path.dirname(file), { recursive: true });
    try {
      writeFileSync(file, JSON.stringify(config, null, 2) + "\n", {
        flag: "wx",
      });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
  }
  const config = existsSync(file) ? readJson(file) : {};
  const cwd = packaged
    ? path.resolve(config.workspaceDir || path.dirname(file))
    : root;
  const data = path.resolve(
    cwd,
    env.BRIDGE_DATA_DIR || config.dataDir || "data",
  );
  const childEnv = { ...env, BRIDGE_CONFIG: file, BRIDGE_DATA_DIR: data };
  const bundledCodex = path.resolve(root, "../runtime/codex/codex.exe");
  if (packaged && !env.BRIDGE_CODEX_BIN && existsSync(bundledCodex)) {
    childEnv.BRIDGE_CODEX_BIN = bundledCodex;
    childEnv.ROBINSON_BUNDLED_CODEX = "1";
  }
  if (!childEnv.CODEX_HOME && config.codexHome)
    childEnv.CODEX_HOME = config.codexHome;
  if (
    !childEnv.BRIDGE_CODEX_BIN &&
    (!config.codexBin ||
      (path.isAbsolute(config.codexBin) && !existsSync(config.codexBin)))
  )
    childEnv.BRIDGE_CODEX_BIN = findCodex(env.LOCALAPPDATA);
  return {
    config,
    file,
    cwd,
    data,
    env: childEnv,
    port: Number(env.BRIDGE_PORT || config.port || 3210),
  };
}
