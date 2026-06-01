import path from "node:path";
import { loadConfig } from "./config.js";
import { pathExists } from "./utils.js";

export async function resolveSessionPath(sessionIdOrPath: string): Promise<string> {
  if (path.isAbsolute(sessionIdOrPath) && (await pathExists(sessionIdOrPath))) {
    return sessionIdOrPath;
  }

  const config = await loadConfig();
  for (const project of config.projects) {
    const candidate = path.join(project.repoPath, ".build-inbox", "inbox", sessionIdOrPath);
    if (await pathExists(candidate)) {
      return candidate;
    }

    const doneCandidate = path.join(project.repoPath, ".build-inbox", "done", sessionIdOrPath);
    if (await pathExists(doneCandidate)) {
      return doneCandidate;
    }

    const archiveCandidate = path.join(project.repoPath, ".build-inbox", "archive", sessionIdOrPath);
    if (await pathExists(archiveCandidate)) {
      return archiveCandidate;
    }
  }

  throw new Error(`Session not found: ${sessionIdOrPath}`);
}
