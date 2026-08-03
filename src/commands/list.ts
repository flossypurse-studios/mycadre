import { existsSync } from "node:fs";
import { repoRoot, listGitWorktrees } from "../git.js";
import { loadState } from "../config.js";

export interface ListOptions {
  json?: boolean;
}

export function runList(opts: ListOptions = {}): void {
  const root = repoRoot();
  const state = loadState(root);
  const gitTrees = listGitWorktrees(root);

  const rows = state.worktrees.map((w) => {
    const alive = existsSync(w.path) && gitTrees.some((g) => g.path === w.path);
    return { branch: w.branch, path: w.path, createdAt: w.createdAt, alive };
  });

  // Issue #5: machine-readable output for scripted use (paths with spaces break
  // the positional tab-separated format).
  if (opts.json) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (rows.length === 0) {
    console.log("No mycadre worktrees tracked. Create one with: mycadre create <branch>");
    return;
  }

  for (const r of rows) {
    const status = r.alive ? "ok" : "MISSING (run: mycadre clean)";
    console.log(`${r.branch}\t${r.path}\t${status}`);
  }
}
