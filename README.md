# mycadre

**Git worktrees that are ready to work.**

`mycadre` creates a git worktree for a branch, copies your untracked local files
(like `.env`) into it, runs your setup command (like `npm install`), and tracks it
so you can list and clean up worktrees without leaving orphans behind.

Git worktrees are great for working on several branches at once — reviewing a PR
while your feature branch keeps building, or running a fleet of AI coding agents in
parallel, each in its own checkout. But a fresh worktree is never actually ready:
your `.env` files aren't there (they're gitignored), dependencies aren't installed,
and it's easy to lose track of the directories you created. `mycadre` fixes that.

## Install

```sh
npm install -g mycadre
```

> npm package coming soon. Until it's published, install from source:
> ```sh
> git clone https://github.com/flossypurse-studios/mycadre.git
> cd mycadre
> npm install && npm run build
> npm link   # makes `mycadre` available globally
> ```

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
| `mycadre create <branch> [--from <base>]` | Create a worktree for `<branch>` (new branch off `<base>`, or the current branch, unless it already exists), copy configured files into it, and run the setup command. |
| `mycadre list` | List tracked worktrees and flag any that have gone missing. |
| `mycadre remove <branch> [--keep-branch] [--force]` | Remove the worktree and (unless `--keep-branch`) delete the branch. |
| `mycadre clean` | Prune git worktrees and drop stale tracking entries. |
| `mycadre --version` | Print the installed version (also `-v`). |
| `mycadre --help` | Show usage help (also `-h`). |

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
  (typically gitignored local config). Missing entries are skipped silently.
- **`setup`** — a shell command run inside the new worktree after creation, or
  `null` to skip.

Commit `mycadre.json` so your team shares the same setup. mycadre stores its
tracking data in `.mycadre-state.json` — add that to your `.gitignore`.

## Why not just `git worktree`?

`git worktree` gives you the checkout. `mycadre` gives you a checkout you can
immediately work in: local env files present, dependencies installed, and a record
of what you created so cleanup is one command instead of archaeology.

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
