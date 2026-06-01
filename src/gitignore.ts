import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { PrivacyMode } from "./types.js";
import { pathExists } from "./utils.js";

const START = "# Build Inbox local capture data";
const END = "# End Build Inbox local capture data";

function blockForPrivacyMode(privacyMode: PrivacyMode): string {
  if (privacyMode === "private") {
    return `${START}
.build-inbox/inbox/
.build-inbox/done/
.build-inbox/archive/
.build-inbox/config.local.json
${END}
`;
  }

  return `${START}
.build-inbox/**/audio.webm
.build-inbox/**/metadata.json
.build-inbox/**/transcript.raw.txt
.build-inbox/**/transcript.final.txt
.build-inbox/**/screenshots/
.build-inbox/config.local.json
${END}
`;
}

export async function ensureRepoGitignore(repoPath: string, privacyMode: PrivacyMode): Promise<void> {
  const gitignorePath = path.join(repoPath, ".gitignore");
  const block = blockForPrivacyMode(privacyMode);
  let existing = "";

  if (await pathExists(gitignorePath)) {
    existing = await readFile(gitignorePath, "utf8");
    if (existing.includes(START)) {
      return;
    }
  }

  const prefix = existing && !existing.endsWith("\n") ? "\n\n" : existing ? "\n" : "";
  await writeFile(gitignorePath, `${existing}${prefix}${block}`, "utf8");
}
