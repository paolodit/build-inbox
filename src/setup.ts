import { chmod, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { ensureConfig, getConfigDir } from "./config.js";
import { NATIVE_HOST_NAME } from "./types.js";
import { moduleDir } from "./utils.js";

function execFileAsync(command: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

function nativeEntryPath(): string {
  return path.join(moduleDir(import.meta.url), "native-entry.js");
}

async function writeNativeLauncher(): Promise<string> {
  const configDir = getConfigDir();
  await mkdir(configDir, { recursive: true });

  if (os.platform() === "win32") {
    const launcherPath = path.join(configDir, "build-inbox-native.cmd");
    const content = `@echo off\r\n"${process.execPath}" "${nativeEntryPath()}"\r\n`;
    await writeFile(launcherPath, content, "utf8");
    return launcherPath;
  }

  const launcherPath = path.join(configDir, "build-inbox-native");
  const content = `#!/usr/bin/env sh\nexec "${process.execPath}" "${nativeEntryPath()}"\n`;
  await writeFile(launcherPath, content, "utf8");
  await chmod(launcherPath, 0o755);
  return launcherPath;
}

async function installNativeManifest(
  launcherPath: string,
  extensionId?: string
): Promise<{ manifestPath: string; message: string }> {
  const origin = extensionId ? `chrome-extension://${extensionId}/` : "chrome-extension://__EXTENSION_ID__/";
  const manifest = {
    name: NATIVE_HOST_NAME,
    description: "Build Inbox Local Helper",
    path: launcherPath,
    type: "stdio",
    allowed_origins: [origin]
  };

  const configDir = getConfigDir();
  const manifestPath = path.join(configDir, `${NATIVE_HOST_NAME}.json`);
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  if (os.platform() === "win32") {
    await execFileAsync("reg", [
      "add",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f"
    ]);
    return {
      manifestPath,
      message: extensionId
        ? `Native Messaging manifest registered in HKCU for ${NATIVE_HOST_NAME}.`
        : `Native Messaging manifest registered in HKCU for ${NATIVE_HOST_NAME}. Replace __EXTENSION_ID__ in ${manifestPath} after loading the extension, or rerun setup with --extension-id.`
    };
  }

  const home = os.homedir();
  const targetDir =
    os.platform() === "darwin"
      ? path.join(home, "Library", "Application Support", "Google", "Chrome", "NativeMessagingHosts")
      : path.join(home, ".config", "google-chrome", "NativeMessagingHosts");
  await mkdir(targetDir, { recursive: true });
  const targetPath = path.join(targetDir, `${NATIVE_HOST_NAME}.json`);
  await writeFile(targetPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  return {
    manifestPath: targetPath,
    message: extensionId
      ? `Native Messaging manifest written to ${targetPath}.`
      : `Native Messaging manifest written to ${targetPath}. Replace __EXTENSION_ID__ after loading the extension, or rerun setup with --extension-id.`
  };
}

export async function setup(extensionId?: string): Promise<string[]> {
  await ensureConfig();
  const launcherPath = await writeNativeLauncher();
  const native = await installNativeManifest(launcherPath, extensionId);
  return [
    `Config ready at ${path.join(getConfigDir(), "config.json")}`,
    `Native launcher ready at ${launcherPath}`,
    native.message
  ];
}
