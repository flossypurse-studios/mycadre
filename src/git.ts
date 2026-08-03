import { execFileSync } from "node:child_process";
import path from "node:path";

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

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git and always return status + captured stderr (never throws for non-zero exit). */
export function gitResult(args: string[], cwd?: string): GitResult {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    return {
      ok: false,
      stdout: (e.stdout?.toString() ?? "").trim(),
      stderr: (e.stderr?.toString() ?? "").trim(),
    };
  }
}

/**
 * Resolve the MAIN repository root, even when invoked from inside a linked
 * worktree. `--show-toplevel` returns the worktree's own path, which makes
 * config/state/worktreeDir resolve against the wrong directory (see issue #3).
 * `--git-common-dir` always points at the main repo's .git, whose parent is the
 * main working tree root.
 */
export function repoRoot(cwd?: string): string {
  const commonDir = tryGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd
  );
  if (commonDir) {
    // For a bare repo git-common-dir is the repo itself; otherwise it's <root>/.git.
    const base = path.basename(commonDir);
    if (base === ".git") return path.dirname(commonDir);
    // Non-standard (.git as file / --separate-git-dir): fall back to toplevel.
    const top = tryGit(["rev-parse", "--show-toplevel"], cwd);
    if (top) return top;
    return path.dirname(commonDir);
  }
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

/**
 * Find remotes that have a tracking ref for <branch>. Used so `create` can
 * check out an existing remote branch instead of forking a new local one off
 * HEAD (see issue #2).
 */
export function remotesWithBranch(branch: string, cwd?: string): string[] {
  const remotes = (tryGit(["remote"], cwd) ?? "")
    .split("\n")
    .map((r) => r.trim())
    .filter(Boolean);
  return remotes.filter(
    (r) =>
      tryGit(
        ["rev-parse", "--verify", "--quiet", `refs/remotes/${r}/${branch}`],
        cwd
      ) !== null
  );
}

/**
 * Report whether <branch> is safe to delete with `git branch -d` — i.e. its tip
 * is already reachable from HEAD or from its configured upstream, so no unique
 * commits would be lost. Mirrors git's own -d safety check, but can be run
 * BEFORE the worktree is removed so we never destroy work we then refuse to
 * clean up (see issue #1). Returns true if merged, false if it has unmerged
 * commits, and null if the branch can't be resolved.
 */
export function branchIsMerged(branch: string, cwd?: string): boolean | null {
  const tip = tryGit(["rev-parse", "--verify", "--quiet", branch], cwd);
  if (!tip) return null;
  // Merged into current HEAD?
  const inHead = gitResult(
    ["merge-base", "--is-ancestor", branch, "HEAD"],
    cwd
  );
  if (inHead.ok) return true;
  // Merged into its upstream?
  const upstream = tryGit(
    ["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{upstream}`],
    cwd
  );
  if (upstream) {
    const inUpstream = gitResult(
      ["merge-base", "--is-ancestor", branch, upstream],
      cwd
    );
    if (inUpstream.ok) return true;
  }
  return false;
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
