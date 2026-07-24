import { existsSync } from "node:fs";
import { repoRoot, listGitWorktrees } from "../git.js";
import { loadState } from "../config.js";

export function runList(): void {
  const root = repoRoot();
  const state = loadState(root);
  const gitTrees = listGitWorktrees(root);

  if (state.worktrees.length === 0) {
    console.log("No mycadre worktrees tracked. Create one with: mycadre create <branch>");
    return;
  }

  for (const w of state.worktrees) {
    const stillExists = existsSync(w.path) && gitTrees.some((g) => g.path === w.path);
    const status = stillExists ? "ok" : "MISSING (run: mycadre clean)";
    console.log(`${w.branch}\t${w.path}\t${status}`);
  }
}
