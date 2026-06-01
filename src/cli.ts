#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  ensureConfig,
  getLocalConfigPath,
  loadConfig,
  loadLocalConfig,
  projectIdFromName,
  saveConfig,
  saveLocalConfig
} from "./config.js";
import { createGithubIssue } from "./github.js";
import { resolveSessionPath } from "./resolve-session.js";
import { saveCaptureSession } from "./session.js";
import { setup } from "./setup.js";
import { renderBrief, renderCodexPrompt, renderIssue } from "./templates.js";
import { transcribeWithOpenAI } from "./transcribe.js";
import { CaptureSavePayload, CAPTURE_MODES, ProjectConfig, SessionMetadata } from "./types.js";
import { assertDirectory, minutesSeconds, parseArgs, requireStringFlag, splitCsv } from "./utils.js";
import { runCodex } from "./codex.js";

function printHelp(): void {
  console.log(`Build Inbox

Commands:
  build-inbox setup [--extension-id EXTENSION_ID]
  build-inbox projects:list
  build-inbox projects:add [--name NAME --repo PATH --github owner/repo --url-match a,b]
  build-inbox projects:edit <project-id>
  build-inbox capture:save --payload capture.json
  build-inbox capture:transcribe <session-id-or-path>
  build-inbox codex:run <session-id-or-path> [--dry-run]
  build-inbox github:create-issue <session-id-or-path> [--title TITLE]
  build-inbox openai:key:set [--key OPENAI_API_KEY]
  build-inbox openai:key:status
  build-inbox openai:key:clear
  build-inbox transcription:mode <browser|openai|manual>
  build-inbox cleanup:enable
  build-inbox cleanup:disable

Modes:
  ${CAPTURE_MODES.join(", ")}
`);
}

async function promptForProject(flags: Record<string, string | boolean>, existing?: ProjectConfig): Promise<ProjectConfig> {
  const rl = createInterface({ input, output });
  try {
    const ask = async (question: string, fallback = ""): Promise<string> => {
      const answer = await rl.question(fallback ? `${question} (${fallback}): ` : `${question}: `);
      return answer.trim() || fallback;
    };

    const name = requireStringFlag(flags, "name") || (await ask("Project name", existing?.name || ""));
    const repoPath = path.resolve(requireStringFlag(flags, "repo") || (await ask("Repo path", existing?.repoPath || process.cwd())));
    await assertDirectory(repoPath, "Repo path");

    const hasCoreFlags = Boolean(flags.name && flags.repo && flags["url-match"]);
    const githubRepo =
      requireStringFlag(flags, "github") ||
      (hasCoreFlags ? existing?.githubRepo || "" : await ask("GitHub repo, optional", existing?.githubRepo || ""));
    const urlMatchFlag = requireStringFlag(flags, "url-match");
    const urlMatches = urlMatchFlag
      ? splitCsv(urlMatchFlag)
      : splitCsv(await ask("URL match patterns, comma-separated", existing?.urlMatches.join(", ") || ""));

    return {
      id: existing?.id || projectIdFromName(name),
      name,
      repoPath,
      githubRepo: githubRepo || undefined,
      urlMatches
    };
  } finally {
    rl.close();
  }
}

async function projectsList(): Promise<void> {
  const config = await loadConfig();
  if (!config.projects.length) {
    console.log("No projects configured. Run build-inbox projects:add.");
    return;
  }

  for (const project of config.projects) {
    console.log(`${project.id}\t${project.name}\t${project.repoPath}`);
  }
}

async function projectsAdd(flags: Record<string, string | boolean>): Promise<void> {
  const config = await ensureConfig();
  const project = await promptForProject(flags);
  if (config.projects.some((existing) => existing.id === project.id)) {
    throw new Error(`Project already exists: ${project.id}`);
  }
  config.projects.push(project);
  config.lastSelectedProjectId = project.id;
  await saveConfig(config);
  console.log(`Added project ${project.name} (${project.id}).`);
}

async function projectsEdit(projectId: string, flags: Record<string, string | boolean>): Promise<void> {
  const config = await ensureConfig();
  const index = config.projects.findIndex((project) => project.id === projectId);
  if (index < 0) {
    throw new Error(`Project not found: ${projectId}`);
  }

  config.projects[index] = await promptForProject(flags, config.projects[index]);
  await saveConfig(config);
  console.log(`Updated project ${config.projects[index].name}.`);
}

async function captureSave(flags: Record<string, string | boolean>): Promise<void> {
  const payloadPath = requireStringFlag(flags, "payload");
  if (!payloadPath) {
    throw new Error("capture:save requires --payload capture.json");
  }

  const payload = JSON.parse(await readFile(path.resolve(payloadPath), "utf8")) as CaptureSavePayload;
  const result = await saveCaptureSession(payload);
  console.log(`Saved Build Inbox session: ${result.sessionPath}`);
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
}

async function captureTranscribe(sessionIdOrPath: string): Promise<void> {
  const config = await loadConfig();
  const sessionPath = await resolveSessionPath(sessionIdOrPath);
  const metadataPath = path.join(sessionPath, "metadata.json");
  const metadata = JSON.parse(await readFile(metadataPath, "utf8")) as SessionMetadata;

  if (!metadata.audio?.filename) {
    throw new Error("Session has no audio.webm to transcribe.");
  }

  const durationSeconds = metadata.audio.durationSeconds || 0;
  const result = await transcribeWithOpenAI({
    config,
    audioPath: path.join(sessionPath, metadata.audio.filename),
    outputPath: path.join(sessionPath, "transcript.final.txt"),
    audioDurationSeconds: durationSeconds,
    projectId: metadata.projectId,
    sessionId: metadata.sessionId
  });

  if (!result.ok) {
    console.warn(result.message);
    return;
  }

  const finalTranscript = await readFile(path.join(sessionPath, "transcript.final.txt"), "utf8");
  const updatedMetadata: SessionMetadata = {
    ...metadata,
    transcript: {
      ...metadata.transcript,
      source: "openai",
      finalFilename: "transcript.final.txt"
    }
  };
  await writeFile(metadataPath, `${JSON.stringify(updatedMetadata, null, 2)}\n`, "utf8");
  await writeFile(path.join(sessionPath, "brief.md"), renderBrief(updatedMetadata, finalTranscript), "utf8");
  await writeFile(path.join(sessionPath, "codex-prompt.md"), renderCodexPrompt(updatedMetadata, sessionPath, finalTranscript), "utf8");
  await writeFile(path.join(sessionPath, "issue.md"), renderIssue(updatedMetadata, sessionPath, finalTranscript), "utf8");

  console.log(
    `Transcribed ${minutesSeconds(durationSeconds)} using ${config.openaiTranscriptionModel}.\nEstimated cost: $${(result.estimatedCostUsd || 0).toFixed(3)}.`
  );
}

async function openAiKeySet(flags: Record<string, string | boolean>): Promise<void> {
  let key = requireStringFlag(flags, "key");
  if (!key) {
    const rl = createInterface({ input, output });
    try {
      key = (await rl.question("OpenAI API key (stored helper-only in ~/.build-inbox/config.local.json): ")).trim();
    } finally {
      rl.close();
    }
  }

  if (!key) {
    throw new Error("No API key provided.");
  }

  const localConfig = await loadLocalConfig();
  localConfig.openaiApiKey = key;
  await saveLocalConfig(localConfig);
  console.log(`OpenAI API key saved for the local helper at ${getLocalConfigPath()}.`);
  console.log("This is less secure than an OS keychain or environment variable, but it is never stored in the Chrome extension.");
}

async function openAiKeyStatus(): Promise<void> {
  const localConfig = await loadLocalConfig();
  if (process.env.OPENAI_API_KEY) {
    console.log("OpenAI API key is available from OPENAI_API_KEY.");
    return;
  }

  if (localConfig.openaiApiKey) {
    console.log(`OpenAI API key is saved in helper-local config at ${getLocalConfigPath()}.`);
    return;
  }

  console.log("No OpenAI API key configured. Browser/manual transcription still works.");
}

async function openAiKeyClear(): Promise<void> {
  const localConfig = await loadLocalConfig();
  delete localConfig.openaiApiKey;
  await saveLocalConfig(localConfig);
  console.log(`Removed helper-local OpenAI API key from ${getLocalConfigPath()}.`);
}

async function transcriptionModeSet(mode: string): Promise<void> {
  if (!["browser", "openai", "manual"].includes(mode)) {
    throw new Error("transcription:mode must be one of: browser, openai, manual");
  }

  const config = await ensureConfig();
  config.defaultTranscriptionMode = mode as "browser" | "openai" | "manual";
  await saveConfig(config);
  console.log(`Default transcription mode set to ${mode}.`);
}

async function cleanupSet(enabled: boolean): Promise<void> {
  const config = await ensureConfig();
  config.enableApiTranscriptCleanup = enabled;
  await saveConfig(config);
  console.log(`OpenAI transcript cleanup/classification ${enabled ? "enabled" : "disabled"}.`);
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const { positional, flags } = parseArgs(rest);

  switch (command) {
    case undefined:
    case "help":
    case "--help":
    case "-h":
      printHelp();
      return;

    case "setup": {
      const messages = await setup(requireStringFlag(flags, "extension-id"));
      for (const message of messages) {
        console.log(message);
      }
      return;
    }

    case "projects:list":
      await projectsList();
      return;

    case "projects:add":
      await projectsAdd(flags);
      return;

    case "projects:edit":
      if (!positional[0]) {
        throw new Error("projects:edit requires a project id.");
      }
      await projectsEdit(positional[0], flags);
      return;

    case "capture:save":
      await captureSave(flags);
      return;

    case "capture:transcribe":
      if (!positional[0]) {
        throw new Error("capture:transcribe requires a session id or path.");
      }
      await captureTranscribe(positional[0]);
      return;

    case "codex:run": {
      if (!positional[0]) {
        throw new Error("codex:run requires a session id or path.");
      }
      const sessionPath = await resolveSessionPath(positional[0]);
      const result = await runCodex({ sessionPath, dryRun: Boolean(flags["dry-run"]) });
      if (!result.ok) {
        throw new Error(result.message);
      }
      console.log(result.message);
      return;
    }

    case "github:create-issue": {
      if (!positional[0]) {
        throw new Error("github:create-issue requires a session id or path.");
      }
      const sessionPath = await resolveSessionPath(positional[0]);
      const result = await createGithubIssue(sessionPath, requireStringFlag(flags, "title"));
      if (!result.ok) {
        throw new Error(result.message);
      }
      console.log(result.message);
      return;
    }

    case "openai:key:set":
      await openAiKeySet(flags);
      return;

    case "openai:key:status":
      await openAiKeyStatus();
      return;

    case "openai:key:clear":
      await openAiKeyClear();
      return;

    case "transcription:mode":
      if (!positional[0]) {
        throw new Error("transcription:mode requires browser, openai, or manual.");
      }
      await transcriptionModeSet(positional[0]);
      return;

    case "cleanup:enable":
      await cleanupSet(true);
      return;

    case "cleanup:disable":
      await cleanupSet(false);
      return;

    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exitCode = 1;
});
