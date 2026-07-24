import { existsSync } from "node:fs";
import { repoRoot, listGitWorktrees, tryGit } from "../git.js";
import { loadState, writeState } from "../config.js";

export function runClean(): void {
  const root = repoRoot();
  tryGit(["worktree", "prune"], root);
  const gitTrees = listGitWorktrees(root);
  const state = loadState(root);

  const before = state.worktrees.length;
  state.worktrees = state.worktrees.filter((w) => {
    const alive = existsSync(w.path) && gitTrees.some((g) => g.path === w.path);
    if (!alive) console.log(`Untracking stale entry: ${w.branch} (${w.path})`);
    return alive;
  });
  writeState(root, state);

  const removed = before - state.worktrees.length;
  console.log(removed === 0 ? "Nothing to clean." : `Cleaned ${removed} stale entr${removed === 1 ? "y" : "ies"}.`);
}
