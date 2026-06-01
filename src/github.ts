import { spawn } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { loadSessionMetadata } from "./session.js";
import { loadConfig } from "./config.js";
import { pathExists } from "./utils.js";

async function commandExists(command: string): Promise<boolean> {
  const pathParts = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  const extensions = os.platform() === "win32" ? (process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";") : [""];
  for (const dir of pathParts) {
    for (const ext of extensions) {
      if (await pathExists(path.join(dir, `${command}${ext}`))) {
        return true;
      }
    }
  }
  return false;
}

export async function createGithubIssue(sessionPath: string, title?: string): Promise<{ ok: boolean; message: string }> {
  if (!(await commandExists("gh"))) {
    return { ok: false, message: "GitHub CLI not found. Install/sign in to gh, then run this command again." };
  }

  const metadata = await loadSessionMetadata(sessionPath);
  const config = await loadConfig();
  const project = config.projects.find((item) => item.id === metadata.projectId);
  const githubRepo = project?.githubRepo;

  if (!githubRepo) {
    return { ok: false, message: `Project ${metadata.projectName} has no githubRepo configured.` };
  }

  const args = [
    "issue",
    "create",
    "--repo",
    githubRepo,
    "--title",
    title || `[Build Inbox] ${metadata.source.title || metadata.mode}`,
    "--body-file",
    path.join(sessionPath, "issue.md"),
    "--label",
    "build-inbox"
  ];

  const child = spawn("gh", args, {
    cwd: metadata.repoPath,
    stdio: "inherit",
    shell: os.platform() === "win32"
  });

  const exitCode = await new Promise<number | null>((resolve) => child.on("close", resolve));
  return {
    ok: exitCode === 0,
    message: exitCode === 0 ? "GitHub issue created." : `gh exited with code ${exitCode}.`
  };
}
