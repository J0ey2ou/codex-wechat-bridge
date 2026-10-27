import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AppCatalog, type AppLaunchTarget } from "../src/computer/apps.js";

test("application discovery merges sources, skips stale shortcuts, and finds portable workspace builds", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-apps-"));
  try {
    const workspace = path.join(root, "Sample-app"),
      install = path.join(workspace, "release", "SampleManager"),
      data = path.join(install, "data"),
      roaming = path.join(root, "roaming");
    await mkdir(data, { recursive: true });
    await mkdir(path.join(roaming, "SampleManager"), { recursive: true });
    const exe = path.join(install, "SampleManager.exe");
    await writeFile(exe, "fixture");
    const intermediate = path.join(workspace, "build", "SampleManager");
    await mkdir(intermediate, { recursive: true });
    await writeFile(
      path.join(intermediate, "SampleManager.exe"),
      "intermediate",
    );
    const opened: AppLaunchTarget[] = [];
    const catalog = new AppCatalog({
      discover: async () => [
        {
          name: "Broken app",
          source: "shortcut",
          path: path.join(root, "missing.exe"),
        },
        { name: "Sample Manager", source: "running", path: exe },
      ],
      launch: async (target) => {
        opened.push(target);
      },
      appDataRoots: [roaming],
    });
    const apps = await catalog.refresh([
      { path: workspace, name: "Sample-app" },
    ]);
    assert.equal(apps.length, 1);
    assert.equal(apps[0]!.running, true);
    assert.deepEqual(apps[0]!.sources, ["running", "workspace"]);
    assert.ok(apps[0]!.aliases!.includes("Sample-app"));
    assert.ok(apps[0]!.dataRoots!.includes(data));
    assert.ok(
      apps[0]!.dataRoots!.includes(path.join(roaming, "SampleManager")),
    );
    assert.ok(apps[0]!.dataRoots!.includes(workspace));
    assert.equal((await catalog.open(apps[0]!.id)).status, "launch_requested");
    assert.deepEqual(opened, [
      { kind: "exe", value: exe, workingDirectory: install },
    ]);
    assert.equal(
      (await catalog.refresh([{ path: workspace, name: "Sample-app" }]))[0]!.id,
      apps[0]!.id,
    );
    await assert.rejects(catalog.open(exe), /不在当前发现列表/);
    await rm(exe);
    await assert.rejects(catalog.open(apps[0]!.id), /文件已不存在/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("app IDs must originate in StartApps and cannot contain a command or URL", async () => {
  const opened: AppLaunchTarget[] = [];
  const catalog = new AppCatalog({
    discover: async () => [
      {
        name: "Calendar",
        source: "start-apps",
        appId: "Vendor.Calendar_123!App",
      },
      { name: "URL", source: "start-apps", appId: "https://example.com" },
      { name: "Injected", source: "start-apps", appId: "Vendor.App!App; calc" },
      { name: "Wrong source", source: "running", appId: "Vendor.Other!App" },
    ],
    launch: async (target) => {
      opened.push(target);
    },
    appDataRoots: [],
    workspaceScan: false,
  });
  const apps = await catalog.refresh();
  assert.equal(apps.length, 1);
  await catalog.open(apps[0]!.id);
  assert.deepEqual(opened, [
    { kind: "app-id", value: "Vendor.Calendar_123!App" },
  ]);
  const copy = catalog.snapshot();
  copy[0]!.name = "changed";
  copy[0]!.aliases!.push("changed");
  copy[0]!.sources.push("running");
  assert.equal(catalog.snapshot()[0]!.name, "Calendar");
  assert.ok(!catalog.snapshot()[0]!.aliases!.includes("changed"));
  assert.deepEqual(catalog.snapshot()[0]!.sources, ["start-apps"]);
  assert.equal(catalog.snapshot()[0]!.running, false);
});

test("merged discovery preserves running evidence and ranks the running version first", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-app-sources-"));
  try {
    const running = path.join(root, "Current.exe"),
      old = path.join(root, "Old.exe");
    await Promise.all([
      writeFile(running, "fixture"),
      writeFile(old, "fixture"),
    ]);
    let includeRunning = true;
    const catalog = new AppCatalog({
      discover: async () => [
        { name: "Old application", source: "start-apps", appId: old },
        { name: "Current application", source: "start-apps", appId: running },
        { name: "Current shortcut", source: "shortcut", path: running },
        ...(includeRunning
          ? [{ name: "Current", source: "running" as const, path: running }]
          : []),
      ],
      appDataRoots: [],
      workspaceScan: false,
    });
    const apps = await catalog.refresh();
    assert.equal(apps.length, 2);
    assert.equal(apps[0]!.path, running);
    assert.equal(apps[0]!.running, true);
    assert.deepEqual(apps[0]!.sources, ["start-apps", "shortcut", "running"]);
    assert.equal(apps[1]!.running, false);
    includeRunning = false;
    await catalog.refresh();
    assert.equal(
      catalog.snapshot().find((app) => app.path === running)!.running,
      false,
    );
    assert.deepEqual(
      catalog.snapshot().find((app) => app.path === running)!.sources,
      ["start-apps", "shortcut"],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("changed shortcuts and command-host shortcuts are not executed", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "bridge-app-shortcuts-"));
  try {
    const exe = path.join(root, "Writer.exe"),
      link = path.join(root, "Writer.lnk"),
      shell = path.join(root, "powershell.exe");
    await Promise.all([
      writeFile(exe, "fixture"),
      writeFile(link, "shortcut"),
      writeFile(shell, "fixture"),
    ]);
    let launchCount = 0;
    const catalog = new AppCatalog({
      discover: async () => [
        {
          name: "Writer",
          source: "shortcut",
          path: exe,
          shortcutPath: link,
          arguments: "--profile standard",
        },
        {
          name: "Script",
          source: "shortcut",
          path: shell,
          shortcutPath: link,
          arguments: "-Command anything",
        },
      ],
      launch: async () => {
        launchCount++;
      },
      appDataRoots: [],
      workspaceScan: false,
    });
    const apps = await catalog.refresh();
    assert.equal(apps.length, 1);
    await writeFile(link, "changed shortcut target");
    await assert.rejects(catalog.open(apps[0]!.id), /快捷方式已改变/);
    assert.equal(launchCount, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("native launch errors propagate instead of reporting success", async () => {
  const catalog = new AppCatalog({
    discover: async () => [
      {
        name: "Calendar",
        source: "start-apps",
        appId: "Vendor.Calendar_123!App",
      },
    ],
    launch: async () => {
      throw new Error("launch denied");
    },
    appDataRoots: [],
    workspaceScan: false,
  });
  const apps = await catalog.refresh();
  await assert.rejects(catalog.open(apps[0]!.id), /launch denied/);
});
