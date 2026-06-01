const HOST_NAME = "com.build_inbox.helper";
const CHUNK_SIZE = 512 * 1024;

let capture = null;
let savedSession = null;
let helperConnected = false;
let helperCheckedAt = 0;
let pendingStartOptions = null;
let helperOpenAI = {
  hasApiKey: false,
  transcriptionMode: "browser",
  model: "gpt-4o-mini-transcribe",
  cleanupEnabled: false,
  cleanupModel: "gpt-4o-mini"
};

const MODE_OPTIONS = ["Bug", "UX", "Feature", "Note", "Question", "Decision", "Refactor"];

if (chrome.sidePanel?.setPanelBehavior) {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
}

function nowIso() {
  return new Date().toISOString();
}

function activeElapsedMs() {
  if (!capture?.startedAt) {
    return 0;
  }

  if (capture.stoppedAt) {
    return capture.pausedElapsedMs || capture.stoppedAt - capture.startedAt;
  }

  return (capture.pausedElapsedMs || 0) + (Date.now() - (capture.segmentStartedAt || capture.startedAt));
}

function formatElapsedMarker(elapsedMs) {
  const seconds = Math.max(0, Math.round(elapsedMs / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

function currentTranscriptText() {
  const finalText = capture?.transcriptFinalText?.trim();
  if (finalText) {
    return finalText;
  }

  return (capture?.transcriptChunks || [])
    .map((chunk) => chunk.text.trim())
    .filter(Boolean)
    .join("\n");
}

function removeMarkerFromText(text, screenshotId) {
  const escaped = screenshotId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text
    .replace(new RegExp(`\\n?\\[Screenshot ${escaped}[^\\n]*\\]`, "g"), "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function transcriptPreviewText() {
  const text = currentTranscriptText();
  const interim = capture?.interimTranscript?.trim();
  if (text && interim) {
    return `${text}\n${interim}`;
  }
  return text || interim || "";
}

function inferCaptureMode(captureLike) {
  const haystack = [
    captureLike?.source?.url,
    captureLike?.source?.title,
    currentTranscriptText(),
    captureLike?.interimTranscript
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  if (/\b(error|bug|broken|crash|fail|failure|exception|wrong|regression)\b/.test(haystack)) {
    return "Bug";
  }
  if (/\b(refactor|cleanup|simplify|technical debt|rename|restructure)\b/.test(haystack)) {
    return "Refactor";
  }
  if (/\b(decide|decision|tradeoff|option|choose|chosen)\b/.test(haystack)) {
    return "Decision";
  }
  if (/\b(question|wonder|how should|what if|can we|should we)\b/.test(haystack)) {
    return "Question";
  }
  if (/\b(feature|add|new flow|support|implement|build)\b/.test(haystack)) {
    return "Feature";
  }
  if (/\b(ux|ui|screen|layout|button|copy|confusing|awkward|onboarding|visual|spacing)\b/.test(haystack)) {
    return "UX";
  }
  return "Note";
}

function selectedCaptureMode() {
  if (!capture) {
    return "Note";
  }

  if (capture.modeSetting && MODE_OPTIONS.includes(capture.modeSetting)) {
    return capture.modeSetting;
  }

  return inferCaptureMode(capture);
}

async function inferProject(url) {
  if (!(await pingHelper())) {
    return null;
  }

  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, { type: "project:infer", url }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve(null);
      } else {
        resolve(response.selectedProjectId || null);
      }
    });
  });
}

async function createCaptureState(options = {}, startedAt = Date.now(), recorder = {}) {
  const tab = options.sourceTab || (await getActiveTab());
  const selectedProjectId = options.projectId || (tab?.url ? await inferProject(tab.url) : undefined);

  capture = {
    mode: options.mode === "Auto" || !options.mode ? "Note" : options.mode,
    modeSetting: options.mode || "Auto",
    projectId: selectedProjectId,
    createdAt: nowIso(),
    startedAt,
    segmentStartedAt: startedAt,
    pausedElapsedMs: 0,
    stoppedAt: null,
    recorderTarget: recorder.target,
    recorderTabId: recorder.tabId,
    source: {
      browser: "Chrome",
      url: tab?.url || "",
      title: tab?.title || ""
    },
    transcriptChunks: [],
    interimTranscript: "",
    transcriptFinalText: "",
    screenshots: [],
    audioSegments: [],
    audio: null,
    warnings: []
  };
  capture.mode = selectedCaptureMode();
  savedSession = null;
  return capture;
}

async function startCapture(options = {}) {
  const tab = await getActiveTab();
  await openMicrophonePermissionPage({ ...options, sourceTab: tab });
  return capture;
}

async function stopCapture() {
  if (!capture) {
    throw new Error("No active capture.");
  }

  if (capture.recorderTarget !== "permission-tab" || !capture.recorderTabId) {
    throw new Error("No active microphone recorder tab.");
  }

  const response = await chrome.tabs.sendMessage(capture.recorderTabId, {
    target: "permission-recorder",
    type: "stop-recording"
  });

  if (!response?.ok) {
    throw new Error(response?.error || "Could not stop recording.");
  }

  capture.stoppedAt = Date.now();
  capture.pausedElapsedMs = (capture.pausedElapsedMs || 0) + (capture.stoppedAt - (capture.segmentStartedAt || capture.startedAt));
  const audioSegment = response.audioDataUrl
    ? {
        filename: `audio-${String((capture.audioSegments?.length || 0) + 1).padStart(3, "0")}.webm`,
        mimeType: response.mimeType || "audio/webm",
        durationSeconds: response.durationSeconds,
        dataBase64: response.audioDataUrl
      }
    : null;
  if (audioSegment) {
    capture.audioSegments ||= [];
    capture.audioSegments.push(audioSegment);
    capture.audio = audioSegment;
  }

  for (const chunk of response.transcriptChunks || []) {
    if (!capture.transcriptChunks.some((existing) => existing.elapsedMs === chunk.elapsedMs && existing.text === chunk.text)) {
      capture.transcriptChunks.push(chunk);
    }
  }

  chrome.tabs.remove(capture.recorderTabId).catch(() => undefined);

  return capture;
}

async function continueCapture(options = {}) {
  if (!capture) {
    return startCapture(options);
  }

  const tab = await getActiveTab();
  await openMicrophonePermissionPage({ ...options, continueSession: true, sourceTab: tab });
  return capture;
}

function discardCapture() {
  capture = null;
  savedSession = null;
}

function nextScreenshotId() {
  const maxId = (capture?.screenshots || []).reduce((max, shot) => {
    const parsed = Number.parseInt(shot.id, 10);
    return Number.isFinite(parsed) ? Math.max(max, parsed) : max;
  }, 0);
  return String(maxId + 1).padStart(3, "0");
}

async function takeScreenshot() {
  if (!capture) {
    const tab = await getActiveTab();
    capture = {
      mode: "Note",
      modeSetting: "Auto",
      projectId: tab?.url ? await inferProject(tab.url) : undefined,
      createdAt: nowIso(),
      startedAt: Date.now(),
      segmentStartedAt: Date.now(),
      pausedElapsedMs: 0,
      stoppedAt: null,
      source: {
        browser: "Chrome",
        url: tab?.url || "",
        title: tab?.title || ""
      },
      transcriptChunks: [],
      interimTranscript: "",
      transcriptFinalText: "",
      screenshots: [],
      audioSegments: [],
      audio: null,
      warnings: []
    };
  }

  const tab = await getActiveTab();
  let dataUrl;
  try {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: "png" });
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes("activeTab") || message.includes("<all_urls>")) {
      throw new Error("Chrome needs screenshot site access. Press Shot in the side panel again and grant the permission prompt.");
    }
    throw error;
  }
  const id = nextScreenshotId();
  const text = currentTranscriptText();
  const nearTranscript = text ? text.slice(-240) : "";
  const shot = {
    id,
    type: "screenshot",
    timestamp: nowIso(),
    elapsedMs: activeElapsedMs(),
    url: tab?.url || capture.source.url,
    title: tab?.title || capture.source.title,
    filename: `screenshots/${id}.png`,
    nearTranscript,
    dataBase64: dataUrl
  };
  capture.screenshots.push(shot);

  const marker = {
    timestamp: shot.timestamp,
    elapsedMs: shot.elapsedMs,
    source: "screenshot",
    text: `[Screenshot ${id} at ${formatElapsedMarker(shot.elapsedMs)}: ${shot.filename}]`
  };

  if (capture.transcriptFinalText?.trim()) {
    capture.transcriptFinalText = `${capture.transcriptFinalText.trim()}\n${marker.text}`;
  } else {
    capture.transcriptChunks.push(marker);
  }

  return { shot, marker };
}

function removeScreenshot(id) {
  if (!capture) {
    throw new Error("No active capture.");
  }

  const shot = capture.screenshots.find((item) => item.id === id);
  capture.screenshots = capture.screenshots.filter((item) => item.id !== id);
  capture.transcriptChunks = (capture.transcriptChunks || []).filter(
    (chunk) => !(chunk.source === "screenshot" && chunk.text.includes(`[Screenshot ${id}`))
  );
  capture.transcriptFinalText = removeMarkerFromText(capture.transcriptFinalText || "", id);
  return { id, filename: shot?.filename };
}

async function pingHelper(force = false) {
  if (!force && Date.now() - helperCheckedAt < 3000) {
    return helperConnected;
  }

  helperCheckedAt = Date.now();
  helperConnected = await new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, { type: "ping" }, (response) => {
      resolve(!chrome.runtime.lastError && Boolean(response?.ok));
    });
  });
  return helperConnected;
}

async function getProjects() {
  if (!(await pingHelper(true))) {
    return { ok: false, projects: [], message: "Local Helper not connected. You can still export this capture as a zip." };
  }

  return new Promise((resolve) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, { type: "projects:list" }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        resolve({ ok: false, projects: [], message: "Local Helper not connected. You can still export this capture as a zip." });
      } else {
        helperOpenAI = response.openai || helperOpenAI;
        resolve({ ok: true, projects: response.projects || [], config: response.config, openai: helperOpenAI });
      }
    });
  });
}

function postAndWait(port, message) {
  return new Promise((resolve, reject) => {
    const onMessage = (response) => {
      port.onMessage.removeListener(onMessage);
      if (response?.ok) {
        resolve(response);
      } else {
        reject(new Error(response?.error || response?.message || "Native helper failed."));
      }
    };

    const onDisconnect = () => {
      port.onMessage.removeListener(onMessage);
      reject(new Error(chrome.runtime.lastError?.message || "Native helper disconnected."));
    };

    port.onMessage.addListener(onMessage);
    port.onDisconnect.addListener(onDisconnect);
    port.postMessage(message);
  });
}

function dataUrlBase64(dataUrl) {
  const index = dataUrl.indexOf(",");
  return index >= 0 ? dataUrl.slice(index + 1) : dataUrl;
}

async function sendFileChunks(port, requestId, relativePath, dataUrl) {
  const base64 = dataUrlBase64(dataUrl);
  for (let index = 0; index < base64.length; index += CHUNK_SIZE) {
    const chunk = base64.slice(index, index + CHUNK_SIZE);
    await postAndWait(port, {
      type: "capture:save:file-chunk",
      requestId,
      relativePath,
      data: chunk
    });
  }
}

function capturePayload() {
  if (!capture) {
    throw new Error("Nothing to save yet.");
  }

  capture.mode = selectedCaptureMode();
  return {
    projectId: capture.projectId,
    mode: capture.mode,
    createdAt: capture.createdAt,
    source: capture.source,
    transcriptionMode:
      helperOpenAI?.hasApiKey && helperOpenAI?.transcriptionMode === "openai"
        ? "openai"
        : helperOpenAI?.transcriptionMode || "browser",
    transcriptChunks: capture.transcriptChunks,
    transcriptRawText: currentTranscriptText(),
    transcriptFinalText: capture.transcriptFinalText || currentTranscriptText(),
    audio: capture.audio
      ? {
          filename: capture.audio.filename,
          mimeType: capture.audio.mimeType,
          durationSeconds: capture.audio.durationSeconds
        }
      : undefined,
    audioClips: (capture.audioSegments || []).map((audio) => ({
      filename: audio.filename,
      mimeType: audio.mimeType,
      durationSeconds: audio.durationSeconds
    })),
    screenshots: capture.screenshots.map((shot) => ({
      id: shot.id,
      type: "screenshot",
      timestamp: shot.timestamp,
      elapsedMs: shot.elapsedMs,
      url: shot.url,
      title: shot.title,
      filename: shot.filename,
      nearTranscript: shot.nearTranscript
    }))
  };
}

async function addProject(message) {
  if (!(await pingHelper(true))) {
    throw new Error("Local Helper not connected.");
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      HOST_NAME,
      {
        type: "projects:add",
        name: message.name,
        repoPath: message.repoPath,
        githubRepo: message.githubRepo,
        urlMatches: message.urlMatches
      },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          reject(new Error(chrome.runtime.lastError?.message || response?.error || "Could not add project."));
        } else {
          resolve(response);
        }
      }
    );
  });
}

async function setTranscriptionMode(mode) {
  if (!(await pingHelper(true))) {
    throw new Error("Local Helper not connected.");
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, { type: "config:set-transcription-mode", mode }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        reject(new Error(chrome.runtime.lastError?.message || response?.error || "Could not update transcription mode."));
      } else {
        helperOpenAI = response.openai || helperOpenAI;
        resolve(response);
      }
    });
  });
}

async function setCleanupEnabled(enabled) {
  if (!(await pingHelper(true))) {
    throw new Error("Local Helper not connected.");
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(HOST_NAME, { type: "config:set-cleanup", enabled }, (response) => {
      if (chrome.runtime.lastError || !response?.ok) {
        reject(new Error(chrome.runtime.lastError?.message || response?.error || "Could not update cleanup setting."));
      } else {
        helperOpenAI = response.openai || helperOpenAI;
        resolve(response);
      }
    });
  });
}

async function saveViaNative() {
  if (!(await pingHelper(true))) {
    throw new Error("Local Helper not connected. You can still export this capture as a zip.");
  }

  const requestId = crypto.randomUUID();
  const port = chrome.runtime.connectNative(HOST_NAME);
  const payload = capturePayload();
  await postAndWait(port, { type: "capture:save:start", requestId, payload });

  for (const audio of capture.audioSegments || []) {
    if (audio.dataBase64) {
      await sendFileChunks(port, requestId, audio.filename, audio.dataBase64);
    }
  }

  for (const shot of capture.screenshots) {
    await sendFileChunks(port, requestId, shot.filename, shot.dataBase64);
  }

  const response = await postAndWait(port, { type: "capture:save:finish", requestId });
  port.disconnect();
  savedSession = response.result;
  return savedSession;
}

function utf8Bytes(text) {
  return new TextEncoder().encode(text);
}

function dataUrlBytes(dataUrl) {
  const base64 = dataUrlBase64(dataUrl);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

let crcTable = null;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) {
        c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      }
      crcTable[n] = c >>> 0;
    }
  }

  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = crcTable[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function writeUint16(view, offset, value) {
  view.setUint16(offset, value, true);
}

function writeUint32(view, offset, value) {
  view.setUint32(offset, value, true);
}

function concatBytes(parts) {
  const length = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function zipBytes(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = utf8Bytes(file.name);
    const data = file.bytes;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const localView = new DataView(local.buffer);
    writeUint32(localView, 0, 0x04034b50);
    writeUint16(localView, 4, 20);
    writeUint16(localView, 6, 0);
    writeUint16(localView, 8, 0);
    writeUint16(localView, 10, 0);
    writeUint16(localView, 12, 0);
    writeUint32(localView, 14, crc);
    writeUint32(localView, 18, data.length);
    writeUint32(localView, 22, data.length);
    writeUint16(localView, 26, nameBytes.length);
    writeUint16(localView, 28, 0);
    local.set(nameBytes, 30);

    localParts.push(local, data);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    writeUint32(centralView, 0, 0x02014b50);
    writeUint16(centralView, 4, 20);
    writeUint16(centralView, 6, 20);
    writeUint16(centralView, 8, 0);
    writeUint16(centralView, 10, 0);
    writeUint16(centralView, 12, 0);
    writeUint16(centralView, 14, 0);
    writeUint32(centralView, 16, crc);
    writeUint32(centralView, 20, data.length);
    writeUint32(centralView, 24, data.length);
    writeUint16(centralView, 28, nameBytes.length);
    writeUint16(centralView, 30, 0);
    writeUint16(centralView, 32, 0);
    writeUint16(centralView, 34, 0);
    writeUint16(centralView, 36, 0);
    writeUint32(centralView, 38, 0);
    writeUint32(centralView, 42, offset);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length + data.length;
  }

  const centralStart = offset;
  const centralBytes = concatBytes(centralParts);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  writeUint32(endView, 0, 0x06054b50);
  writeUint16(endView, 8, files.length);
  writeUint16(endView, 10, files.length);
  writeUint32(endView, 12, centralBytes.length);
  writeUint32(endView, 16, centralStart);
  writeUint16(endView, 20, 0);

  return concatBytes([...localParts, centralBytes, end]);
}

function bytesToBase64(bytes) {
  let binary = "";
  const step = 0x8000;
  for (let index = 0; index < bytes.length; index += step) {
    binary += String.fromCharCode(...bytes.subarray(index, index + step));
  }
  return btoa(binary);
}

async function exportZip() {
  if (!capture) {
    throw new Error("Nothing to export yet.");
  }

  const payload = {
    ...capturePayload(),
    screenshots: capture.screenshots.map(({ dataBase64, ...shot }) => shot)
  };
  const transcript = currentTranscriptText();
  const files = [
    { name: "capture.json", bytes: utf8Bytes(`${JSON.stringify(payload, null, 2)}\n`) },
    { name: "transcript.raw.txt", bytes: utf8Bytes(transcript ? `${transcript}\n` : "") },
    { name: "transcript.final.txt", bytes: utf8Bytes(transcript ? `${transcript}\n` : "") },
    {
      name: "brief.md",
      bytes: utf8Bytes(`# Build Inbox Brief\n\nProject: ${capture.projectId || "Unselected"}\nMode: ${capture.mode}\nCaptured: ${capture.createdAt}\nSource URL: ${capture.source.url}\nPage Title: ${capture.source.title}\n\n## Summary\n\nNot generated. Review transcript and screenshots.\n\n## Transcript\n\n${transcript || "No transcript captured."}\n`)
    }
  ];

  if (capture.audio?.dataBase64) {
    for (const audio of capture.audioSegments || [capture.audio]) {
      files.push({ name: audio.filename || "audio.webm", bytes: dataUrlBytes(audio.dataBase64) });
    }
  }

  for (const shot of capture.screenshots) {
    files.push({ name: shot.filename, bytes: dataUrlBytes(shot.dataBase64) });
  }

  const zip = zipBytes(files);
  const url = `data:application/zip;base64,${bytesToBase64(zip)}`;
  const date = new Date(capture.createdAt).toISOString().slice(0, 16).replace(/[T:]/g, "-");
  await chrome.downloads.download({
    url,
    filename: `build-inbox-${date}.zip`,
    saveAs: true
  });
}

async function sendToCodex() {
  if (!savedSession?.sessionId) {
    await saveViaNative();
  }

  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(
      HOST_NAME,
      { type: "codex:run", sessionId: savedSession.sessionId },
      (response) => {
        if (chrome.runtime.lastError || !response?.ok) {
          reject(new Error(chrome.runtime.lastError?.message || response?.error || response?.message || "Could not launch Codex."));
        } else {
          resolve(response);
        }
      }
    );
  });
}

function publicState() {
  return {
    capture,
    savedSession,
    helperConnected,
    elapsedMs: activeElapsedMs(),
    transcriptText: currentTranscriptText(),
    transcriptPreview: transcriptPreviewText(),
    audioLevel: capture?.audioLevel || 0,
    inferredMode: capture ? selectedCaptureMode() : "Note",
    openai: helperOpenAI
  };
}

async function openMicrophonePermissionPage(options = {}) {
  const tab = await getActiveTab();
  pendingStartOptions = {
    ...options,
    sourceTab: tab
      ? {
          id: tab.id,
          windowId: tab.windowId,
          url: tab.url || "",
          title: tab.title || ""
        }
      : undefined
  };
  await chrome.tabs.create({
    url: chrome.runtime.getURL("permission.html")
  });
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target && message.target !== "background") {
    return false;
  }

  (async () => {
    switch (message.type) {
      case "transcript:chunk":
        if (capture) {
          capture.transcriptChunks.push(message.chunk);
        }
        sendResponse({ ok: true });
        return;

      case "transcript:interim":
        if (capture) {
          capture.interimTranscript = message.text;
        }
        sendResponse({ ok: true });
        return;

      case "audio:level":
        if (capture) {
          capture.audioLevel = Number(message.level) || 0;
        }
        sendResponse({ ok: true });
        return;

      case "permission-recorder-started": {
        let startedCapture;
        if (pendingStartOptions?.continueSession && capture) {
          capture.stoppedAt = null;
          capture.segmentStartedAt = Number(message.startedAt) || Date.now();
          capture.recorderTarget = "permission-tab";
          capture.recorderTabId = _sender.tab?.id;
          savedSession = null;
          startedCapture = capture;
        } else {
          startedCapture = await createCaptureState(pendingStartOptions || {}, Number(message.startedAt) || Date.now(), {
            target: "permission-tab",
            tabId: _sender.tab?.id
          });
        }
        if (pendingStartOptions?.sourceTab?.id) {
          chrome.tabs.update(pendingStartOptions.sourceTab.id, { active: true }).catch(() => undefined);
        }
        sendResponse({
          ok: true,
          capture: startedCapture
        });
        pendingStartOptions = null;
        return;
      }

      case "recorder:warning":
        if (capture) {
          capture.warnings.push(message.message);
        }
        sendResponse({ ok: true });
        return;

      case "get-state":
        await pingHelper();
        sendResponse({ ok: true, ...publicState() });
        return;

      case "get-projects":
        sendResponse(await getProjects());
        return;

      case "set-options":
        if (capture) {
          capture.modeSetting = message.mode || capture.modeSetting;
          capture.mode = selectedCaptureMode();
          capture.projectId = message.projectId || capture.projectId;
          capture.transcriptFinalText = message.transcriptFinalText ?? capture.transcriptFinalText;
        }
        sendResponse({ ok: true, ...publicState() });
        return;

      case "tab:current": {
        const tab = await getActiveTab();
        sendResponse({
          ok: true,
          tab: {
            url: tab?.url || "",
            title: tab?.title || ""
          }
        });
        return;
      }

      case "project:add":
        sendResponse({ ok: true, ...(await addProject(message)) });
        return;

      case "config:set-transcription-mode":
        sendResponse({ ok: true, ...(await setTranscriptionMode(message.mode)) });
        return;

      case "config:set-cleanup":
        sendResponse({ ok: true, ...(await setCleanupEnabled(Boolean(message.enabled))) });
        return;

      case "open-mic-permission":
        await openMicrophonePermissionPage(message.options || {});
        sendResponse({ ok: true });
        return;

      case "continue-capture":
        sendResponse({ ok: true, capture: await continueCapture(message.options || {}) });
        return;

      case "discard-capture":
        discardCapture();
        sendResponse({ ok: true, ...publicState() });
        return;

      case "start-capture":
        sendResponse({ ok: true, capture: await startCapture(message.options || {}) });
        return;

      case "stop-capture":
        sendResponse({ ok: true, capture: await stopCapture() });
        return;

      case "take-screenshot":
        sendResponse({ ok: true, ...(await takeScreenshot()), ...publicState() });
        return;

      case "remove-screenshot":
        sendResponse({ ok: true, removed: removeScreenshot(String(message.id)), ...publicState() });
        return;

      case "save-session":
        if (message.transcriptFinalText !== undefined && capture) {
          capture.transcriptFinalText = message.transcriptFinalText;
        }
        sendResponse({ ok: true, result: await saveViaNative(), ...publicState() });
        return;

      case "export-zip":
        if (message.transcriptFinalText !== undefined && capture) {
          capture.transcriptFinalText = message.transcriptFinalText;
        }
        await exportZip();
        sendResponse({ ok: true });
        return;

      case "send-to-codex":
        if (message.transcriptFinalText !== undefined && capture) {
          capture.transcriptFinalText = message.transcriptFinalText;
        }
        sendResponse({ ok: true, result: await sendToCodex() });
        return;

      default:
        sendResponse({ ok: false, error: `Unknown message: ${message.type}` });
    }
  })().catch((error) => sendResponse({ ok: false, error: error.message }));

  return true;
});

chrome.commands.onCommand.addListener((command) => {
  (async () => {
    if (command === "toggle-capture") {
      if (capture && !capture.stoppedAt) {
        await stopCapture();
      } else if (capture?.stoppedAt && !savedSession) {
        await continueCapture();
      } else {
        await startCapture();
      }
    }

    if (command === "take-screenshot") {
      await takeScreenshot();
    }

    if (command === "save-brief") {
      if (await pingHelper(true)) {
        await saveViaNative();
      } else {
        await exportZip();
      }
    }
  })().catch((error) => {
    if (capture) {
      capture.warnings.push(error.message);
    }
  });
});
