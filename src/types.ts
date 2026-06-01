export const BUILD_INBOX_VERSION = 1;

export const NATIVE_HOST_NAME = "com.build_inbox.helper";

export const CAPTURE_MODES = [
  "Bug",
  "UX",
  "Feature",
  "Note",
  "Question",
  "Decision",
  "Refactor"
] as const;

export type CaptureMode = (typeof CAPTURE_MODES)[number];

export type TranscriptionMode = "browser" | "openai" | "manual";

export type PrivacyMode = "private" | "repo";

export interface ProjectConfig {
  id: string;
  name: string;
  repoPath: string;
  githubRepo?: string;
  urlMatches: string[];
}

export interface PricingConfig {
  estimatedUsdPerMinute?: number;
  estimatedUsdPer1MInputTokens?: number;
  estimatedUsdPer1MOutputTokens?: number;
}

export interface BuildInboxConfig {
  version: number;
  defaultTranscriptionMode: TranscriptionMode;
  openaiTranscriptionModel: string;
  openaiCleanupModel: string;
  enableApiTranscriptCleanup: boolean;
  monthlyApiBudgetUsd: number;
  privacyMode: PrivacyMode;
  lastSelectedProjectId?: string;
  pricing: Record<string, PricingConfig>;
  projects: ProjectConfig[];
}

export interface CaptureSource {
  browser?: string;
  url: string;
  title: string;
}

export interface TranscriptChunk {
  timestamp: string;
  elapsedMs: number;
  source: "browser-speech" | "manual" | "openai" | "screenshot";
  text: string;
}

export interface ScreenshotEvent {
  id: string;
  type: "screenshot";
  timestamp: string;
  elapsedMs: number;
  url: string;
  title: string;
  filename: string;
  nearTranscript?: string;
  dataBase64?: string;
  tempPath?: string;
}

export interface CaptureAudio {
  filename?: string;
  mimeType?: string;
  durationSeconds?: number;
  dataBase64?: string;
  tempPath?: string;
}

export interface CaptureSavePayload {
  projectId?: string;
  mode: CaptureMode;
  createdAt?: string;
  source: CaptureSource;
  title?: string;
  transcriptionMode?: TranscriptionMode;
  transcriptChunks?: TranscriptChunk[];
  transcriptRawText?: string;
  transcriptFinalText?: string;
  audio?: CaptureAudio;
  audioClips?: CaptureAudio[];
  screenshots?: ScreenshotEvent[];
}

export interface SavedScreenshotMetadata {
  id: string;
  filename: string;
  elapsedMs: number;
  url: string;
  title: string;
  timestamp?: string;
  nearTranscript?: string;
}

export interface SessionMetadata {
  version: number;
  sessionId: string;
  projectId: string;
  projectName: string;
  repoPath: string;
  mode: CaptureMode;
  createdAt: string;
  source: CaptureSource;
  audio?: {
    filename: string;
    durationSeconds?: number;
  };
  audioClips?: Array<{
    filename: string;
    durationSeconds?: number;
  }>;
  transcript: {
    source: TranscriptionMode | "none";
    rawFilename: string;
    finalFilename?: string;
  };
  screenshots: SavedScreenshotMetadata[];
}

export interface SaveSessionResult {
  ok: boolean;
  sessionId: string;
  sessionPath: string;
  projectId: string;
  warnings: string[];
  transcription?: {
    source: TranscriptionMode | "none";
    estimatedCostUsd?: number;
    durationSeconds?: number;
    model?: string;
    message?: string;
  };
}

export interface UsageRecord {
  timestamp: string;
  operation: "transcription" | "cleanup";
  model: string;
  audioDurationSeconds?: number;
  estimatedInputTokens?: number;
  estimatedOutputTokens?: number;
  estimatedCostUsd: number;
  projectId: string;
  sessionId: string;
}

export interface BuildInboxAnalysisItem {
  type: CaptureMode;
  title: string;
  details: string;
  evidence: string;
  screenshotRefs: string[];
  priority: "low" | "medium" | "high";
}

export interface BuildInboxAnalysis {
  title: string;
  summary: string;
  primaryMode: CaptureMode;
  items: BuildInboxAnalysisItem[];
  decisions: string[];
  openQuestions: string[];
  suggestedCodexTask: string;
}
