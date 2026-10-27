import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface DesktopApp {
  id: string;
  name: string;
  path?: string;
  source: string;
  sources: string[];
  running: boolean;
  aliases?: string[];
  dataRoots?: string[];
}
export interface DiscoveredApp {
  name: string;
  source: "start-apps" | "shortcut" | "running" | "workspace";
  path?: string;
  shortcutPath?: string;
  appId?: string;
  arguments?: string;
}
export interface AppLaunchTarget {
  kind: "exe" | "shortcut" | "app-id";
  value: string;
  workingDirectory?: string;
}
interface CatalogOptions {
  discover?: () => Promise<DiscoveredApp[]>;
  launch?: (target: AppLaunchTarget) => Promise<void>;
  appDataRoots?: string[];
  workspaceScan?: boolean;
}
type Workspace = { path: string; name: string };
type Entry = { app: DesktopApp; target: AppLaunchTarget; stamp?: string };

// Only this fixed script discovers applications. Message text is never PowerShell code.
const DISCOVER = String.raw`
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$result = New-Object System.Collections.Generic.List[object]
Get-StartApps | ForEach-Object {
  $result.Add(@{name=$_.Name;source='start-apps';appId=$_.AppID})
}
$shell = New-Object -ComObject WScript.Shell
foreach ($folder in @([Environment]::GetFolderPath('Programs'),[Environment]::GetFolderPath('CommonPrograms'),[Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('CommonDesktopDirectory'))) {
  if (-not $folder) { continue }
  Get-ChildItem -LiteralPath $folder -Filter '*.lnk' -Recurse -File | Select-Object -First 1500 | ForEach-Object {
    try {
      $link = $shell.CreateShortcut($_.FullName)
      $result.Add(@{name=$_.BaseName;source='shortcut';path=$link.TargetPath;shortcutPath=$_.FullName;arguments=$link.Arguments})
    } catch {}
  }
}
Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object {
  try { if ($_.Path) { $result.Add(@{name=$_.ProcessName;source='running';path=$_.Path}) } } catch {}
}
ConvertTo-Json -InputObject @($result.ToArray()) -Depth 4 -Compress
`;

const OPEN_SHORTCUT = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$start = New-Object System.Diagnostics.ProcessStartInfo
$start.FileName = $request.path
$start.UseShellExecute = $true
$start.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Normal
$start.WorkingDirectory = $request.workingDirectory
[System.Diagnostics.Process]::Start($start) | Out-Null
`;

function powershell(script: string, input = ""): Promise<string> {
  return new Promise((resolve, reject) => {
    const executable = path.join(
      process.env.SystemRoot || "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { shell: false, windowsHide: true, stdio: "pipe" },
    );
    let output = "",
      failed = false;
    const timer = setTimeout(() => {
      failed = true;
      child.kill();
      reject(new Error("读取 Windows 应用目录超时"));
    }, 20000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      output += chunk;
      if (output.length > 4_000_000) {
        failed = true;
        child.kill();
        clearTimeout(timer);
        reject(new Error("Windows 应用目录过大"));
      }
    });
    child.stderr.resume();
    child.on("error", (error) => {
      clearTimeout(timer);
      failed = true;
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (!failed)
        code === 0
          ? resolve(output.replace(/^\uFEFF/, ""))
          : reject(new Error(`Windows 应用操作失败（${code}）`));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

async function discoverWindows(): Promise<DiscoveredApp[]> {
  if (process.platform !== "win32") return [];
  const data: unknown = JSON.parse(await powershell(DISCOVER));
  return (Array.isArray(data) ? data : [data]).filter(
    (row): row is DiscoveredApp =>
      !!row &&
      typeof row === "object" &&
      typeof row.name === "string" &&
      ["start-apps", "shortcut", "running"].includes(row.source),
  );
}
function nameKey(value: string): string {
  return value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/\.exe$/i, "")
    .replace(/[\s._-]+/g, "")
    .replace(/(?:application|desktop|manager|launcher|client|app)$/, "");
}
function matching(a: string, b: string): boolean {
  const one = nameKey(a),
    two = nameKey(b);
  return one.length >= 3 && two.length >= 3 && one === two;
}
async function existsDirectory(value: string): Promise<boolean> {
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}
async function fileStamp(value: string): Promise<string | undefined> {
  try {
    const s = await stat(value);
    return s.isFile() ? `${s.size}:${s.mtimeMs}` : undefined;
  } catch {
    return undefined;
  }
}
async function directoryChildren(value: string): Promise<string[]> {
  try {
    return (await readdir(value, { withFileTypes: true }))
      .filter((item) => item.isDirectory() && !item.isSymbolicLink())
      .map((item) => path.join(value, item.name));
  } catch {
    return [];
  }
}
async function workspaceApps(
  workspaces: Workspace[],
): Promise<DiscoveredApp[]> {
  const found: DiscoveredApp[] = [];
  for (const workspace of workspaces.slice(0, 100)) {
    const selectedNames = new Set<string>();
    // Bounded build locations, not a recursive drive scan or source-code execution.
    const folders = [workspace.path];
    for (const folder of ["release", "dist", "build"]) {
      const base = path.join(workspace.path, folder);
      folders.push(base, ...(await directoryChildren(base)).slice(0, 40));
    }
    for (const folder of folders) {
      let files;
      try {
        files = await readdir(folder, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const file of files) {
        if (
          !file.isFile() ||
          !/\.exe$/i.test(file.name) ||
          /(?:setup|install|updat|crash|helper|test)/i.test(file.name)
        )
          continue;
        if (
          [workspace.name, path.basename(workspace.path)].some((name) =>
            matching(name, file.name),
          ) &&
          !selectedNames.has(nameKey(file.name))
        ) {
          // Prefer the packaged release over duplicate dist/build artifacts.
          selectedNames.add(nameKey(file.name));
          found.push({
            name: file.name.replace(/\.exe$/i, ""),
            path: path.join(folder, file.name),
            source: "workspace",
          });
        }
      }
    }
  }
  return found;
}
async function defaultLaunch(target: AppLaunchTarget): Promise<void> {
  if (target.kind === "shortcut") {
    await powershell(
      OPEN_SHORTCUT,
      JSON.stringify({
        path: target.value,
        workingDirectory: target.workingDirectory || path.dirname(target.value),
      }),
    );
    return;
  }
  const executable =
    target.kind === "app-id"
      ? path.join(process.env.SystemRoot || "C:\\Windows", "explorer.exe")
      : target.value;
  const args =
    target.kind === "app-id" ? [`shell:AppsFolder\\${target.value}`] : [];
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: target.workingDirectory,
      shell: false,
      windowsHide: false,
      detached: true,
      stdio: "ignore",
    });
    let finished = false;
    const timer = setTimeout(() => {
      finished = true;
      child.unref();
      resolve();
    }, 350);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        reject(error);
      }
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (!finished) {
        finished = true;
        code === 0
          ? resolve()
          : reject(new Error(`应用启动后退出（${code ?? "signal"}）`));
      }
    });
  });
}

export class AppCatalog {
  private entries = new Map<string, Entry>();
  private workspaces: Workspace[] = [];
  private refreshedAt = 0;
  constructor(private options: CatalogOptions = {}) {}

  snapshot(): DesktopApp[] {
    return [...this.entries.values()]
      .sort((a, b) => Number(b.app.running) - Number(a.app.running))
      .map(({ app }) => ({
        ...app,
        sources: [...app.sources],
        aliases: [...(app.aliases || [])],
        dataRoots: [...(app.dataRoots || [])],
      }));
  }

  async refresh(
    workspaces: Workspace[] = this.workspaces,
  ): Promise<DesktopApp[]> {
    const discovered = await (this.options.discover || discoverWindows)();
    if (this.options.workspaceScan !== false)
      discovered.push(...(await workspaceApps(workspaces)));
    const next = new Map<string, Entry>();
    for (const row of discovered) {
      if (!row.name || row.name.length > 240) continue;
      let target: AppLaunchTarget,
        resolved: string | undefined,
        stamp: string | undefined;
      const candidate = row.path || row.appId;
      if (
        candidate &&
        path.isAbsolute(candidate) &&
        /\.exe$/i.test(candidate)
      ) {
        if (!(await fileStamp(candidate))) continue;
        resolved = await realpath(candidate).catch(() => undefined);
        if (!resolved) continue;
        target = {
          kind: "exe",
          value: resolved,
          workingDirectory: path.dirname(resolved),
        };
        if (row.shortcutPath && row.arguments) {
          if (
            !path.isAbsolute(row.shortcutPath) ||
            !/\.lnk$/i.test(row.shortcutPath)
          )
            continue;
          stamp = await fileStamp(row.shortcutPath);
          if (!stamp) continue;
          // Do not convert shell/script launchers with embedded commands into app actions.
          if (
            /^(?:cmd|powershell|pwsh|wscript|cscript|mshta|rundll32)\.exe$/i.test(
              path.basename(resolved),
            )
          )
            continue;
          target = {
            kind: "shortcut",
            value: row.shortcutPath,
            workingDirectory: path.dirname(resolved),
          };
        }
      } else if (
        row.source === "start-apps" &&
        row.appId &&
        /^[\w.-]+![\w.-]+$/.test(row.appId)
      ) {
        target = { kind: "app-id", value: row.appId };
      } else continue;
      const key = (resolved || target.value).toLowerCase();
      const id = `app_${createHash("sha256").update(key).digest("hex").slice(0, 20)}`;
      const previous = next.get(id);
      if (previous) {
        previous.app.sources = [
          ...new Set([...previous.app.sources, row.source]),
        ];
        previous.app.running ||= row.source === "running";
        previous.app.aliases = [
          ...new Set([...(previous.app.aliases || []), row.name]),
        ];
        if (row.source === "shortcut" || row.source === "start-apps")
          previous.app.name = row.name;
        continue;
      }
      const aliases = [
        row.name,
        ...(resolved ? [path.basename(resolved, path.extname(resolved))] : []),
      ];
      const associated = workspaces.filter(
        (workspace) =>
          aliases.some(
            (alias) =>
              matching(alias, workspace.name) ||
              matching(alias, path.basename(workspace.path)),
          ) ||
          (!!resolved &&
            path.relative(workspace.path, resolved) !== "" &&
            !path.relative(workspace.path, resolved).startsWith("..") &&
            !path.isAbsolute(path.relative(workspace.path, resolved))),
      );
      aliases.push(...associated.map((workspace) => workspace.name));
      const roots = resolved ? [path.dirname(resolved)] : [];
      for (const base of [
        ...roots,
        ...associated.map((workspace) => workspace.path),
      ]) {
        roots.push(base);
        for (const folder of ["data", "user-data", "userdata"])
          if (await existsDirectory(path.join(base, folder)))
            roots.push(path.join(base, folder));
      }
      for (const base of this.options.appDataRoots ||
        [process.env.LOCALAPPDATA, process.env.APPDATA].filter(
          (value): value is string => !!value,
        )) {
        for (const child of await directoryChildren(base))
          if (aliases.some((alias) => matching(alias, path.basename(child))))
            roots.push(child);
      }
      next.set(id, {
        app: {
          id,
          name: row.name,
          path: resolved,
          source: row.source,
          sources: [row.source],
          running: row.source === "running",
          aliases: [...new Set(aliases)],
          dataRoots: [...new Set(roots)],
        },
        target,
        stamp,
      });
    }
    this.entries = next;
    this.workspaces = workspaces.map((workspace) => ({ ...workspace }));
    this.refreshedAt = Date.now();
    return this.snapshot();
  }

  async open(id: string): Promise<{
    id: string;
    name: string;
    path?: string;
    status: "launch_requested";
  }> {
    if (!this.entries.has(id))
      throw new Error("应用不在当前发现列表中，请先查询可用软件");
    if (Date.now() - this.refreshedAt > 300_000) await this.refresh();
    const entry = this.entries.get(id);
    if (!entry) throw new Error("该应用已不在当前发现列表中");
    if (entry.app.path && !(await fileStamp(entry.app.path)))
      throw new Error("应用文件已不存在，请重新发现软件");
    if (
      entry.target.kind === "shortcut" &&
      (await fileStamp(entry.target.value)) !== entry.stamp
    )
      throw new Error("应用快捷方式已改变，请重新发现软件");
    await (this.options.launch || defaultLaunch)({ ...entry.target });
    return {
      id,
      name: entry.app.name,
      path: entry.app.path,
      status: "launch_requested",
    };
  }
}
