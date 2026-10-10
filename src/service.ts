/*
LaunchAgent management for installs that don't go through Homebrew (Homebrew
users get `brew services start mixtape` instead).
*/

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { findMediaControl } from "./media.ts";
import { logPath } from "./paths.ts";

export const SERVICE_LABEL = "io.github.ayushsaini00.mixtape";
export const BREW_SERVICE_LABEL = "homebrew.mxcl.mixtape";

export function plistPath(): string {
  return join(homedir(), "Library", "LaunchAgents", `${SERVICE_LABEL}.plist`);
}

function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function launchctl(args: string[]): { ok: boolean; output: string } {
  try {
    const output = execFileSync("/bin/launchctl", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

function domain(): string {
  return `gui/${process.getuid?.() ?? 0}`;
}

export function isLoaded(label: string): boolean {
  return launchctl(["print", `${domain()}/${label}`]).ok;
}

// bootout returns before the job is fully gone, and bootstrapping the same
// label in the meantime fails with "5: Input/output error".
async function unload(label: string) {
  if (!isLoaded(label)) return;
  launchctl(["bootout", `${domain()}/${label}`]);
  for (let i = 0; i < 50 && isLoaded(label); i++) await sleep(100);
}

export async function installService(): Promise<string> {
  // The script node is running right now (npm's bin symlink resolved).
  const entry = realpathSync(process.argv[1] ?? "");
  const mediaControl = findMediaControl();
  const pathDirs = [
    ...(mediaControl ? [dirname(mediaControl)] : []),
    dirname(process.execPath),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  const path = [...new Set(pathDirs)].join(":");

  const args = [process.execPath, entry, "daemon"]
    .map((arg) => `    <string>${escapeXml(arg)}</string>`)
    .join("\n");

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${SERVICE_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(path)}</string>
    <key>MIXTAPE_LOG_FILE</key>
    <string>${escapeXml(logPath())}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ProcessType</key>
  <string>Background</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(logPath())}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(logPath())}</string>
</dict>
</plist>
`;

  const file = plistPath();
  mkdirSync(dirname(file), { recursive: true });
  mkdirSync(dirname(logPath()), { recursive: true });
  await unload(SERVICE_LABEL);
  writeFileSync(file, plist);

  let result = launchctl(["bootstrap", domain(), file]);
  for (let attempt = 1; !result.ok && attempt < 5; attempt++) {
    await sleep(500);
    result = launchctl(["bootstrap", domain(), file]);
  }
  if (!result.ok) throw new Error(`launchctl bootstrap failed: ${result.output.trim()}`);
  return file;
}

export async function uninstallService(): Promise<boolean> {
  const file = plistPath();
  const loaded = isLoaded(SERVICE_LABEL);
  await unload(SERVICE_LABEL);
  const existed = existsSync(file);
  rmSync(file, { force: true });
  return loaded || existed;
}
