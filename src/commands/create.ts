import { existsSync, mkdirSync, cpSync } from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  git,
  branchExists,
  remotesWithBranch,
  repoRoot,
  currentBranch,
} from "../git.js";
import { loadConfig, updateState } from "../config.js";

export interface CreateOptions {
  from?: string;
  noSetup?: boolean;
  json?: boolean;
}

export function runCreate(branch: string, opts: CreateOptions): void {
  if (!branch) {
    throw new Error("Usage: mycadre create <branch> [--from <base-branch>] [--no-setup] [--json]");
  }
  // In --json mode stdout is reserved for the final JSON object, so progress
  // messages go to stderr and any setup command's output is redirected there
  // too (issue #7). Otherwise log normally to stdout.
  const log = opts.json
    ? (msg: string) => console.error(msg)
    : (msg: string) => console.log(msg);
  const root = repoRoot();
  const config = loadConfig(root);
  const worktreeDir = path.resolve(root, config.worktreeDir);
  const dirName = branch.replace(/\//g, "-");
  const targetPath = path.join(worktreeDir, dirName);

  if (existsSync(targetPath)) {
    // Issue #5: branch names are flattened (feat/login -> feat-login), so two
    // different branch names can map to the same directory. Explain it.
    throw new Error(
      `Target path already exists: ${targetPath}\n` +
        `(branch names are flattened to a directory name with '/' -> '-', so ` +
        `'${branch}' and any branch sharing the name '${dirName}' collide here). ` +
        `Remove the existing worktree first, or use a distinct branch name.`
    );
  }
  mkdirSync(worktreeDir, { recursive: true });

  const exists = branchExists(branch, root);
  // Track whether THIS run created the branch, so rollback only deletes a
  // branch we introduced (never a pre-existing one). Issue #6.
  let branchCreatedThisRun = false;
  if (exists) {
    log(`Using existing branch '${branch}'`);
    git(["worktree", "add", targetPath, branch], root);
  } else {
    // Issue #2: before forking a NEW branch off HEAD, check for an existing
    // remote branch of the same name and track it instead.
    const remotes = opts.from ? [] : remotesWithBranch(branch, root);
    if (remotes.length === 1) {
      const remote = remotes[0];
      log(`Tracking existing remote branch '${remote}/${branch}'`);
      git(
        ["worktree", "add", "--track", "-b", branch, targetPath, `${remote}/${branch}`],
        root
      );
      branchCreatedThisRun = true;
    } else if (remotes.length > 1) {
      throw new Error(
        `Branch '${branch}' exists on multiple remotes (${remotes.join(", ")}). ` +
          `Disambiguate by fetching and checking out the one you want, then re-run.`
      );
    } else {
      const base = opts.from ?? currentBranch(root);
      if (opts.from && !branchExists(opts.from, root)) {
        throw new Error(
          `Base branch '${opts.from}' does not exist. Create it first, or pass an existing branch to --from.`
        );
      }
      log(`Creating new branch '${branch}' from '${base}'`);
      git(["worktree", "add", "-b", branch, targetPath, base], root);
      branchCreatedThisRun = true;
    }
  }

  // From here on the worktree (and possibly a new branch) exist on disk. If
  // copy or setup fails we must roll the whole thing back, otherwise we leave
  // an untracked zombie worktree that list/clean/prune can't see. Issue #6.
  try {
    // Copy configured files from repo root into the new worktree.
    for (const rel of config.copy) {
      const src = path.join(root, rel);
      const dest = path.join(targetPath, rel);
      if (existsSync(src)) {
        cpSync(src, dest, { recursive: true });
        log(`Copied ${rel}`);
      }
    }

    // Run setup command, if configured (unless suppressed with --no-setup, issue #5).
    if (config.setup && opts.noSetup) {
      log(`Skipping setup (--no-setup): ${config.setup}`);
    } else if (config.setup) {
      log(`Running setup: ${config.setup}`);
      execSync(config.setup, {
        cwd: targetPath,
        stdio: opts.json ? ["ignore", 2, 2] : "inherit",
      });
    }
  } catch (err) {
    console.error(`\nSetup failed; rolling back worktree at ${targetPath}`);
    try {
      git(["worktree", "remove", "--force", targetPath], root);
    } catch {
      /* best-effort cleanup */
    }
    if (branchCreatedThisRun) {
      try {
        git(["branch", "-D", branch], root);
      } catch {
        /* best-effort cleanup */
      }
    }
    throw err;
  }

  updateState(root, (state) => {
    state.worktrees = state.worktrees.filter((w) => w.branch !== branch);
    state.worktrees.push({
      branch,
      path: targetPath,
      createdAt: new Date().toISOString(),
    });
  });

  if (opts.json) {
    console.log(JSON.stringify({ branch, path: targetPath }));
    return;
  }

  console.log(`\nReady: ${targetPath}`);
  console.log(`  cd ${path.relative(process.cwd(), targetPath) || "."}`);
}
