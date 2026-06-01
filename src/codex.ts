import { execFile, spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { loadSessionMetadata } from "./session.js";
import { pathExists } from "./utils.js";

const execFileAsync = promisify(execFile);

async function findInPath(command: string): Promise<string | undefined> {
  const pathParts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = os.platform() === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];

  for (const dir of pathParts) {
    for (const ext of extensions) {
      const candidate = path.join(dir, `${command}${ext}`);
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  }

  return undefined;
}

async function findWithWhere(command: string): Promise<string | undefined> {
  if (os.platform() !== "win32") {
    return undefined;
  }

  try {
    const { stdout } = await execFileAsync("where.exe", [command], { windowsHide: true });
    const first = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)[0];
    return first && (await pathExists(first)) ? first : undefined;
  } catch {
    return undefined;
  }
}

async function findWindowsCodexApp(): Promise<string | undefined> {
  if (os.platform() !== "win32") {
    return undefined;
  }

  const candidates = [
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "codex.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WindowsApps", "codex.cmd")
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  const windowsApps = path.join(process.env.ProgramFiles || "C:\\Program Files", "WindowsApps");
  try {
    const entries = await readdir(windowsApps, { withFileTypes: true });
    const codexPackages = entries
      .filter((entry) => entry.isDirectory() && entry.name.startsWith("OpenAI.Codex_"))
      .map((entry) => entry.name)
      .sort()
      .reverse();

    for (const packageName of codexPackages) {
      const candidate = path.join(windowsApps, packageName, "app", "resources", "codex.exe");
      if (await pathExists(candidate)) {
        return candidate;
      }
    }
  } catch {
    // WindowsApps is often protected; PATH/where fallbacks usually cover this.
  }

  return undefined;
}

async function resolveCommand(command: string): Promise<string | undefined> {
  return (await findInPath(command)) || (await findWithWhere(command)) || (command === "codex" ? await findWindowsCodexApp() : undefined);
}

export interface CodexRunOptions {
  sessionPath: string;
  detached?: boolean;
  dryRun?: boolean;
}

export async function buildCodexCommand(options: CodexRunOptions): Promise<{
  command: string;
  args: string[];
  cwd: string;
}> {
  const metadata = await loadSessionMetadata(options.sessionPath);
  const promptPath = path.join(options.sessionPath, "codex-prompt.md");
  const prompt = await readFile(promptPath, "utf8");
  const screenshotsDir = path.join(options.sessionPath, "screenshots");
  const screenshotPaths = (await pathExists(screenshotsDir))
    ? (await readdir(screenshotsDir))
        .filter((file) => file.toLowerCase().endsWith(".png"))
        .sort()
        .map((file) => path.relative(metadata.repoPath, path.join(screenshotsDir, file)))
    : [];

  const args = screenshotPaths.length ? ["--image", screenshotPaths.join(","), prompt] : [prompt];
  const command = (await resolveCommand("codex")) || "codex";

  return {
    command,
    args,
    cwd: metadata.repoPath
  };
}

export async function runCodex(options: CodexRunOptions): Promise<{ ok: boolean; message: string }> {
  const commandPath = await resolveCommand("codex");
  if (!commandPath) {
    const chatPath = path.resolve(options.sessionPath);
    return {
      ok: false,
      message: [
        "Codex CLI not found on the helper PATH.",
        "",
        "What you can do next:",
        "1. Open Help (?) > Codex CLI for setup notes.",
        "2. Install/sign in to the local Codex CLI, then restart Chrome.",
        "3. Or run this from a terminal:",
        `   build-inbox codex:run "${chatPath}"`,
        "4. Or use Codex Chat/App and ask:",
        "   Please process this Build Inbox capture folder and follow codex-prompt.md:",
        `   ${chatPath}`,
        "",
        "Note: your Codex chat/app login is separate from the local `codex` command."
      ].join("\n")
    };
  }

  const built = await buildCodexCommand(options);
  if (options.dryRun) {
    return {
      ok: true,
      message: `${built.command} ${built.args.map((arg) => JSON.stringify(arg)).join(" ")}`
    };
  }

  const child = spawn(built.command, built.args, {
    cwd: built.cwd,
    stdio: options.detached ? "ignore" : "inherit",
    detached: options.detached || false,
    shell: os.platform() === "win32" && !path.isAbsolute(built.command)
  });

  if (options.detached) {
    child.unref();
    return { ok: true, message: "Codex launched." };
  }

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("close", resolve);
  });

  return {
    ok: exitCode === 0,
    message: exitCode === 0 ? "Codex finished." : `Codex exited with code ${exitCode}.`
  };
}
