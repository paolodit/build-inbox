const helperStatus = document.querySelector("#helperStatus");
const apiStatus = document.querySelector("#apiStatus");
const transcribeLight = document.querySelector("#transcribeLight");
const cleanupLight = document.querySelector("#cleanupLight");
const transcribeToggle = document.querySelector("#transcribeToggle");
const cleanupToggle = document.querySelector("#cleanupToggle");
const screenTitle = document.querySelector("#screenTitle");
const recordingDot = document.querySelector("#recordingDot");
const helpToggle = document.querySelector("#helpToggle");
const helpPanel = document.querySelector("#helpPanel");
const helpShortcuts = document.querySelector("#helpShortcuts");
const captureContent = document.querySelector("#captureContent");
const projectSelect = document.querySelector("#projectSelect");
const projectAddToggle = document.querySelector("#projectAddToggle");
const projectPanel = document.querySelector("#projectPanel");
const projectName = document.querySelector("#projectName");
const projectRepo = document.querySelector("#projectRepo");
const projectMatches = document.querySelector("#projectMatches");
const projectGithub = document.querySelector("#projectGithub");
const projectSaveBtn = document.querySelector("#projectSaveBtn");
const projectCancelBtn = document.querySelector("#projectCancelBtn");
const modeSelect = document.querySelector("#modeSelect");
const startBtn = document.querySelector("#startBtn");
const shotBtn = document.querySelector("#shotBtn");
const restartPanel = document.querySelector("#restartPanel");
const continueBtn = document.querySelector("#continueBtn");
const saveNewBtn = document.querySelector("#saveNewBtn");
const discardBtn = document.querySelector("#discardBtn");
const saveBtn = document.querySelector("#saveBtn");
const codexBtn = document.querySelector("#codexBtn");
const zipBtn = document.querySelector("#zipBtn");
const transcript = document.querySelector("#transcript");
const elapsed = document.querySelector("#elapsed");
const shotCount = document.querySelector("#shotCount");
const thumbnailStrip = document.querySelector("#thumbnailStrip");
const statusLine = document.querySelector("#statusLine");
const meter = document.querySelector("#meter");
const meterBars = Array.from(document.querySelectorAll("#meter span"));
const modeHint = document.querySelector("#modeHint");

let helperConnected = false;
let userEditedTranscript = false;
let latestState = null;

function send(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ target: "background", ...message }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      if (!response?.ok) {
        reject(new Error(response?.error || "Build Inbox action failed."));
        return;
      }
      resolve(response);
    });
  });
}

async function ensureScreenshotPermission() {
  if (!chrome.permissions?.contains || !chrome.permissions?.request) {
    return;
  }

  const permission = { origins: ["<all_urls>"] };
  const alreadyGranted = await chrome.permissions.contains(permission);
  if (alreadyGranted) {
    return;
  }

  const granted = await chrome.permissions.request(permission);
  if (!granted) {
    throw new Error("Screenshot permission was not granted. Chrome needs site access to capture from the persistent side panel.");
  }
}

function formatElapsed(ms) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, "0")}`;
}

function selectedProjectId() {
  return projectSelect.value || undefined;
}

function shortcutText() {
  const isMac = navigator.platform.toLowerCase().includes("mac");
  return {
    record: isMac ? "Cmd+Shift+Space" : "Ctrl+Shift+Space",
    shot: isMac ? "Cmd+Shift+S" : "Ctrl+Shift+S",
    save: isMac ? "Cmd+Shift+B" : "Ctrl+Shift+B"
  };
}

function updateShortcuts() {
  const shortcuts = shortcutText();
  document.querySelectorAll("[data-shortcut]").forEach((node) => {
    node.textContent = shortcuts[node.dataset.shortcut];
  });
  renderCaptureButton(Boolean(latestState?.capture && !latestState.capture.stoppedAt));
  shotBtn.title = `Take screenshot (${shortcuts.shot})`;
  saveBtn.title = `Save Build Brief (${shortcuts.save})`;
  helpShortcuts.innerHTML = `
    <div><dt>Record</dt><dd>${shortcuts.record}</dd></div>
    <div><dt>Screenshot</dt><dd>${shortcuts.shot}</dd></div>
    <div><dt>Save</dt><dd>${shortcuts.save}</dd></div>
  `;
}

function setHelpMode(isHelpMode) {
  document.body.classList.toggle("help-mode", isHelpMode);
  helpPanel.hidden = !isHelpMode;
  captureContent.hidden = isHelpMode;
  screenTitle.textContent = isHelpMode ? "Help" : "Build Inbox";
  helpToggle.title = isHelpMode ? "Back" : "Help";
  helpToggle.setAttribute("aria-label", isHelpMode ? "Back to capture" : "Help");
  helpToggle.innerHTML = isHelpMode
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18 9 12l6-6" /><path d="M20 12H9" /></svg>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M9.8 9a2.2 2.2 0 1 1 3.6 1.7c-.9.6-1.4 1.1-1.4 2.3" /><path d="M12 17h.01" /></svg>';
}

function setBusy(isBusy) {
  saveBtn.disabled = isBusy;
  codexBtn.disabled = isBusy || !helperConnected;
  zipBtn.disabled = isBusy;
  startBtn.disabled = isBusy;
  shotBtn.disabled = isBusy;
}

function renderCaptureButton(isRecording) {
  startBtn.classList.toggle("recording", isRecording);
  startBtn.title = `${isRecording ? "Stop" : "Start"} capture (${shortcutText().record})`;
  startBtn.innerHTML = isRecording
    ? '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 7h10v10H7z" /></svg><span>Stop</span>'
    : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7V5Z" /></svg><span>Start</span>';
}

function renderState(state) {
  latestState = state;
  helperConnected = Boolean(state.helperConnected);
  helperStatus.textContent = helperConnected
    ? "Local Helper connected."
    : "Local Helper not connected. You can still export this capture as a zip.";
  renderApiStatus(state.openai);

  const capture = state.capture;
  const isRecording = Boolean(capture && !capture.stoppedAt);
  recordingDot.classList.toggle("active", isRecording);
  elapsed.textContent = formatElapsed(state.elapsedMs || 0);
  shotCount.textContent = `${capture?.screenshots?.length || 0} screenshots`;
  renderThumbnails(capture?.screenshots || []);
  modeHint.textContent = `Auto: ${state.inferredMode || "Note"}`;
  renderCaptureButton(isRecording);
  const level = Math.max(0, Math.min(1, state.audioLevel || 0));
  meter.classList.toggle("active", isRecording);
  meterBars.forEach((bar, index) => {
    const threshold = (index + 1) / meterBars.length;
    const height = isRecording ? 4 + Math.max(0, level - threshold + 0.25) * 58 : 4;
    bar.style.height = `${Math.min(22, height)}px`;
  });

  saveBtn.disabled = !capture;
  codexBtn.disabled = !capture || !helperConnected;
  if (!(capture?.stoppedAt && !state.savedSession)) {
    restartPanel.hidden = true;
  }

  if (capture) {
    modeSelect.value = capture.modeSetting || modeSelect.value;
    if (capture.projectId && projectSelect.value !== capture.projectId) {
      projectSelect.value = capture.projectId;
    }
  }

  const nextTranscript = state.transcriptPreview || state.transcriptText || "";
  if (!userEditedTranscript && transcript.value !== nextTranscript) {
    transcript.value = nextTranscript;
    transcript.scrollTop = transcript.scrollHeight;
  }
}

async function refreshState() {
  const state = await send({ type: "get-state" });
  renderState(state);
}

async function loadProjects() {
  const response = await send({ type: "get-projects" });
  projectSelect.innerHTML = "";

  if (!response.projects?.length) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = "No projects configured";
    projectSelect.append(option);
  } else {
    for (const project of response.projects) {
      const option = document.createElement("option");
      option.value = project.id;
      option.textContent = project.name;
      projectSelect.append(option);
    }
  }

  helperConnected = Boolean(response.ok);
  renderApiStatus(response.openai);
  helperStatus.textContent = helperConnected
    ? "Local Helper connected."
    : response.message || "Local Helper not connected. You can still export this capture as a zip.";
}

function renderApiStatus(openai) {
  if (!helperConnected) {
    apiStatus.textContent = "API: helper offline";
    apiStatus.title = "";
    transcribeToggle.disabled = true;
    cleanupToggle.disabled = true;
    transcribeToggle.checked = false;
    cleanupToggle.checked = false;
    transcribeLight.classList.remove("active");
    cleanupLight.classList.remove("active");
    return;
  }

  const hasKey = Boolean(openai?.hasApiKey);
  const transcribeOn = hasKey && openai?.transcriptionMode === "openai";
  const cleanupOn = hasKey && Boolean(openai?.cleanupEnabled);
  transcribeToggle.disabled = !hasKey;
  cleanupToggle.disabled = !hasKey || !transcribeOn;
  transcribeToggle.checked = transcribeOn;
  cleanupToggle.checked = cleanupOn;
  transcribeLight.classList.toggle("active", transcribeOn);
  cleanupLight.classList.toggle("active", cleanupOn);

  if (!openai?.hasApiKey) {
    apiStatus.textContent = "API: browser mode";
    apiStatus.title = "No OpenAI key is visible to the local helper. Browser/manual transcription still works.";
    return;
  }

  if (openai.transcriptionMode === "openai") {
    if (openai.cleanupEnabled) {
      apiStatus.textContent = `API: OpenAI transcript + cleanup on`;
      apiStatus.title = `Transcription uses ${openai.model}; cleanup/classification uses ${openai.cleanupModel}. Screenshots are not sent.`;
      return;
    }

    apiStatus.textContent = `API: OpenAI transcript on`;
    apiStatus.title = "OpenAI transcription will run after save. Cleanup/classification is optional and off.";
    return;
  }

  apiStatus.textContent = "API: key found, OpenAI off";
  apiStatus.title = "The helper can see an OpenAI key, but transcription mode is still browser/manual.";
}

function renderThumbnails(screenshots) {
  thumbnailStrip.hidden = screenshots.length === 0;
  thumbnailStrip.innerHTML = "";

  for (const shot of screenshots) {
    const item = document.createElement("div");
    item.className = "thumbnail";
    item.title = `Screenshot ${shot.id}`;

    const img = document.createElement("img");
    img.alt = `Screenshot ${shot.id}`;
    img.src = shot.dataBase64;

    const label = document.createElement("span");
    label.textContent = shot.id;

    const remove = document.createElement("button");
    remove.className = "thumb-remove";
    remove.type = "button";
    remove.title = `Remove screenshot ${shot.id}`;
    remove.textContent = "x";

    item.append(img, label, remove);
    item.addEventListener("click", () => {
      const marker = `[Screenshot ${shot.id}`;
      const index = transcript.value.indexOf(marker);
      if (index >= 0) {
        transcript.focus();
        transcript.setSelectionRange(index, Math.min(transcript.value.length, index + marker.length));
      }
    });
    remove.addEventListener("click", (event) => {
      event.stopPropagation();
      withStatus(`Removing screenshot ${shot.id}...`, async () => {
        const response = await send({ type: "remove-screenshot", id: shot.id });
        const markerRegex = new RegExp(`\\n?\\[Screenshot ${shot.id}[^\\n]*\\]`, "g");
        transcript.value = transcript.value.replace(markerRegex, "").replace(/\n{3,}/g, "\n\n").trim();
        statusLine.textContent = `Removed screenshot ${response.removed.id}.`;
      }).catch(() => undefined);
    });
    thumbnailStrip.append(item);
  }
}

async function currentTab() {
  const response = await send({ type: "tab:current" });
  return response.tab || {};
}

async function withStatus(label, action) {
  statusLine.textContent = label;
  setBusy(true);
  try {
    const result = await action();
    await refreshState();
    return result;
  } catch (error) {
    statusLine.textContent = error.message;
    throw error;
  } finally {
    setBusy(false);
    refreshState().catch(() => undefined);
  }
}

transcript.addEventListener("input", () => {
  userEditedTranscript = true;
});

modeSelect.addEventListener("change", () => {
  send({ type: "set-options", mode: modeSelect.value, projectId: selectedProjectId() }).catch((error) => {
    statusLine.textContent = error.message;
  });
});

projectSelect.addEventListener("change", () => {
  send({ type: "set-options", mode: modeSelect.value, projectId: selectedProjectId() }).catch((error) => {
    statusLine.textContent = error.message;
  });
});

helpToggle.addEventListener("click", () => {
  setHelpMode(helpPanel.hidden);
});

projectAddToggle.addEventListener("click", async () => {
  projectPanel.hidden = !projectPanel.hidden;
  if (!projectPanel.hidden) {
    const tab = await currentTab().catch(() => ({}));
    const url = tab.url ? new URL(tab.url) : null;
    projectMatches.value ||= url?.host || "";
    projectName.value ||= tab.title?.split(/[|-]/)[0]?.trim() || "";
    projectRepo.focus();
  }
});

projectCancelBtn.addEventListener("click", () => {
  projectPanel.hidden = true;
});

projectSaveBtn.addEventListener("click", () => {
  withStatus("Adding project...", async () => {
    const response = await send({
      type: "project:add",
      name: projectName.value.trim(),
      repoPath: projectRepo.value.trim(),
      githubRepo: projectGithub.value.trim(),
      urlMatches: projectMatches.value
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean)
    });
    await loadProjects();
    projectSelect.value = response.project.id;
    projectPanel.hidden = true;
    statusLine.textContent = `Added project ${response.project.name}.`;
  }).catch(() => undefined);
});

transcribeToggle.addEventListener("change", () => {
  withStatus("Updating transcription setting...", async () => {
    const response = await send({
      type: "config:set-transcription-mode",
      mode: transcribeToggle.checked ? "openai" : "browser"
    });
    renderApiStatus(response.openai);
    statusLine.textContent = transcribeToggle.checked
      ? "OpenAI transcription enabled. Screenshots are not sent."
      : "OpenAI transcription disabled. Browser/manual transcript will be used.";
  }).catch(() => undefined);
});

cleanupToggle.addEventListener("change", () => {
  withStatus("Updating cleanup setting...", async () => {
    const response = await send({ type: "config:set-cleanup", enabled: cleanupToggle.checked });
    renderApiStatus(response.openai);
    statusLine.textContent = cleanupToggle.checked
      ? "Cleanup/classification enabled. No screenshots are sent to OpenAI."
      : "Cleanup/classification disabled.";
  }).catch(() => undefined);
});

startBtn.addEventListener("click", () => {
  if (latestState?.capture && !latestState.capture.stoppedAt) {
    withStatus("Stopping capture...", async () => {
      await send({ type: "stop-capture" });
      statusLine.textContent = "Capture stopped. Review the transcript, then save.";
    }).catch(() => undefined);
    return;
  }

  userEditedTranscript = false;
  if (latestState?.capture?.stoppedAt && !latestState?.savedSession) {
    restartPanel.hidden = false;
    statusLine.textContent = "Choose how to handle the stopped capture.";
    return;
  }

  withStatus("Starting capture...", async () => {
    const options = {
      mode: modeSelect.value,
      projectId: selectedProjectId()
    };
    await send({
      type: "open-mic-permission",
      options
    });
    statusLine.textContent = "Microphone recorder opened.";
  }).catch(() => undefined);
});

continueBtn.addEventListener("click", () => {
  userEditedTranscript = false;
  withStatus("Continuing capture...", async () => {
    await send({
      type: "continue-capture",
      options: {
        mode: modeSelect.value,
        projectId: selectedProjectId()
      }
    });
    restartPanel.hidden = true;
    statusLine.textContent = "Microphone recorder opened.";
  }).catch(() => undefined);
});

saveNewBtn.addEventListener("click", () => {
  withStatus("Saving previous capture...", async () => {
    await send({
      type: "save-session",
      transcriptFinalText: transcript.value
    });
    await send({
      type: "open-mic-permission",
      options: {
        mode: modeSelect.value,
        projectId: selectedProjectId()
      }
    });
    restartPanel.hidden = true;
    userEditedTranscript = false;
    statusLine.textContent = "Previous capture saved. New recorder opened.";
  }).catch(() => undefined);
});

discardBtn.addEventListener("click", () => {
  withStatus("Discarding capture...", async () => {
    await send({ type: "discard-capture" });
    transcript.value = "";
    userEditedTranscript = false;
    await send({
      type: "open-mic-permission",
      options: {
        mode: modeSelect.value,
        projectId: selectedProjectId()
      }
    });
    restartPanel.hidden = true;
    statusLine.textContent = "Discarded previous capture. New recorder opened.";
  }).catch(() => undefined);
});

shotBtn.addEventListener("click", () => {
  withStatus("Capturing screenshot...", async () => {
    await ensureScreenshotPermission();
    const response = await send({ type: "take-screenshot" });
    if (userEditedTranscript && response.marker?.text && !transcript.value.includes(response.marker.text)) {
      transcript.value = `${transcript.value.trim()}\n${response.marker.text}`.trim();
      transcript.scrollTop = transcript.scrollHeight;
    }
    statusLine.textContent = "Screenshot captured.";
  }).catch(() => undefined);
});

saveBtn.addEventListener("click", () => {
  withStatus("Saving session...", async () => {
    const response = await send({
      type: "save-session",
      transcriptFinalText: transcript.value
    });
    const transcription = response.result.transcription;
    if (transcription?.model && transcription.estimatedCostUsd !== undefined) {
      const seconds = Math.round(transcription.durationSeconds || 0);
      const minutes = Math.floor(seconds / 60);
      const rest = String(seconds % 60).padStart(2, "0");
      statusLine.textContent = `Saved ${response.result.sessionId}. Transcribed ${minutes}m ${rest}s using ${transcription.model}. Estimated cost: $${transcription.estimatedCostUsd.toFixed(3)}.`;
    } else {
      statusLine.textContent = `Saved ${response.result.sessionId}.`;
    }
  }).catch(() => undefined);
});

codexBtn.addEventListener("click", () => {
  withStatus("Sending to Codex...", async () => {
    await send({
      type: "send-to-codex",
      transcriptFinalText: transcript.value
    });
    statusLine.textContent = "Codex launch requested.";
  }).catch(() => undefined);
});

zipBtn.addEventListener("click", () => {
  withStatus("Preparing zip...", async () => {
    await send({
      type: "export-zip",
      transcriptFinalText: transcript.value
    });
    statusLine.textContent = "Zip export started.";
  }).catch(() => undefined);
});

await loadProjects().catch((error) => {
  helperStatus.textContent = error.message;
});
await refreshState().catch((error) => {
  statusLine.textContent = error.message;
});
setInterval(() => {
  refreshState().catch(() => undefined);
}, 1000);
updateShortcuts();
