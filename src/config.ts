import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface MycadreConfig {
  /** Directory (relative to repo root) where worktrees are created. */
  worktreeDir: string;
  /** Glob-free list of files/dirs to copy from the repo root into each new worktree (e.g. env files). */
  copy: string[];
  /** Shell command to run inside the new worktree after creation (e.g. "npm install"). */
  setup: string | null;
}

export const DEFAULT_CONFIG: MycadreConfig = {
  worktreeDir: "../mycadre-worktrees",
  copy: [".env", ".env.local"],
  setup: null,
};

export const CONFIG_FILENAME = "mycadre.json";
export const STATE_FILENAME = ".mycadre-state.json";

export function configPath(root: string): string {
  return path.join(root, CONFIG_FILENAME);
}

export function loadConfig(root: string): MycadreConfig {
  const p = configPath(root);
  if (!existsSync(p)) return { ...DEFAULT_CONFIG };
  const raw = JSON.parse(readFileSync(p, "utf8"));
  return { ...DEFAULT_CONFIG, ...raw };
}

export function writeConfig(root: string, config: MycadreConfig): void {
  writeFileSync(configPath(root), JSON.stringify(config, null, 2) + "\n");
}

export interface TrackedWorktree {
  branch: string;
  path: string;
  createdAt: string;
}

export interface MycadreState {
  worktrees: TrackedWorktree[];
}

function statePath(root: string): string {
  return path.join(root, STATE_FILENAME);
}

export function loadState(root: string): MycadreState {
  const p = statePath(root);
  if (!existsSync(p)) return { worktrees: [] };
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return { worktrees: [] };
  }
}

export function writeState(root: string, state: MycadreState): void {
  writeFileSync(statePath(root), JSON.stringify(state, null, 2) + "\n");
}
