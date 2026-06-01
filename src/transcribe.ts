import { createReadStream } from "node:fs";
import { writeFile } from "node:fs/promises";
import { getOpenAIApiKey } from "./config.js";
import { BuildInboxConfig, UsageRecord } from "./types.js";
import { appendUsageRecord, estimateCostUsd, getMonthlyUsageTotalUsd } from "./usage.js";

export interface TranscribeOptions {
  config: BuildInboxConfig;
  audioPath: string;
  outputPath: string;
  audioDurationSeconds: number;
  projectId: string;
  sessionId: string;
}

export interface TranscribeResult {
  ok: boolean;
  text?: string;
  estimatedCostUsd?: number;
  message: string;
}

export async function transcribeWithOpenAI(options: TranscribeOptions): Promise<TranscribeResult> {
  const apiKey = await getOpenAIApiKey();
  const model = options.config.openaiTranscriptionModel || "gpt-4o-mini-transcribe";
  const estimatedCostUsd = estimateCostUsd(options.config, model, options.audioDurationSeconds);

  if (!apiKey) {
    return {
      ok: false,
      estimatedCostUsd,
      message: "OPENAI_API_KEY is not set. Capture saved with browser/manual transcript."
    };
  }

  const usedThisMonth = await getMonthlyUsageTotalUsd();
  if (usedThisMonth + estimatedCostUsd > options.config.monthlyApiBudgetUsd) {
    return {
      ok: false,
      estimatedCostUsd,
      message: "Monthly API budget reached. Capture saved with browser/manual transcript."
    };
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const response = await client.audio.transcriptions.create({
      file: createReadStream(options.audioPath),
      model,
      response_format: "text"
    });

    const text = typeof response === "string" ? response : String(response);
    await writeFile(options.outputPath, text.endsWith("\n") ? text : `${text}\n`, "utf8");

    const usageRecord: UsageRecord = {
      timestamp: new Date().toISOString(),
      operation: "transcription",
      model,
      audioDurationSeconds: options.audioDurationSeconds,
      estimatedCostUsd,
      projectId: options.projectId,
      sessionId: options.sessionId
    };
    await appendUsageRecord(usageRecord);

    return {
      ok: true,
      text,
      estimatedCostUsd,
      message: `Transcribed using ${model}.`
    };
  } catch (error) {
    return {
      ok: false,
      estimatedCostUsd,
      message: `OpenAI transcription failed: ${(error as Error).message}`
    };
  }
}
