import { appendFile, readFile } from "node:fs/promises";
import { BuildInboxConfig, UsageRecord } from "./types.js";
import { getUsagePath } from "./config.js";
import { ensureDir } from "./utils.js";
import path from "node:path";

export function estimateCostUsd(
  config: BuildInboxConfig,
  model: string,
  audioDurationSeconds: number
): number {
  const pricing = config.pricing[model]?.estimatedUsdPerMinute ?? 0;
  return (audioDurationSeconds / 60) * pricing;
}

export function estimateTextCostUsd(
  config: BuildInboxConfig,
  model: string,
  estimatedInputTokens: number,
  estimatedOutputTokens: number
): number {
  const pricing = config.pricing[model];
  const input = pricing?.estimatedUsdPer1MInputTokens ?? 0;
  const output = pricing?.estimatedUsdPer1MOutputTokens ?? 0;
  return (estimatedInputTokens / 1_000_000) * input + (estimatedOutputTokens / 1_000_000) * output;
}

export async function readUsageRecords(): Promise<UsageRecord[]> {
  try {
    const raw = await readFile(getUsagePath(), "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as UsageRecord);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

export async function getMonthlyUsageTotalUsd(now = new Date()): Promise<number> {
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
  const records = await readUsageRecords();
  return records
    .filter((record) => record.timestamp.startsWith(month))
    .reduce((sum, record) => sum + record.estimatedCostUsd, 0);
}

export async function appendUsageRecord(record: UsageRecord): Promise<void> {
  await ensureDir(path.dirname(getUsagePath()));
  await appendFile(getUsagePath(), `${JSON.stringify(record)}\n`, "utf8");
}
