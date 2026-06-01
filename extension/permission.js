const grantBtn = document.querySelector("#grantBtn");
const status = document.querySelector("#status");

let stream = null;
let recorder = null;
let chunks = [];
let startedAt = 0;
let recognition = null;
let transcriptChunks = [];
let audioContext = null;
let analyser = null;
let meterTimer = null;
let startRequest = null;

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

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => resolve(String(reader.result));
    reader.readAsDataURL(blob);
  });
}

function speechRecognitionCtor() {
  return self.SpeechRecognition || self.webkitSpeechRecognition;
}

function startSpeechRecognition() {
  const Recognition = speechRecognitionCtor();
  if (!Recognition) {
    status.textContent = "Recording audio. Browser speech transcript is unavailable in this Chrome context.";
    return;
  }

  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = Array.from(result)
        .map((part) => part.transcript)
        .join("")
        .trim();
      if (!text) {
        continue;
      }

      if (result.isFinal) {
        const chunk = {
          timestamp: new Date().toISOString(),
          elapsedMs: Date.now() - startedAt,
          source: "browser-speech",
          text
        };
        transcriptChunks.push(chunk);
        chrome.runtime.sendMessage({ target: "background", type: "transcript:chunk", chunk });
      } else {
        chrome.runtime.sendMessage({ target: "background", type: "transcript:interim", text });
      }
    }
  };

  recognition.onerror = (event) => {
    chrome.runtime.sendMessage({
      target: "background",
      type: "recorder:warning",
      message: event.error || "Speech recognition failed."
    });
  };

  recognition.onend = () => {
    if (recorder?.state === "recording") {
      try {
        recognition.start();
      } catch {
        // Chrome can briefly report "already started" while it restarts.
      }
    }
  };

  try {
    recognition.start();
  } catch {
    recognition = null;
  }
}

function startMeter(inputStream) {
  try {
    audioContext = new AudioContext();
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 256;
    const source = audioContext.createMediaStreamSource(inputStream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);

    const tick = () => {
      if (!analyser || recorder?.state !== "recording") {
        return;
      }

      analyser.getByteTimeDomainData(data);
      let sum = 0;
      for (const value of data) {
        const normalized = (value - 128) / 128;
        sum += normalized * normalized;
      }
      const rms = Math.sqrt(sum / data.length);
      const level = Math.min(1, rms * 8);
      chrome.runtime.sendMessage({ target: "background", type: "audio:level", level });
      meterTimer = setTimeout(tick, 80);
    };

    tick();
  } catch (error) {
    chrome.runtime.sendMessage({
      target: "background",
      type: "recorder:warning",
      message: `Audio meter unavailable: ${error.message}`
    });
  }
}

function stopMeter() {
  if (meterTimer) {
    clearTimeout(meterTimer);
    meterTimer = null;
  }
  analyser = null;
  audioContext?.close().catch(() => undefined);
  audioContext = null;
  chrome.runtime.sendMessage({ target: "background", type: "audio:level", level: 0 });
}

async function startRecording() {
  if (recorder?.state === "recording") {
    return;
  }

  chunks = [];
  transcriptChunks = [];
  startedAt = Date.now();
  stream = await navigator.mediaDevices.getUserMedia({ audio: true });

  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  recorder = new MediaRecorder(stream, { mimeType });
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder.start(1000);
  startMeter(stream);
  startSpeechRecognition();
  await send({ type: "permission-recorder-started", startedAt });
  status.textContent = "Recording. This tab stays ready in the background for this capture session.";
}

async function stopRecording() {
  if (!recorder || recorder.state === "inactive") {
    return {
      ok: true,
      audioDataUrl: null,
      durationSeconds: 0,
      transcriptChunks
    };
  }

  const stopped = new Promise((resolve) => {
    recorder.onstop = async () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
      const audioDataUrl = await blobToDataUrl(blob);
      const durationSeconds = (Date.now() - startedAt) / 1000;
      resolve({
        ok: true,
        audioDataUrl,
        mimeType: blob.type,
        durationSeconds,
        transcriptChunks
      });
    };
  });

  try {
    recognition?.stop();
  } catch {
    // Audio is still preserved.
  }

  recorder.stop();
  stopMeter();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  grantBtn.disabled = false;
  grantBtn.textContent = "Start Again";
  status.textContent = "Recording stopped. Return to Build Inbox, or start again here.";
  return stopped;
}

async function requestRecordingStart() {
  if (startRequest) {
    return startRequest;
  }

  grantBtn.disabled = true;
  status.textContent = "Requesting microphone permission...";

  startRequest = (async () => {
    await startRecording();
    grantBtn.textContent = "Recording";
  })();

  try {
    await startRequest;
  } catch (error) {
    grantBtn.disabled = false;
    grantBtn.textContent = "Allow Microphone";
    status.textContent = `Microphone was not allowed: ${error.message}`;
    throw error;
  } finally {
    startRequest = null;
  }
}

grantBtn.addEventListener("click", async () => {
  requestRecordingStart().catch(() => undefined);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "permission-recorder") {
    return false;
  }

  if (message.type === "ping") {
    sendResponse({ ok: true, isRecording: recorder?.state === "recording" });
    return true;
  }

  if (message.type === "stop-recording") {
    stopRecording().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "start-recording") {
    requestRecordingStart()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  return false;
});

requestRecordingStart().catch(() => undefined);
