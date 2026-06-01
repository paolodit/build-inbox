import { appendFile, mkdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { getConfigDir, getOpenAIApiKey, inferProjects, loadConfig, projectIdFromName, saveConfig } from "./config.js";
import { buildCodexCommand, runCodex } from "./codex.js";
import { resolveSessionPath } from "./resolve-session.js";
import { saveCaptureSession } from "./session.js";
import { CaptureSavePayload } from "./types.js";
import { assertDirectory, safeRelativePath, splitCsv } from "./utils.js";

type NativeMessage = Record<string, unknown> & { type?: string; requestId?: string };

interface PendingSave {
  payload: CaptureSavePayload;
  tempRoot: string;
}

const pendingSaves = new Map<string, PendingSave>();

function writeNativeMessage(message: unknown): void {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

async function handleMessage(message: NativeMessage): Promise<void> {
  try {
    switch (message.type) {
      case "ping": {
        writeNativeMessage({ ok: true, type: "pong", version: 1 });
        return;
      }

      case "projects:list": {
        const config = await loadConfig();
        const apiKey = await getOpenAIApiKey();
        writeNativeMessage({
          ok: true,
          projects: config.projects,
          config,
          openai: {
            hasApiKey: Boolean(apiKey),
            transcriptionMode: config.defaultTranscriptionMode,
            model: config.openaiTranscriptionModel,
            cleanupEnabled: config.enableApiTranscriptCleanup,
            cleanupModel: config.openaiCleanupModel
          }
        });
        return;
      }

      case "projects:add": {
        const config = await loadConfig();
        const name = String(message.name || "").trim();
        const repoPath = String(message.repoPath || "").trim();
        const githubRepo = String(message.githubRepo || "").trim();
        const urlMatches = Array.isArray(message.urlMatches)
          ? message.urlMatches.map((item) => String(item).trim()).filter(Boolean)
          : splitCsv(String(message.urlMatches || ""));

        if (!name) {
          throw new Error("Project name is required.");
        }
        if (!repoPath) {
          throw new Error("Repo path is required.");
        }

        await assertDirectory(repoPath, "Repo path");
        const id = projectIdFromName(name);
        if (config.projects.some((project) => project.id === id)) {
          throw new Error(`Project already exists: ${id}`);
        }

        const project = {
          id,
          name,
          repoPath,
          githubRepo: githubRepo || undefined,
          urlMatches
        };
        config.projects.push(project);
        config.lastSelectedProjectId = project.id;
        await saveConfig(config);
        writeNativeMessage({ ok: true, project, projects: config.projects });
        return;
      }

      case "project:infer": {
        const config = await loadConfig();
        const url = String(message.url || "");
        const matches = inferProjects(config, url);
        writeNativeMessage({ ok: true, matches, selectedProjectId: matches.length === 1 ? matches[0].id : config.lastSelectedProjectId });
        return;
      }

      case "config:set-transcription-mode": {
        const mode = String(message.mode || "");
        if (!["browser", "openai", "manual"].includes(mode)) {
          throw new Error("Transcription mode must be browser, openai, or manual.");
        }

        const config = await loadConfig();
        config.defaultTranscriptionMode = mode as "browser" | "openai" | "manual";
        await saveConfig(config);
        const apiKey = await getOpenAIApiKey();
        writeNativeMessage({
          ok: true,
          config,
          openai: {
            hasApiKey: Boolean(apiKey),
            transcriptionMode: config.defaultTranscriptionMode,
            model: config.openaiTranscriptionModel,
            cleanupEnabled: config.enableApiTranscriptCleanup,
            cleanupModel: config.openaiCleanupModel
          }
        });
        return;
      }

      case "config:set-cleanup": {
        const enabled = Boolean(message.enabled);
        const config = await loadConfig();
        config.enableApiTranscriptCleanup = enabled;
        await saveConfig(config);
        const apiKey = await getOpenAIApiKey();
        writeNativeMessage({
          ok: true,
          config,
          openai: {
            hasApiKey: Boolean(apiKey),
            transcriptionMode: config.defaultTranscriptionMode,
            model: config.openaiTranscriptionModel,
            cleanupEnabled: config.enableApiTranscriptCleanup,
            cleanupModel: config.openaiCleanupModel
          }
        });
        return;
      }

      case "capture:save:start": {
        const requestId = String(message.requestId || randomUUID());
        const payload = message.payload as CaptureSavePayload;
        const tempRoot = path.join(getConfigDir(), "native-tmp", requestId);
        await mkdir(tempRoot, { recursive: true });
        pendingSaves.set(requestId, { payload, tempRoot });
        writeNativeMessage({ ok: true, requestId });
        return;
      }

      case "capture:save:file-chunk": {
        const requestId = String(message.requestId || "");
        const pending = pendingSaves.get(requestId);
        if (!pending) {
          throw new Error(`No pending save for request ${requestId}`);
        }

        const relativePath = safeRelativePath(String(message.relativePath || ""));
        const targetPath = path.join(pending.tempRoot, relativePath);
        await mkdir(path.dirname(targetPath), { recursive: true });
        await appendFile(targetPath, Buffer.from(String(message.data || ""), "base64"));
        writeNativeMessage({ ok: true, requestId, relativePath });
        return;
      }

      case "capture:save:finish": {
        const requestId = String(message.requestId || "");
        const pending = pendingSaves.get(requestId);
        if (!pending) {
          throw new Error(`No pending save for request ${requestId}`);
        }

        if (pending.payload.audio) {
          pending.payload.audio.tempPath = path.join(pending.tempRoot, pending.payload.audio.filename || "audio.webm");
          delete pending.payload.audio.dataBase64;
        }

        for (const [index, audio] of (pending.payload.audioClips || []).entries()) {
          const filename = audio.filename || `audio-${String(index + 1).padStart(3, "0")}.webm`;
          audio.filename = filename;
          audio.tempPath = path.join(pending.tempRoot, filename);
          delete audio.dataBase64;
        }

        for (const shot of pending.payload.screenshots || []) {
          shot.tempPath = path.join(pending.tempRoot, shot.filename);
          delete shot.dataBase64;
        }

        const result = await saveCaptureSession(pending.payload);
        pendingSaves.delete(requestId);
        await rm(pending.tempRoot, { recursive: true, force: true });
        writeNativeMessage({ ok: true, requestId, result });
        return;
      }

      case "codex:run": {
        const sessionPath = await resolveSessionPath(String(message.sessionId || message.sessionPath || ""));
        const result = await runCodex({ sessionPath, detached: true });
        writeNativeMessage({ ...result, sessionPath });
        return;
      }

      case "codex:command": {
        const sessionPath = await resolveSessionPath(String(message.sessionId || message.sessionPath || ""));
        const command = await buildCodexCommand({ sessionPath });
        writeNativeMessage({ ok: true, command });
        return;
      }

      default:
        throw new Error(`Unknown native message type: ${message.type || "(missing)"}`);
    }
  } catch (error) {
    writeNativeMessage({ ok: false, error: (error as Error).message, type: message.type });
  }
}

export function runNativeHost(): void {
  let buffer = Buffer.alloc(0);

  process.stdin.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);

    while (buffer.length >= 4) {
      const messageLength = buffer.readUInt32LE(0);
      if (buffer.length < 4 + messageLength) {
        return;
      }

      const body = buffer.subarray(4, 4 + messageLength);
      buffer = buffer.subarray(4 + messageLength);

      let parsed: NativeMessage;
      try {
        parsed = JSON.parse(body.toString("utf8")) as NativeMessage;
      } catch (error) {
        writeNativeMessage({ ok: false, error: `Invalid JSON: ${(error as Error).message}` });
        continue;
      }

      void handleMessage(parsed);
    }
  });
}
