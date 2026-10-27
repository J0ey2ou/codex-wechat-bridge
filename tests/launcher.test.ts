import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const moduleUrl = pathToFileURL(path.resolve("scripts/launch-config.mjs")).href;
const { resolveLaunchConfig } = await import(moduleUrl);
function fixture() {
  const directory = mkdtempSync(path.join(tmpdir(), "robinson-launch-"));
  return {
    directory,
    cleanup() {
      assert.equal(path.dirname(directory), path.resolve(tmpdir()));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("portable launch retains the existing data and Codex home without copying credentials", () => {
  const f = fixture();
  try {
    const app = path.join(f.directory, "release/鲁滨逊/app");
    mkdirSync(app, { recursive: true });
    writeFileSync(
      path.join(f.directory, "package.json"),
      JSON.stringify({ name: "robinson-app" }),
    );
    writeFileSync(
      path.join(f.directory, "config.local.json"),
      JSON.stringify({
        port: 3215,
        dataDir: "data",
        codexTransport: "chatgpt-http",
        wechatToken: "must-not-copy",
        secret: "must-not-copy",
      }),
    );
    const home = path.join(f.directory, "user settings");
    const codexHome = path.join(f.directory, "codex home");
    const env = {
      ROBINSON_PACKAGED: "1",
      ROBINSON_HOME: home,
      CODEX_HOME: codexHome,
    };
    const result = resolveLaunchConfig(app, env);
    assert.equal(result.data, path.join(f.directory, "data"));
    assert.equal(result.cwd, f.directory);
    assert.equal(result.port, 3215);
    assert.equal(result.config.codexTransport, "chatgpt-http");
    const persisted = readFileSync(result.file, "utf8");
    assert.ok(!persisted.includes("must-not-copy"));
    const next = resolveLaunchConfig(app, {
      ROBINSON_PACKAGED: "1",
      ROBINSON_HOME: home,
    });
    assert.equal(next.env.CODEX_HOME, codexHome);
    assert.equal(next.data, result.data);
    assert.equal(existsSync(path.join(app, "data")), false);
  } finally {
    f.cleanup();
  }
});

test("fresh portable launch stores user data outside the distribution", () => {
  const f = fixture();
  try {
    // Keep this fresh-install fixture beyond ancestor discovery of the real repo
    // when the sandbox requires TEMP to be inside the workspace.
    const app = path.join(f.directory, "isolated/a/b/c/d/portable/app");
    const home = path.join(f.directory, "profile/Robinson");
    mkdirSync(app, { recursive: true });
    const result = resolveLaunchConfig(app, {
      ROBINSON_PACKAGED: "1",
      ROBINSON_HOME: home,
    });
    assert.equal(result.data, path.join(home, "data"));
    assert.equal(result.file, path.join(home, "config.json"));
    assert.equal(result.cwd, home);
    assert.equal(existsSync(path.join(app, "data")), false);
  } finally {
    f.cleanup();
  }
});

test("explicit launch configuration and environment overrides are preserved", () => {
  const f = fixture();
  try {
    const file = path.join(f.directory, "explicit.json");
    const original = JSON.stringify({ port: 3215, dataDir: "private-data" });
    writeFileSync(file, original);
    const result = resolveLaunchConfig(f.directory, {
      ROBINSON_PACKAGED: "1",
      ROBINSON_HOME: path.join(f.directory, "unused"),
      BRIDGE_CONFIG: file,
      BRIDGE_DATA_DIR: path.join(f.directory, "override"),
      BRIDGE_PORT: "3216",
    });
    assert.equal(result.data, path.join(f.directory, "override"));
    assert.equal(result.port, 3216);
    assert.equal(readFileSync(file, "utf8"), original);
    assert.equal(existsSync(path.join(f.directory, "unused")), false);
  } finally {
    f.cleanup();
  }
});

test("portable runtime uses its bundled Codex without losing the existing account home or explicit override", () => {
  const f = fixture();
  try {
    const app = path.join(f.directory, "portable/app"),
      runtime = path.join(f.directory, "portable/runtime/codex");
    mkdirSync(app, { recursive: true });
    mkdirSync(runtime, { recursive: true });
    writeFileSync(path.join(runtime, "codex.exe"), "fixture");
    const env = {
      ROBINSON_PACKAGED: "1",
      ROBINSON_HOME: path.join(f.directory, "home"),
      CODEX_HOME: path.join(f.directory, "account"),
    };
    const result = resolveLaunchConfig(app, env);
    assert.equal(result.env.BRIDGE_CODEX_BIN, path.join(runtime, "codex.exe"));
    assert.equal(result.env.CODEX_HOME, env.CODEX_HOME);
    assert.equal(
      resolveLaunchConfig(app, { ...env, BRIDGE_CODEX_BIN: "custom.exe" }).env
        .BRIDGE_CODEX_BIN,
      "custom.exe",
    );
  } finally {
    f.cleanup();
  }
});
