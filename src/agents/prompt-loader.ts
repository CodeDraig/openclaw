import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";

/**
 * Resolves the directory containing prompt markdown files.
 *
 * Search order:
 * 1. `src/agents/prompts/` relative to the package root (found via package.json)
 * 2. `../prompts/` relative to the current module (fallback for bundled builds)
 */
function resolvePromptsDir(): string {
  // Try package-root resolution first (works for both dev and installed)
  const packageRoot = resolveOpenClawPackageRootSync({
    moduleUrl: import.meta.url,
    argv1: process.argv[1],
    cwd: process.cwd(),
  });
  if (packageRoot) {
    const candidate = path.join(packageRoot, "src", "agents", "prompts");
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  // Fallback: resolve relative to this file (works when files are co-located)
  const thisDir = path.dirname(fileURLToPath(import.meta.url));
  const fallback = path.join(thisDir, "prompts");
  if (fs.existsSync(fallback)) {
    return fallback;
  }

  throw new Error(
    `Could not locate prompt markdown files. Searched:\n` +
      `  - ${packageRoot ? path.join(packageRoot, "src", "agents", "prompts") : "(no package root)"}\n` +
      `  - ${fallback}`,
  );
}

let cachedPromptsDir: string | undefined;

function getPromptsDir(): string {
  if (!cachedPromptsDir) {
    cachedPromptsDir = resolvePromptsDir();
  }
  return cachedPromptsDir;
}

const promptCache = new Map<string, string>();

/**
 * Loads a prompt markdown file by name (without .md extension).
 * Results are cached in memory after first load.
 */
export function loadPrompt(name: string): string {
  const cached = promptCache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const filePath = path.join(getPromptsDir(), `${name}.md`);
  const content = fs.readFileSync(filePath, "utf-8").trimEnd();
  promptCache.set(name, content);
  return content;
}

/**
 * Loads a prompt markdown file and replaces `{{key}}` placeholders with
 * the corresponding values from the provided variables map.
 *
 * Unmatched placeholders are left as-is (no error).
 */
export function loadPromptWithVars(
  name: string,
  vars: Record<string, string>,
): string {
  let content = loadPrompt(name);
  for (const [key, value] of Object.entries(vars)) {
    content = content.replaceAll(`{{${key}}}`, value);
  }
  return content;
}

/**
 * Parses the tool-summaries.md file into a Record<string, string> map.
 * Each line should be in the format: `toolName: description`
 */
export function loadToolSummaries(): Record<string, string> {
  const content = loadPrompt("tool-summaries");
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }
    const colonIndex = trimmed.indexOf(": ");
    if (colonIndex === -1) {
      continue;
    }
    const key = trimmed.slice(0, colonIndex).trim();
    const value = trimmed.slice(colonIndex + 2).trim();
    if (key && value) {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Clears the prompt cache. Useful for testing or hot-reloading.
 */
export function clearPromptCache(): void {
  promptCache.clear();
  cachedPromptsDir = undefined;
}
