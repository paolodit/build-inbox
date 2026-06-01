import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import test from "node:test";
import path from "node:path";
import { defaultConfig, saveConfig } from "./config.js";
import { saveCaptureSession } from "./session.js";
import { CaptureSavePayload } from "./types.js";

test("saveCaptureSession writes a local build brief bundle", async () => {
  const root = path.join(process.cwd(), ".tmp-tests", `session-${Date.now()}`);
  const repoPath = path.join(root, "repo");
  process.env.BUILD_INBOX_HOME = path.join(root, "home");
  await mkdir(repoPath, { recursive: true });

  const config = defaultConfig();
  config.projects.push({
    id: "sample-project",
    name: "Sample Project",
    repoPath,
    urlMatches: ["localhost:3000"]
  });
  await saveConfig(config);

  const payload: CaptureSavePayload = {
    projectId: "sample-project",
    mode: "UX",
    createdAt: "2026-06-01T14:32:00.000Z",
    source: {
      browser: "Chrome",
      url: "http://localhost:3000/onboarding",
      title: "Onboarding - Sample"
    },
    transcriptChunks: [
      {
        timestamp: "2026-06-01T14:32:17.000Z",
        elapsedMs: 14000,
        source: "browser-speech",
        text: "This onboarding screen feels wrong."
      }
    ],
    screenshots: [
      {
        id: "001",
        type: "screenshot",
        timestamp: "2026-06-01T14:32:21.000Z",
        elapsedMs: 18231,
        url: "http://localhost:3000/onboarding",
        title: "Onboarding - Sample",
        filename: "screenshots/001.png",
        dataBase64:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
      }
    ]
  };

  const result = await saveCaptureSession(payload);
  assert.equal(result.ok, true);
  assert.match(await readFile(path.join(result.sessionPath, "brief.md"), "utf8"), /Build Inbox Brief/);
  assert.match(await readFile(path.join(result.sessionPath, "transcript.raw.txt"), "utf8"), /\[Screenshot 001 at 0:18: screenshots\/001\.png\]/);
  assert.match(await readFile(path.join(result.sessionPath, "codex-prompt.md"), "utf8"), /Task for Codex/);
  assert.match(await readFile(path.join(result.sessionPath, "issue.md"), "utf8"), /Captured with Build Inbox/);
  assert.match(await readFile(path.join(repoPath, ".gitignore"), "utf8"), /\.build-inbox\/inbox\//);

  await rm(root, { recursive: true, force: true });
});

test("saveCaptureSession rejects unsafe capture filenames", async () => {
  const root = path.join(process.cwd(), ".tmp-tests", `session-unsafe-${Date.now()}`);
  const repoPath = path.join(root, "repo");
  process.env.BUILD_INBOX_HOME = path.join(root, "home");
  await mkdir(repoPath, { recursive: true });

  const config = defaultConfig();
  config.projects.push({
    id: "sample-project",
    name: "Sample Project",
    repoPath,
    urlMatches: ["localhost:3000"]
  });
  await saveConfig(config);

  const payload: CaptureSavePayload = {
    projectId: "sample-project",
    mode: "Bug",
    createdAt: "2026-06-01T14:32:00.000Z",
    source: {
      browser: "Chrome",
      url: "http://localhost:3000/onboarding",
      title: "Onboarding - Sample"
    },
    transcriptRawText: "Trying to escape the session folder.",
    audio: {
      filename: "../outside.webm",
      dataBase64: "dGVzdA=="
    }
  };

  await assert.rejects(() => saveCaptureSession(payload), /Unsafe relative path/);

  await rm(root, { recursive: true, force: true });
});
