import { existsSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { git, tryGit, branchExists, repoRoot, currentBranch } from "../git.js";
import { loadConfig, loadState, writeState } from "../config.js";

export interface CreateOptions {
  from?: string;
}

export function runCreate(branch: string, opts: CreateOptions): void {
  if (!branch) {
    throw new Error("Usage: mycadre create <branch> [--from <base-branch>]");
  }
  const root = repoRoot();
  const config = loadConfig(root);
  const worktreeDir = path.resolve(root, config.worktreeDir);
  const targetPath = path.join(worktreeDir, branch.replace(/\//g, "-"));

  if (existsSync(targetPath)) {
    throw new Error(`Target path already exists: ${targetPath}`);
  }
  mkdirSync(worktreeDir, { recursive: true });

  const exists = branchExists(branch, root);
  if (exists) {
    console.log(`Using existing branch '${branch}'`);
    git(["worktree", "add", targetPath, branch], root);
  } else {
    const base = opts.from ?? currentBranch(root);
    if (opts.from && !branchExists(opts.from, root)) {
      throw new Error(
        `Base branch '${opts.from}' does not exist. Create it first, or pass an existing branch to --from.`
      );
    }
    console.log(`Creating new branch '${branch}' from '${base}'`);
    git(["worktree", "add", "-b", branch, targetPath, base], root);
  }

  // Copy configured files from repo root into the new worktree.
  for (const rel of config.copy) {
    const src = path.join(root, rel);
    const dest = path.join(targetPath, rel);
    if (existsSync(src)) {
      cpSync(src, dest, { recursive: true });
      console.log(`Copied ${rel}`);
    }
  }

  // Run setup command, if configured.
  if (config.setup) {
    console.log(`Running setup: ${config.setup}`);
    execSync(config.setup, { cwd: targetPath, stdio: "inherit" });
  }

  const state = loadState(root);
  state.worktrees = state.worktrees.filter((w) => w.branch !== branch);
  state.worktrees.push({
    branch,
    path: targetPath,
    createdAt: new Date().toISOString(),
  });
  writeState(root, state);

  console.log(`\nReady: ${targetPath}`);
  console.log(`  cd ${path.relative(process.cwd(), targetPath) || "."}`);
}
