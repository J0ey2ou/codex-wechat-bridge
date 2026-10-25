import { spawnSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  renameSync,
  unlinkSync,
  mkdirSync,
} from "node:fs";
import path from "node:path";
export interface SecretVault {
  get<T>(name: string): T | undefined;
  set(name: string, value: unknown): void;
  delete(name: string): void;
}
export class MemoryVault implements SecretVault {
  private values = new Map<string, unknown>();
  get<T>(n: string) {
    return this.values.get(n) as T | undefined;
  }
  set(n: string, v: unknown) {
    this.values.set(n, structuredClone(v));
  }
  delete(n: string) {
    this.values.delete(n);
  }
}
export class DpapiVault implements SecretVault {
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true });
  }
  private file(name: string) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error("Invalid secret name");
    return path.join(this.directory, name + ".dpapi");
  }
  private transform(data: string, encrypt: boolean): string {
    if (process.platform !== "win32")
      throw new Error("真实微信凭证存储需要 Windows DPAPI");
    const action = encrypt ? "Protect" : "Unprotect";
    const script = `Add-Type -AssemblyName System.Security; $bytes = [Convert]::FromBase64String([Console]::In.ReadToEnd()); $result = [Security.Cryptography.ProtectedData]::${action}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser); [Console]::Out.Write([Convert]::ToBase64String($result))`;
    const r = spawnSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      { input: data, encoding: "utf8", windowsHide: true, timeout: 15000 },
    );
    if (r.status !== 0)
      throw new Error("DPAPI 凭证操作失败；请使用原 Windows 用户");
    return r.stdout.trim();
  }
  get<T>(name: string): T | undefined {
    const f = this.file(name);
    if (!existsSync(f)) return undefined;
    return JSON.parse(
      Buffer.from(
        this.transform(readFileSync(f, "utf8"), false),
        "base64",
      ).toString("utf8"),
    ) as T;
  }
  set(name: string, value: unknown) {
    const f = this.file(name);
    const data = this.transform(
      Buffer.from(JSON.stringify(value)).toString("base64"),
      true,
    );
    writeFileSync(f + ".tmp", data, { mode: 0o600 });
    renameSync(f + ".tmp", f);
  }
  delete(name: string) {
    const f = this.file(name);
    if (existsSync(f)) unlinkSync(f);
  }
}
