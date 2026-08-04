import { existsSync } from "node:fs";
import { repoRoot, listGitWorktrees, tryGit } from "../git.js";
import { updateState } from "../config.js";

export function runClean(): void {
  const root = repoRoot();
  tryGit(["worktree", "prune"], root);
  const gitTrees = listGitWorktrees(root);

  let before = 0;
  let after = 0;
  updateState(root, (state) => {
    before = state.worktrees.length;
    state.worktrees = state.worktrees.filter((w) => {
      const alive = existsSync(w.path) && gitTrees.some((g) => g.path === w.path);
      if (!alive) console.log(`Untracking stale entry: ${w.branch} (${w.path})`);
      return alive;
    });
    after = state.worktrees.length;
  });

  const removed = before - after;
  console.log(removed === 0 ? "Nothing to clean." : `Cleaned ${removed} stale entr${removed === 1 ? "y" : "ies"}.`);
}
