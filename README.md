# mycadre

**Git worktrees that are ready to work.**

`mycadre` creates a git worktree for a branch, copies your untracked local files
(like `.env`) into it, runs your setup command (like `npm install`), and tracks it
so you can list and clean up worktrees without leaving orphans behind.

Git worktrees are great for working on several branches at once — reviewing a PR
while your feature branch keeps building, or running a fleet of AI coding agents in
parallel, each in its own checkout. Plain `git worktree add` just creates the
checkout: it doesn't copy your gitignored `.env` files, run your setup command, or
track what you made for later cleanup. `mycadre` does — in a small, zero-dependency
CLI configured by one `mycadre.json` file.

## Install

```sh
npm install -g mycadre
```

<details>
<summary>Or install from source</summary>

```sh
git clone https://github.com/flossypurse-studios/mycadre.git
cd mycadre
npm install && npm run build
npm link   # makes `mycadre` available globally
```
</details>

Requires Node.js >= 18 and `git` on your PATH.

## Quick start

```sh
# In your project's git repo:
mycadre init                 # writes mycadre.json (edit to taste)
mycadre create feature/login # new branch + worktree, env copied, setup run
mycadre list                 # see your tracked worktrees
mycadre remove feature/login # delete the worktree and its branch
mycadre clean                # prune worktrees git already dropped
```

## Commands

| Command | What it does |
| --- | --- |
| `mycadre init` | Create a `mycadre.json` config at the repo root. |
| `mycadre create <branch> [--from <base>] [--no-setup] [--json]` | Create a worktree for `<branch>` (new branch off `<base>`, or the current branch, unless it already exists), copy configured files into it, and run the setup command. `--no-setup` skips the setup command; `--json` prints `{"branch","path"}` to stdout (progress logs go to stderr) for scripting. |
| `mycadre list [--json]` | List tracked worktrees and flag any that have gone missing. `--json` prints machine-readable output for scripts. |
| `mycadre remove <branch> [--keep-branch] [--force]` | Remove the worktree and (unless `--keep-branch`) delete the branch. |
| `mycadre clean` | Prune git worktrees and drop stale tracking entries. |
| `mycadre doctor [--json]` | Check that git, your repo, `mycadre.json`, `worktreeDir`, and tracked worktrees are all in a healthy state. Exits 1 if anything's wrong. |
| `mycadre fresh [--live <url>] [--base <branch>] [--remote <name>] [--no-pr] [--json]` | Read-only check before you diff, review, push, open a PR, deploy or publish: asks the remote whether HEAD is built on its default branch, whether your local default branch is behind, and whether the branch's PR is still open at HEAD. Exit 0 fresh, 1 stale, 2 could not check. See [Is my branch fresh?](#is-my-branch-fresh). |
| `mycadre commit -m <message> [--dry-run] [--lock-timeout <s>] [--json] <path>...` | Commit exactly the named paths in a checkout other agents share, and nothing else: anything someone else has staged stays staged and out of the commit. Waits out a held `index.lock`. Exit 0 committed, 1 refused or failed, 2 a lock was still held. See [Committing in a shared checkout](#committing-in-a-shared-checkout). |
| `mycadre --version` | Print the installed version (also `-v`). |
| `mycadre --help` | Show usage help (also `-h`). |

## Is my branch fresh?

Parallel branches go stale quietly. Someone merges to `main` while you work, and
your diff now shows their change reverted. A PR gets merged while you are still
pushing to its branch, and the pushes go nowhere. Production gets hot-fixed from a
laptop, and the next deploy from `main` rolls it back. `mycadre fresh` checks for
all three, right before the moment it matters:

```sh
mycadre fresh                                   # before a diff, review, push or PR
mycadre fresh --live https://example.com/version # before a deploy
```

```
✗ base: HEAD is 3 commits behind origin/main (4d1c2ab) — a diff against it will show their changes reverted
    4d1c2ab Fix the login redirect
    9e0b7f1 Bump the API client
    52aa0c3 Drop the old cache
✓ local: local main matches origin/main
✗ pr: PR #42 is ALREADY MERGED — pushing to 'feature/login' goes nowhere; start a new branch from main
✓ live: production (52aa0c3) is 2 commits behind origin/main

STALE — see ✗ lines above. Nothing was changed.
```

- **base** — is the remote's default branch an ancestor of HEAD? It asks the remote
  with `git ls-remote` and fetches only the commits it needs, so an old local
  `origin/main` can't make a stale branch look current.
- **local** — is your local default branch behind the remote?
- **pr** — via [`gh`](https://cli.github.com/), if the branch has a PR: is it still
  open, and is its head in HEAD? Merged or closed PRs are flagged.
- **live** — with `--live <url>`, fetches a URL that returns the deployed commit
  (plain text, or JSON with a `sha`, `commit` or `git_sha` field) and says whether
  production is equal to, behind, or **ahead of** the remote. Ahead means deploying
  from the remote would revert it.

Exit codes: `0` fresh, `1` stale, `2` could not check. A check that could not run
(offline, no remote, `gh` missing or signed out, an unreadable `--live` response) is
exit `2` and never reads as fresh. Pass `--no-pr` to skip the PR check on purpose.
`--json` prints every check for scripts and agents.

It compares against `origin` (or the only remote; `--remote <name>` to choose), even
when your branch tracks a fork, and looks the PR up on that repo.

`fresh` never checks out, rebases, merges or pushes. The only thing it writes is the
`git fetch` of commits it compares against, which updates remote-tracking refs and
`FETCH_HEAD` (no tags, no submodules, no background gc).

## Committing in a shared checkout

Worktrees are the clean answer, but sometimes several agents are working in one
checkout anyway. Then `git commit` goes wrong quietly. Agent A stages its files,
agent B runs `git commit`, and A's files land in B's commit under B's message. Or
the commit fails on `index.lock` because another git process holds it, and the
agent gives up, or retries by deleting the lock out from under that process.
`mycadre commit` commits what you name and nothing else:

```sh
mycadre commit -m "Fix the login redirect" src/login.ts test/login.test.ts
mycadre commit -m "Drop the old cache" --dry-run src/cache/   # show, write nothing
```

```
✓ committed 4d1c2ab on 9e0b7f1
    M src/login.ts
    A test/login.test.ts
4d1c2ab8e1f0c9a7b3d2e6f5a4c3b2a1908f7e6d
```

- **Only your paths.** Adds, changes, deletions and renames under the paths you
  name. Anything else already staged stays staged, exactly as it was, and is not in
  the commit. Paths are required; there is no "commit everything" mode.
- **Refuses before writing.** A path that matches nothing, has no change against
  HEAD, is ignored, or is outside the repo is exit `1` with nothing changed.
- **Waits for locks.** If another process holds `index.lock`, it retries with
  backoff for 30 seconds (`--lock-timeout <s>` to change), then exits `2` and names
  the lock. It never deletes a lock: if no git process is running, the lock is
  stale and yours to remove.
- **Builds on the real HEAD.** If another commit lands while yours runs, yours is
  built on top of it, never reverting it.
- **Hooks run.** It is `git commit --only` underneath, so pre-commit and
  commit-msg hooks run as normal and see only your paths staged. It never passes
  `--no-verify`. If a hook says no, everything is left as it was.

Exit codes: `0` committed, `1` refused or the commit failed, `2` a lock was still
held when the wait ran out. `--json` prints the sha, its parent and every file.

One gap to know about: a new file is marked intent-to-add in the shared index just
before the commit (git needs that to commit it by path). Another agent's plain
`git commit` ignores such an entry, but a `git commit -a` in that moment would
take it.

## Configuration

`mycadre init` writes a `mycadre.json` at your repo root:

```json
{
  "worktreeDir": "../mycadre-worktrees",
  "copy": [".env", ".env.local"],
  "setup": "npm install"
}
```

- **`worktreeDir`** — where worktrees are created, relative to the repo root.
- **`copy`** — files/directories copied from the repo root into each new worktree
  (typically gitignored local config). Missing entries are skipped silently. Each
  entry can be:
  - a plain string (`".env"`) — copied into the worktree, as above; or
  - an object `{"path": "...", "mode": "symlink"}` — a symlink is created in the
    worktree pointing back at the file/dir in the main repo root instead of
    duplicating it. Useful for large or shared things you don't want copies of,
    like `node_modules` or a big `.env` you always want in sync:
    ```json
    "copy": [
      { "path": "node_modules", "mode": "symlink" },
      { "path": ".env", "mode": "symlink" }
    ]
    ```
    The symlink target is relative, so the link keeps working if you move the
    repo (and its worktrees) to a new location together.
- **`setup`** — a shell command run inside the new worktree after creation, or
  `null` to skip.

Commit `mycadre.json` so your team shares the same setup. mycadre stores its
tracking data in `.mycadre-state.json` — add that to your `.gitignore`.

## Why not just `git worktree`?

`git worktree` gives you the checkout. `mycadre` gives you a checkout you can
immediately work in: local env files present, dependencies installed, and a record
of what you created so cleanup is one command instead of archaeology.

## Similar tools

[Worktrunk](https://github.com/max-sixty/worktrunk) manages worktrees by branch name
and adds hooks, a merge workflow, and shared build caches. Claude Code (`--worktree`/
`-w`) and Cursor's Agents Window both create a worktree per parallel agent for you
automatically. mycadre is smaller and more general: no agent runner, no build cache —
one `mycadre.json`, copy some files, run one setup command, track what you made.

## Troubleshooting

- **`Not inside a git repository (or git is not installed).`** — `create`, `list`,
  `remove`, and `clean` must be run from inside your project's git repo. Run `git status`
  to confirm you're in one, and make sure `git` is on your PATH.
- **`Target path already exists: <path>`** — a directory for that branch already exists
  in your `worktreeDir`. Remove it with `mycadre remove <branch>` (or delete the stray
  directory) before recreating it.
- **`No tracked worktree for branch '<branch>'.`** — `remove` didn't find that branch in
  mycadre's tracking data, so there was nothing to remove. This is a warning, not an
  error (mycadre exits 0). Run `mycadre list` to see what's tracked.
- **No `mycadre.json`?** — that's fine: mycadre falls back to sensible defaults
  (`worktreeDir: "../mycadre-worktrees"`, `setup: "npm install"`). Run `mycadre init` to
  write a config you can customize and share with your team.

## License

MIT © mycadre
