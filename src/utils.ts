import { access, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/['"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

  return slug || "capture";
}

export function formatSessionDate(date: Date): string {
  const yyyy = date.getFullYear();
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const dd = String(date.getDate()).padStart(2, "0");
  const hh = String(date.getHours()).padStart(2, "0");
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}${min}`;
}

export function dataUrlToBuffer(data: string): Buffer {
  const commaIndex = data.indexOf(",");
  const base64 = commaIndex >= 0 ? data.slice(commaIndex + 1) : data;
  return Buffer.from(base64, "base64");
}

export async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(dirPath: string): Promise<void> {
  await mkdir(dirPath, { recursive: true });
}

export async function assertDirectory(dirPath: string, label: string): Promise<void> {
  let info;
  try {
    info = await stat(dirPath);
  } catch {
    throw new Error(`${label} does not exist: ${dirPath}`);
  }

  if (!info.isDirectory()) {
    throw new Error(`${label} is not a directory: ${dirPath}`);
  }
}

export function parseArgs(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }

    const eqIndex = arg.indexOf("=");
    if (eqIndex >= 0) {
      flags[arg.slice(2, eqIndex)] = arg.slice(eqIndex + 1);
      continue;
    }

    const name = arg.slice(2);
    const next = args[i + 1];
    if (next && !next.startsWith("--")) {
      flags[name] = next;
      i += 1;
    } else {
      flags[name] = true;
    }
  }

  return { positional, flags };
}

export function requireStringFlag(
  flags: Record<string, string | boolean>,
  name: string
): string | undefined {
  const value = flags[name];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function minutesSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

export function moduleDir(importMetaUrl: string): string {
  return path.dirname(fileURLToPath(importMetaUrl));
}

export function safeRelativePath(relativePath: string): string {
  const trimmed = relativePath.trim();
  const slashPath = trimmed.replace(/\\/g, "/");
  const segments = slashPath.split("/");
  const normalized = path.posix.normalize(slashPath);
  if (
    !trimmed ||
    normalized === "." ||
    path.isAbsolute(trimmed) ||
    path.win32.isAbsolute(trimmed) ||
    /^[a-zA-Z]:/.test(trimmed) ||
    slashPath.startsWith("/") ||
    segments.includes("..")
  ) {
    throw new Error(`Unsafe relative path: ${relativePath}`);
  }
  return normalized;
}

export function splitCsv(value?: string): string[] {
  if (!value) {
    return [];
  }
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}
