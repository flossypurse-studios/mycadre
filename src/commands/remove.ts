import { existsSync } from "node:fs";
import { branchIsMerged, gitResult, repoRoot } from "../git.js";
import { updateState } from "../config.js";

export interface RemoveOptions {
  keepBranch?: boolean;
  force?: boolean;
}

export function runRemove(branch: string, opts: RemoveOptions): void {
  if (!branch) {
    throw new Error("Usage: mycadre remove <branch>");
  }
  const root = repoRoot();

  // Issue #9: hold the state lock across the whole read-check-act-write
  // sequence so a concurrent `create`/`remove`/`clean` on the same repo can't
  // interleave and clobber this update (last-write-wins race).
  let removed = false;
  updateState(root, (state) => {
    const entry = state.worktrees.find((w) => w.branch === branch);

    if (!entry) {
      // Issue #5: exit non-zero so scripts can distinguish "cleaned up" from
      // "nothing was there".
      console.error(`No tracked worktree for branch '${branch}'.`);
      process.exitCode = 1;
      return;
    }

    // Issue #1: check branch safety BEFORE touching the worktree. A branch that
    // is checked out in a worktree can't be deleted until the worktree is
    // removed, so if we removed first and only then discovered unmerged
    // commits, we'd have already destroyed the worktree while refusing to
    // finish — leaving --force nothing to act on. Refuse up front and keep
    // everything intact instead.
    if (!opts.keepBranch && !opts.force) {
      const merged = branchIsMerged(branch, root);
      if (merged === false) {
        console.error(
          `Branch '${branch}' has unmerged commits and was kept (nothing removed).`
        );
        console.error(
          `Those commits are not on any other branch. To keep them, merge or push first.`
        );
        console.error(
          `To delete anyway and discard them: mycadre remove ${branch} --force`
        );
        process.exitCode = 1;
        return;
      }
    }

    // Remove the worktree. Distinguish "path already gone" (safe to untrack)
    // from any other git refusal, e.g. uncommitted changes (issue #4).
    const pathGone = !existsSync(entry.path);
    const args = ["worktree", "remove", entry.path];
    if (opts.force) args.push("--force");
    const rm = gitResult(args, root);

    if (!rm.ok && !pathGone) {
      // git refused for a real reason (uncommitted changes, etc). Keep the
      // entry tracked and surface git's own message so the user can act on it.
      console.error(`Error: could not remove worktree for '${branch}'.`);
      if (rm.stderr) console.error(rm.stderr);
      if (/contains modified or untracked files|use --force|locked/i.test(rm.stderr)) {
        console.error(
          "Re-run with --force to remove it and discard those changes."
        );
      }
      process.exitCode = 1;
      return;
    }

    if (!rm.ok && pathGone) {
      console.warn(
        `Note: worktree path was already gone (${entry.path}). Untracking it.`
      );
    }

    // Delete the branch. Issue #1: default to a SAFE delete (-d) so unmerged,
    // unpushed commits are never silently discarded. --force escalates to -D.
    if (!opts.keepBranch) {
      const delFlag = opts.force ? "-D" : "-d";
      const del = gitResult(["branch", delFlag, branch], root);
      if (!del.ok) {
        if (/not fully merged/i.test(del.stderr)) {
          console.error(
            `Worktree removed, but branch '${branch}' has unmerged commits and was kept.`
          );
          console.error(
            `Those commits are not on any other branch. To keep them, merge or push first.`
          );
          console.error(
            `To delete anyway and discard them: mycadre remove ${branch} --force`
          );
          // Untrack the (now-removed) worktree but leave the branch intact.
          state.worktrees = state.worktrees.filter((w) => w.branch !== branch);
          process.exitCode = 1;
          return;
        }
        // Some other branch-delete problem (e.g. branch already gone): note
        // it, but the worktree removal still succeeded.
        if (del.stderr) console.warn(del.stderr);
      }
    }

    state.worktrees = state.worktrees.filter((w) => w.branch !== branch);
    removed = true;
  });

  if (removed) {
    console.log(`Removed '${branch}'.`);
  }
}
