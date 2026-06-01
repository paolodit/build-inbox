import { copyFile, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig, pickProject, saveConfig } from "./config.js";
import { cleanupTranscriptWithOpenAI, renderGeneratedAnalysis } from "./cleanup.js";
import { ensureRepoGitignore } from "./gitignore.js";
import { renderBrief, renderCodexPrompt, renderIssue } from "./templates.js";
import {
  BUILD_INBOX_VERSION,
  CaptureSavePayload,
  SavedScreenshotMetadata,
  SaveSessionResult,
  SessionMetadata,
  TranscriptionMode,
  BuildInboxAnalysis
} from "./types.js";
import {
  assertDirectory,
  dataUrlToBuffer,
  ensureDir,
  formatSessionDate,
  pathExists,
  slugify
} from "./utils.js";
import { transcribeWithOpenAI } from "./transcribe.js";

function formatElapsedMarker(elapsedMs: number): string {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function screenshotMarkerText(shot: SavedScreenshotMetadata): string {
  return `[Screenshot ${shot.id} at ${formatElapsedMarker(shot.elapsedMs)}: ${shot.filename}]`;
}

function ensureScreenshotMarkers(transcript: string, screenshots: SavedScreenshotMetadata[]): string {
  if (!screenshots.length) {
    return transcript;
  }

  const trimmed = transcript.trim();
  const missingMarkers = screenshots
    .filter((shot) => !trimmed.includes(`[Screenshot ${shot.id}`))
    .map(screenshotMarkerText);

  if (!missingMarkers.length) {
    return trimmed;
  }

  const markerBlock = ["", "Screenshot markers:", ...missingMarkers].join("\n");
  return `${trimmed || "No spoken transcript captured."}\n${markerBlock}`.trim();
}

function transcriptFromPayload(payload: CaptureSavePayload): string {
  if (payload.transcriptRawText?.trim()) {
    return payload.transcriptRawText.trim();
  }

  return (payload.transcriptChunks || [])
    .slice()
    .sort((a, b) => a.elapsedMs - b.elapsedMs)
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .join("\n");
}

async function uniqueSessionPath(repoPath: string, baseSessionId: string): Promise<{ sessionId: string; sessionPath: string }> {
  const inboxPath = path.join(repoPath, ".build-inbox", "inbox");
  await ensureDir(inboxPath);

  for (let index = 0; index < 100; index += 1) {
    const sessionId = index === 0 ? baseSessionId : `${baseSessionId}-${index + 1}`;
    const sessionPath = path.join(inboxPath, sessionId);
    if (!(await pathExists(sessionPath))) {
      return { sessionId, sessionPath };
    }
  }

  throw new Error(`Could not create a unique session folder for ${baseSessionId}`);
}

async function writeFileFromCaptureData(targetPath: string, dataBase64?: string, tempPath?: string): Promise<void> {
  if (tempPath) {
    await copyFile(tempPath, targetPath);
    return;
  }

  if (!dataBase64) {
    return;
  }

  await writeFile(targetPath, dataUrlToBuffer(dataBase64));
}

export async function saveCaptureSession(payload: CaptureSavePayload): Promise<SaveSessionResult> {
  const config = await loadConfig();
  const warnings: string[] = [];
  const projectPick = pickProject(config, payload.projectId, payload.source.url);

  if (projectPick.warning) {
    warnings.push(projectPick.warning);
  }

  if (!projectPick.project) {
    throw new Error("No project selected. Add/select a project before saving the capture.");
  }

  const project = projectPick.project;
  await assertDirectory(project.repoPath, "Project repo path");
  config.lastSelectedProjectId = project.id;
  await saveConfig(config);
  await ensureRepoGitignore(project.repoPath, config.privacyMode);

  const createdAt = payload.createdAt || new Date().toISOString();
  const createdAtDate = new Date(createdAt);
  const titleSlug = slugify(payload.title || payload.source.title || payload.mode);
  const baseSessionId = `${formatSessionDate(createdAtDate)}-${titleSlug}`;
  const { sessionId, sessionPath } = await uniqueSessionPath(project.repoPath, baseSessionId);

  await ensureDir(sessionPath);
  await ensureDir(path.join(project.repoPath, ".build-inbox", "done"));
  await ensureDir(path.join(project.repoPath, ".build-inbox", "archive"));

  let rawTranscript = transcriptFromPayload(payload);
  const rawTranscriptFilename = "transcript.raw.txt";
  const finalTranscriptFilename = "transcript.final.txt";

  let finalTranscript = payload.transcriptFinalText?.trim() || "";
  let transcriptSource: TranscriptionMode | "none" = finalTranscript ? "browser" : rawTranscript ? "browser" : "none";

  if (payload.transcriptionMode === "manual") {
    finalTranscript = payload.transcriptFinalText?.trim() || rawTranscript;
    transcriptSource = "manual";
  }

  const audioInputs = payload.audioClips?.length ? payload.audioClips : payload.audio ? [payload.audio] : [];
  const savedAudioClips: Array<{ filename: string; durationSeconds?: number; path: string }> = [];

  for (const [index, audio] of audioInputs.entries()) {
    if (!audio.dataBase64 && !audio.tempPath) {
      continue;
    }

    const filename =
      audio.filename || (audioInputs.length > 1 ? `audio-${String(index + 1).padStart(3, "0")}.webm` : "audio.webm");
    const audioPath = path.join(sessionPath, filename);
    await writeFileFromCaptureData(audioPath, audio.dataBase64, audio.tempPath);
    savedAudioClips.push({
      filename,
      durationSeconds: audio.durationSeconds,
      path: audioPath
    });
  }

  const screenshotDir = path.join(sessionPath, "screenshots");
  const savedScreenshots: SavedScreenshotMetadata[] = [];

  if (payload.screenshots?.length) {
    await ensureDir(screenshotDir);
    for (const [index, shot] of payload.screenshots.entries()) {
      const id = shot.id || String(index + 1).padStart(3, "0");
      const filename = shot.filename || `screenshots/${id}.png`;
      const targetPath = path.join(sessionPath, filename);
      await ensureDir(path.dirname(targetPath));
      await writeFileFromCaptureData(targetPath, shot.dataBase64, shot.tempPath);
      savedScreenshots.push({
        id,
        filename,
        elapsedMs: shot.elapsedMs,
        url: shot.url,
        title: shot.title,
        timestamp: shot.timestamp,
        nearTranscript: shot.nearTranscript
      });
    }
  }

  rawTranscript = ensureScreenshotMarkers(rawTranscript, savedScreenshots);
  await writeFile(path.join(sessionPath, rawTranscriptFilename), rawTranscript ? `${rawTranscript}\n` : "", "utf8");

  let transcriptionResult: SaveSessionResult["transcription"] = {
    source: transcriptSource
  };

  const effectiveTranscriptionMode = payload.transcriptionMode || config.defaultTranscriptionMode;
  if (effectiveTranscriptionMode === "openai" && savedAudioClips.length) {
    const transcriptParts: string[] = [];
    let estimatedCostUsd = 0;
    let durationSeconds = 0;
    const messages: string[] = [];

    for (const [index, clip] of savedAudioClips.entries()) {
      durationSeconds += clip.durationSeconds || 0;
      const result = await transcribeWithOpenAI({
        config,
        audioPath: clip.path,
        outputPath: path.join(sessionPath, finalTranscriptFilename),
        audioDurationSeconds: clip.durationSeconds || 0,
        projectId: project.id,
        sessionId
      });
      estimatedCostUsd += result.estimatedCostUsd || 0;
      messages.push(result.message);
      if (result.ok && result.text !== undefined) {
        const label = savedAudioClips.length > 1 ? `Audio segment ${index + 1}:\n` : "";
        transcriptParts.push(`${label}${result.text.trim()}`.trim());
      }
    }

    transcriptionResult = {
      source: transcriptParts.length ? "openai" : transcriptSource,
      estimatedCostUsd,
      durationSeconds,
      model: config.openaiTranscriptionModel,
      message: messages.join(" ")
    };

    if (transcriptParts.length) {
      finalTranscript = ensureScreenshotMarkers(transcriptParts.join("\n\n").trim(), savedScreenshots);
      transcriptSource = "openai";
    } else {
      warnings.push(messages.join(" "));
    }
  }

  if (!finalTranscript && rawTranscript) {
    finalTranscript = rawTranscript;
  }

  finalTranscript = ensureScreenshotMarkers(finalTranscript, savedScreenshots);

  let generatedAnalysis: BuildInboxAnalysis | undefined;
  if (config.enableApiTranscriptCleanup && finalTranscript) {
    const cleanupResult = await cleanupTranscriptWithOpenAI({
      config,
      transcript: finalTranscript,
      screenshots: savedScreenshots,
      outputJsonPath: path.join(sessionPath, "analysis.generated.json"),
      projectId: project.id,
      sessionId
    });

    if (cleanupResult.ok && cleanupResult.analysis) {
      generatedAnalysis = cleanupResult.analysis;
      await writeFile(path.join(sessionPath, "brief.generated.md"), renderGeneratedAnalysis(cleanupResult.analysis), "utf8");
      transcriptionResult = {
        ...transcriptionResult,
        message: [transcriptionResult?.message, cleanupResult.message].filter(Boolean).join(" ")
      };
    } else {
      warnings.push(cleanupResult.message);
    }
  }

  if (finalTranscript) {
    await writeFile(path.join(sessionPath, finalTranscriptFilename), `${finalTranscript}\n`, "utf8");
  }

  const metadata: SessionMetadata = {
    version: BUILD_INBOX_VERSION,
    sessionId,
    projectId: project.id,
    projectName: project.name,
    repoPath: project.repoPath,
    mode: payload.mode,
    createdAt,
    source: {
      browser: payload.source.browser || "Chrome",
      url: payload.source.url,
      title: payload.source.title
    },
    audio: savedAudioClips[0]
      ? {
          filename: savedAudioClips[0].filename,
          durationSeconds: savedAudioClips[0].durationSeconds
        }
      : undefined,
    audioClips: savedAudioClips.length
      ? savedAudioClips.map((clip) => ({
          filename: clip.filename,
          durationSeconds: clip.durationSeconds
        }))
      : undefined,
    transcript: {
      source: transcriptSource,
      rawFilename: rawTranscriptFilename,
      finalFilename: finalTranscript ? finalTranscriptFilename : undefined
    },
    screenshots: savedScreenshots
  };

  await writeFile(path.join(sessionPath, "metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  await writeFile(path.join(sessionPath, "brief.md"), renderBrief(metadata, finalTranscript || rawTranscript, generatedAnalysis), "utf8");
  await writeFile(
    path.join(sessionPath, "codex-prompt.md"),
    renderCodexPrompt(metadata, sessionPath, finalTranscript || rawTranscript, generatedAnalysis),
    "utf8"
  );
  await writeFile(path.join(sessionPath, "issue.md"), renderIssue(metadata, sessionPath, finalTranscript || rawTranscript, generatedAnalysis), "utf8");

  return {
    ok: true,
    sessionId,
    sessionPath,
    projectId: project.id,
    warnings,
    transcription: transcriptionResult
  };
}

export async function loadSessionMetadata(sessionPath: string): Promise<SessionMetadata> {
  const raw = await readFile(path.join(sessionPath, "metadata.json"), "utf8");
  return JSON.parse(raw) as SessionMetadata;
}
