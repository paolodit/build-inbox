let stream = null;
let recorder = null;
let chunks = [];
let startedAt = 0;
let recognition = null;
let transcriptChunks = [];
let audioContext = null;
let analyser = null;
let meterTimer = null;

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
    return;
  }

  recognition = new Recognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = navigator.language || "en-US";

  recognition.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const text = Array.from(result).map((part) => part.transcript).join("").trim();
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
    chrome.runtime.sendMessage({ target: "background", type: "recorder:warning", message: event.error || "Speech recognition failed." });
  };

  recognition.onend = () => {
    if (recorder?.state === "recording") {
      try {
        recognition.start();
      } catch {
        // Chrome may throw if recognition is already restarting.
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
      const level = Math.min(1, rms * 5);
      chrome.runtime.sendMessage({ target: "background", type: "audio:level", level });
      meterTimer = setTimeout(tick, 100);
    };

    tick();
  } catch (error) {
    chrome.runtime.sendMessage({ target: "background", type: "recorder:warning", message: `Audio meter unavailable: ${error.message}` });
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
  chunks = [];
  transcriptChunks = [];
  startedAt = Date.now();

  stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  startMeter(stream);
  const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus") ? "audio/webm;codecs=opus" : "audio/webm";
  recorder = new MediaRecorder(stream, { mimeType });

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  recorder.start(1000);
  startSpeechRecognition();
  return { ok: true, startedAt };
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
    // Safe to ignore; the audio is still preserved.
  }

  recorder.stop();
  stopMeter();
  stream?.getTracks().forEach((track) => track.stop());
  stream = null;
  return stopped;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.target !== "offscreen") {
    return false;
  }

  if (message.type === "start-recording") {
    startRecording().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "ping") {
    sendResponse({ ok: true });
    return true;
  }

  if (message.type === "stop-recording") {
    stopRecording().then(sendResponse).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  }

  if (message.type === "recorder-state") {
    sendResponse({
      ok: true,
      isRecording: recorder?.state === "recording",
      elapsedMs: startedAt ? Date.now() - startedAt : 0,
      transcriptChunks
    });
    return true;
  }

  return false;
});
