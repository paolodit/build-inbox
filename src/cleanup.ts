import { writeFile } from "node:fs/promises";
import { getOpenAIApiKey } from "./config.js";
import { appendUsageRecord, estimateTextCostUsd, getMonthlyUsageTotalUsd } from "./usage.js";
import { BuildInboxAnalysis, BuildInboxConfig, SavedScreenshotMetadata, UsageRecord } from "./types.js";

export interface CleanupOptions {
  config: BuildInboxConfig;
  transcript: string;
  screenshots: SavedScreenshotMetadata[];
  outputJsonPath: string;
  projectId: string;
  sessionId: string;
}

export interface CleanupResult {
  ok: boolean;
  analysis?: BuildInboxAnalysis;
  estimatedCostUsd?: number;
  message: string;
}

const analysisSchema = {
  type: "object",
  additionalProperties: false,
  required: ["title", "summary", "primaryMode", "items", "decisions", "openQuestions", "suggestedCodexTask"],
  properties: {
    title: { type: "string" },
    summary: { type: "string" },
    primaryMode: {
      type: "string",
      enum: ["Bug", "UX", "Feature", "Note", "Question", "Decision", "Refactor"]
    },
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "title", "details", "evidence", "screenshotRefs", "priority"],
        properties: {
          type: {
            type: "string",
            enum: ["Bug", "UX", "Feature", "Note", "Question", "Decision", "Refactor"]
          },
          title: { type: "string" },
          details: { type: "string" },
          evidence: { type: "string" },
          screenshotRefs: {
            type: "array",
            items: { type: "string" }
          },
          priority: {
            type: "string",
            enum: ["low", "medium", "high"]
          }
        }
      }
    },
    decisions: {
      type: "array",
      items: { type: "string" }
    },
    openQuestions: {
      type: "array",
      items: { type: "string" }
    },
    suggestedCodexTask: { type: "string" }
  }
};

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function renderGeneratedAnalysis(analysis: BuildInboxAnalysis): string {
  const itemLines = analysis.items.length
    ? analysis.items
        .map((item, index) => {
          const refs = item.screenshotRefs.length ? `\n  Screenshots: ${item.screenshotRefs.join(", ")}` : "";
          return `${index + 1}. [${item.type} / ${item.priority}] ${item.title}\n  ${item.details}\n  Evidence: ${item.evidence}${refs}`;
        })
        .join("\n\n")
    : "No concrete items classified.";

  const decisions = analysis.decisions.length ? analysis.decisions.map((item) => `- ${item}`).join("\n") : "- None identified.";
  const questions = analysis.openQuestions.length
    ? analysis.openQuestions.map((item) => `- ${item}`).join("\n")
    : "- None identified.";

  return `### Generated Summary

${analysis.summary}

Primary mode: ${analysis.primaryMode}

### Classified Items

${itemLines}

### Suggested Codex Task

${analysis.suggestedCodexTask}

### Decisions

${decisions}

### Open Questions

${questions}`;
}

export async function cleanupTranscriptWithOpenAI(options: CleanupOptions): Promise<CleanupResult> {
  const apiKey = await getOpenAIApiKey();
  const model = options.config.openaiCleanupModel || "gpt-4o-mini";
  const screenshotContext = options.screenshots
    .map((shot) => `Screenshot ${shot.id}: ${shot.filename}, at ${Math.round(shot.elapsedMs / 1000)}s, title: ${shot.title}, url: ${shot.url}`)
    .join("\n");
  const inputText = `Transcript:\n${options.transcript}\n\nScreenshots:\n${screenshotContext || "No screenshots."}`;
  const estimatedInputTokens = estimateTokens(inputText) + 500;
  const estimatedOutputTokens = 900;
  const estimatedCostUsd = estimateTextCostUsd(options.config, model, estimatedInputTokens, estimatedOutputTokens);

  if (!apiKey) {
    return {
      ok: false,
      estimatedCostUsd,
      message: "OPENAI_API_KEY is not set. Skipping transcript cleanup."
    };
  }

  const usedThisMonth = await getMonthlyUsageTotalUsd();
  if (usedThisMonth + estimatedCostUsd > options.config.monthlyApiBudgetUsd) {
    return {
      ok: false,
      estimatedCostUsd,
      message: "Monthly API budget reached. Skipping transcript cleanup."
    };
  }

  try {
    const { default: OpenAI } = await import("openai");
    const client = new OpenAI({ apiKey });
    const response = await (client as any).responses.create({
      model,
      input: [
        {
          role: "system",
          content:
            "You clean up Build Inbox capture transcripts. Preserve meaning, do not invent facts, and use screenshot markers/filenames only as references. Classify concrete work into the requested product/coding/UX categories."
        },
        {
          role: "user",
          content: inputText
        }
      ],
      text: {
        format: {
          type: "json_schema",
          name: "build_inbox_analysis",
          strict: true,
          schema: analysisSchema
        }
      }
    });

    const output = response.output_text || response.output?.[0]?.content?.[0]?.text;
    if (!output) {
      throw new Error("OpenAI cleanup returned no text.");
    }

    const analysis = JSON.parse(output) as BuildInboxAnalysis;
    await writeFile(options.outputJsonPath, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");

    const usageRecord: UsageRecord = {
      timestamp: new Date().toISOString(),
      operation: "cleanup",
      model,
      estimatedInputTokens,
      estimatedOutputTokens,
      estimatedCostUsd,
      projectId: options.projectId,
      sessionId: options.sessionId
    };
    await appendUsageRecord(usageRecord);

    return {
      ok: true,
      analysis,
      estimatedCostUsd,
      message: `Cleaned up transcript using ${model}.`
    };
  } catch (error) {
    return {
      ok: false,
      estimatedCostUsd,
      message: `OpenAI transcript cleanup failed: ${(error as Error).message}`
    };
  }
}
