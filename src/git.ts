import { execFileSync } from "node:child_process";

export function git(args: string[], cwd?: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

export function tryGit(args: string[], cwd?: string): string | null {
  try {
    return git(args, cwd);
  } catch {
    return null;
  }
}

export function repoRoot(cwd?: string): string {
  const root = tryGit(["rev-parse", "--show-toplevel"], cwd);
  if (!root) {
    throw new Error(
      "Not inside a git repository (or git is not installed). Run this from within your project's git repo."
    );
  }
  return root;
}

export function branchExists(branch: string, cwd?: string): boolean {
  return (
    tryGit(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], cwd) !==
      null || tryGit(["rev-parse", "--verify", branch], cwd) !== null
  );
}

export function currentBranch(cwd?: string): string {
  return git(["rev-parse", "--abbrev-ref", "HEAD"], cwd);
}

export interface WorktreeInfo {
  path: string;
  branch: string | null;
  head: string;
}

export function listGitWorktrees(cwd?: string): WorktreeInfo[] {
  const out = tryGit(["worktree", "list", "--porcelain"], cwd) ?? "";
  const trees: WorktreeInfo[] = [];
  let cur: Partial<WorktreeInfo> = {};
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      if (cur.path) trees.push(cur as WorktreeInfo);
      cur = { path: line.slice("worktree ".length) };
    } else if (line.startsWith("HEAD ")) {
      cur.head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      cur.branch = line.slice("branch ".length).replace("refs/heads/", "");
    } else if (line === "") {
      // separator, handled by next worktree line
    }
  }
  if (cur.path) trees.push(cur as WorktreeInfo);
  return trees;
}
