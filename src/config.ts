import { mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BuildInboxConfig, ProjectConfig } from "./types.js";
import { pathExists, slugify } from "./utils.js";

export function getConfigDir(): string {
  return process.env.BUILD_INBOX_HOME || path.join(os.homedir(), ".build-inbox");
}

export function getConfigPath(): string {
  return path.join(getConfigDir(), "config.json");
}

export function getLocalConfigPath(): string {
  return path.join(getConfigDir(), "config.local.json");
}

export function getUsagePath(): string {
  return path.join(getConfigDir(), "usage.jsonl");
}

export interface BuildInboxLocalConfig {
  openaiApiKey?: string;
}

export function defaultConfig(): BuildInboxConfig {
  return {
    version: 1,
    defaultTranscriptionMode: "browser",
    openaiTranscriptionModel: "gpt-4o-mini-transcribe",
    openaiCleanupModel: "gpt-4o-mini",
    enableApiTranscriptCleanup: false,
    monthlyApiBudgetUsd: 5,
    privacyMode: "private",
    pricing: {
      "gpt-4o-mini-transcribe": {
        estimatedUsdPerMinute: 0.003
      },
      "gpt-4o-mini": {
        estimatedUsdPer1MInputTokens: 0.15,
        estimatedUsdPer1MOutputTokens: 0.6
      }
    },
    projects: []
  };
}

export async function loadConfig(): Promise<BuildInboxConfig> {
  const configPath = getConfigPath();
  if (!(await pathExists(configPath))) {
    return defaultConfig();
  }

  const raw = await readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as Partial<BuildInboxConfig>;
  const defaults = defaultConfig();

  return {
    ...defaults,
    ...parsed,
    pricing: {
      ...defaults.pricing,
      ...(parsed.pricing || {})
    },
    projects: parsed.projects || []
  };
}

export async function saveConfig(config: BuildInboxConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(getConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function loadLocalConfig(): Promise<BuildInboxLocalConfig> {
  const configPath = getLocalConfigPath();
  if (!(await pathExists(configPath))) {
    return {};
  }

  const raw = await readFile(configPath, "utf8");
  return JSON.parse(raw) as BuildInboxLocalConfig;
}

export async function saveLocalConfig(config: BuildInboxLocalConfig): Promise<void> {
  await mkdir(getConfigDir(), { recursive: true });
  await writeFile(getLocalConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export async function getOpenAIApiKey(): Promise<string | undefined> {
  if (process.env.OPENAI_API_KEY) {
    return process.env.OPENAI_API_KEY;
  }

  const localConfig = await loadLocalConfig();
  return localConfig.openaiApiKey;
}

export async function ensureConfig(): Promise<BuildInboxConfig> {
  const config = await loadConfig();
  await saveConfig(config);
  return config;
}

export function projectIdFromName(name: string): string {
  return slugify(name);
}

export function findProjectById(config: BuildInboxConfig, projectId: string): ProjectConfig | undefined {
  return config.projects.find((project) => project.id === projectId);
}

export function inferProjects(config: BuildInboxConfig, url: string): ProjectConfig[] {
  const lowerUrl = url.toLowerCase();
  return config.projects.filter((project) =>
    project.urlMatches.some((match) => match.trim() && lowerUrl.includes(match.trim().toLowerCase()))
  );
}

export function pickProject(
  config: BuildInboxConfig,
  projectId: string | undefined,
  url: string
): { project?: ProjectConfig; warning?: string; matches: ProjectConfig[] } {
  if (projectId) {
    const project = findProjectById(config, projectId);
    return {
      project,
      matches: project ? [project] : [],
      warning: project ? undefined : `Project not found: ${projectId}`
    };
  }

  const matches = inferProjects(config, url);
  if (matches.length === 1) {
    return { project: matches[0], matches };
  }

  if (matches.length > 1) {
    return {
      project: undefined,
      matches,
      warning: `Multiple projects match ${url}: ${matches.map((project) => project.name).join(", ")}`
    };
  }

  if (config.lastSelectedProjectId) {
    const lastProject = findProjectById(config, config.lastSelectedProjectId);
    if (lastProject) {
      return {
        project: lastProject,
        matches: [],
        warning: `No project matched the URL. Using last selected project: ${lastProject.name}`
      };
    }
  }

  return { project: undefined, matches: [], warning: `No project matched URL: ${url}` };
}
