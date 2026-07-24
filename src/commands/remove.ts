import { tryGit, git, repoRoot } from "../git.js";
import { loadState, writeState } from "../config.js";

export interface RemoveOptions {
  keepBranch?: boolean;
  force?: boolean;
}

export function runRemove(branch: string, opts: RemoveOptions): void {
  if (!branch) {
    throw new Error("Usage: mycadre remove <branch>");
  }
  const root = repoRoot();
  const state = loadState(root);
  const entry = state.worktrees.find((w) => w.branch === branch);

  if (entry) {
    const args = ["worktree", "remove", entry.path];
    if (opts.force) args.push("--force");
    const result = tryGit(args, root);
    if (result === null) {
      console.warn(
        `Warning: 'git worktree remove' failed (path may already be gone). Untracking anyway.`
      );
    }
  } else {
    console.warn(`No tracked worktree for branch '${branch}'.`);
  }

  if (!opts.keepBranch) {
    tryGit(["branch", "-D", branch], root);
  }

  state.worktrees = state.worktrees.filter((w) => w.branch !== branch);
  writeState(root, state);
  console.log(`Removed '${branch}'.`);
}
