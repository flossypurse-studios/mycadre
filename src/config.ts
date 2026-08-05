import { existsSync, readFileSync, writeFileSync, openSync, closeSync, unlinkSync } from "node:fs";
import path from "node:path";

/**
 * A copy entry is either a plain path string (copied into the new worktree
 * with cpSync, the original behavior), or an object requesting symlink mode
 * `{path, mode: "symlink"}`, which creates a symlink in the worktree pointing
 * back at the file/dir in the main repo root instead of duplicating it (issue
 * #10) — useful for large or shared things like node_modules or .env.
 */
export type CopyEntry = string | { path: string; mode: "symlink" };

export interface MycadreConfig {
  /** Directory (relative to repo root) where worktrees are created. */
  worktreeDir: string;
  /** Glob-free list of files/dirs to copy (or symlink) from the repo root into each new worktree (e.g. env files). */
  copy: CopyEntry[];
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

const LOCK_FILENAME = ".mycadre-state.lock";

function lockPath(root: string): string {
  return path.join(root, LOCK_FILENAME);
}

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  Atomics.wait(view, 0, 0, ms);
}

/** Acquire an advisory O_EXCL lock, retrying briefly if held. Throws if it cannot acquire within the timeout. */
function acquireLock(root: string, timeoutMs = 5000): void {
  const p = lockPath(root);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fd = openSync(p, "wx");
      closeSync(fd);
      return;
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for state lock at ${p}`);
      }
      sleepSync(20);
    }
  }
}

function releaseLock(root: string): void {
  try {
    unlinkSync(lockPath(root));
  } catch {
    // already gone; nothing to do
  }
}

/**
 * Read-modify-write the state file under an advisory lock so concurrent
 * `mycadre` invocations against the same repo don't clobber each other's
 * writes (last-write-wins race).
 */
export function updateState(
  root: string,
  mutate: (state: MycadreState) => MycadreState | void,
): MycadreState {
  acquireLock(root);
  try {
    const state = loadState(root);
    const result = mutate(state) ?? state;
    writeState(root, result);
    return result;
  } finally {
    releaseLock(root);
  }
}
