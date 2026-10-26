#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { runInit } from "./commands/init.js";
import { runCreate } from "./commands/create.js";
import { runList } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";
import { runClean } from "./commands/clean.js";
import { runDoctor } from "./commands/doctor.js";
import { runFresh, EXIT_UNCHECKED } from "./commands/fresh.js";

const HELP = `mycadre — git worktrees that are ready to work

Usage:
  mycadre init                       Create a mycadre.json config in this repo
  mycadre create <branch> [--from <base>] [--no-setup] [--json]
                                      Create a worktree for <branch>, copy
                                      configured files (e.g. .env) into it,
                                      and run the configured setup command.
                                      Tracks an existing remote branch of the
                                      same name if there is one. --no-setup
                                      skips the setup command. --json prints
                                      {"branch","path"} for scripts.
  mycadre list [--json]              List tracked worktrees (--json for scripts)
  mycadre remove <branch> [--keep-branch] [--force]
                                      Remove a worktree and its branch. The
                                      branch is deleted with a SAFE delete;
                                      unmerged commits are kept unless --force.
  mycadre clean                      Prune worktrees and drop stale tracking entries
  mycadre doctor [--json]            Check git, config, worktreeDir, and tracked
                                      worktrees for common problems
  mycadre fresh [--live <url>] [--base <branch>] [--remote <name>] [--no-pr] [--json]
                                      Read-only check to run before a diff,
                                      review, push, PR, deploy or publish: is
                                      HEAD built on the remote default branch,
                                      is local main behind, is the branch's PR
                                      still open at HEAD, is production ahead.
                                      Exit 0 fresh, 1 stale, 2 could not check.
  mycadre --version                  Print the installed version
  mycadre --help                     Show this help

Config (mycadre.json at repo root; these are the defaults \`init\` writes):
  {
    "worktreeDir": "../mycadre-worktrees",
    "copy": [".env", ".env.local"],
    "setup": null
  }
  "setup" is null by default (no command runs). Set it to e.g. "npm install"
  to run automatically in each new worktree.
`;

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// Per-subcommand usage text (printed for `<cmd> --help`, exit 0 to stdout).
const SUBCOMMAND_USAGE: Record<string, string> = {
  init: `Usage: mycadre init
  Create a mycadre.json config in this repo.`,
  create: `Usage: mycadre create <branch> [--from <base>] [--no-setup] [--json]
  Create a worktree for <branch>, copy configured files (e.g. .env) into it,
  and run the configured setup command. Tracks an existing remote branch of the
  same name if there is one.
  --from <base>  fork the new branch from <base> instead of the current branch
  --no-setup     skip the configured setup command
  --json         print {"branch","path"} to stdout and suppress human logs`,
  list: `Usage: mycadre list [--json]
  List tracked worktrees. --json emits machine-readable output for scripts.`,
  remove: `Usage: mycadre remove <branch> [--keep-branch] [--force]
  Remove a worktree and its branch. The branch is deleted with a SAFE delete;
  unmerged commits are kept unless --force. --keep-branch removes only the worktree.`,
  clean: `Usage: mycadre clean
  Prune worktrees and drop stale tracking entries.`,
  doctor: `Usage: mycadre doctor [--json]
  Check that git is installed, this is a git repo, mycadre.json and
  .mycadre-state.json parse, worktreeDir is usable, and tracked worktrees
  are still present on disk. Exits 1 if any check fails. --json emits
  machine-readable output.`,
  fresh: `Usage: mycadre fresh [--live <url>] [--base <branch>] [--remote <name>] [--no-pr] [--json]
  Read-only check to run right before diffing, reviewing, pushing, opening a PR,
  deploying or publishing. Asks the remote (git ls-remote, then fetches only the
  commits it needs) rather than trusting local refs, and reports:
    base   HEAD contains the remote default branch, or how far behind it is
    local  your local default branch is not behind the remote
    pr     the branch's PR (via gh) is open and its head matches HEAD
    live   with --live, production's commit is not ahead of the remote
  --live <url>     URL returning the deployed commit SHA, as plain text or JSON
                   with a "sha", "commit" or "git_sha" field
  --base <branch>  compare against this remote branch instead of the remote's HEAD
  --remote <name>  remote holding the default branch (default: origin, else the
                   only remote; never a fork the branch happens to track)
  --no-pr          skip the PR check (otherwise a missing gh is "could not check")
  --json           machine-readable output
  Exit codes: 0 fresh, 1 stale, 2 could not check (offline, no remote, gh
  missing). Exit 2 is never a pass. Never checks out, rebases or pushes.`,
};

// Flags each subcommand accepts (bare names, without the leading --). "help" is
// allowed everywhere. Anything else is rejected (issue #7). Aliases share the
// canonical command's entry.
const KNOWN_FLAGS: Record<string, string[]> = {
  init: ["help"],
  create: ["from", "no-setup", "json", "help"],
  list: ["json", "help"],
  ls: ["json", "help"],
  remove: ["keep-branch", "force", "help"],
  rm: ["keep-branch", "force", "help"],
  clean: ["help"],
  doctor: ["json", "help"],
  fresh: ["live", "base", "remote", "no-pr", "json", "help"],
};

// Map command aliases to the canonical name used for usage lookup.
const USAGE_ALIAS: Record<string, string> = { ls: "list", rm: "remove" };

function parseFlags(args: string[]): { positional: string[]; flags: Record<string, string | boolean> } {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function main(): void {
  const [, , cmd, ...rest] = process.argv;
  const { positional, flags } = parseFlags(rest);

  // For real subcommands (not the top-level help/version), `--help`/`-h` prints
  // the subcommand usage to STDOUT and exits 0 (issue #8), and any flag that the
  // subcommand does not recognise is a hard error (issue #7). This runs before
  // dispatch so it applies uniformly.
  if (cmd && KNOWN_FLAGS[cmd]) {
    if (flags.help || flags.h) {
      const usageKey = USAGE_ALIAS[cmd] ?? cmd;
      console.log(SUBCOMMAND_USAGE[usageKey]);
      return;
    }
    const allowed = KNOWN_FLAGS[cmd];
    for (const key of Object.keys(flags)) {
      if (!allowed.includes(key)) {
        console.error(`unknown option: --${key}`);
        console.error(`Run \`mycadre ${cmd} --help\` to see valid options.`);
        // For fresh, exit 1 means "stale"; a usage error is "could not check".
        process.exitCode = cmd === "fresh" ? EXIT_UNCHECKED : 1;
        return;
      }
    }
  }

  try {
    switch (cmd) {
      case "init":
        runInit();
        break;
      case "create":
        runCreate(positional[0], {
          from: flags.from as string | undefined,
          noSetup: Boolean(flags["no-setup"]),
          json: Boolean(flags.json),
        });
        break;
      case "list":
      case "ls":
        runList({ json: Boolean(flags.json) });
        break;
      case "remove":
      case "rm":
        runRemove(positional[0], {
          keepBranch: Boolean(flags["keep-branch"]),
          force: Boolean(flags.force),
        });
        break;
      case "clean":
        runClean();
        break;
      case "doctor":
        runDoctor({ json: Boolean(flags.json) });
        break;
      case "fresh": {
        for (const key of ["live", "base", "remote"]) {
          if (flags[key] === true) {
            console.error(`--${key} needs a value`);
            process.exitCode = EXIT_UNCHECKED;
            return;
          }
        }
        runFresh({
          json: Boolean(flags.json),
          live: flags.live as string | undefined,
          base: flags.base as string | undefined,
          remote: flags.remote as string | undefined,
          noPr: Boolean(flags["no-pr"]),
        }).catch((err) => {
          console.error(`Error: ${(err as Error).message}`);
          process.exitCode = EXIT_UNCHECKED;
        });
        break;
      }
      case "--version":
      case "-v":
      case "version":
        console.log(getVersion());
        break;
      case "--help":
      case "-h":
      case "help":
      case undefined:
        console.log(HELP);
        break;
      default:
        console.error(`Unknown command: ${cmd}`);
        console.error(`Run \`mycadre --help\` to see available commands.`);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
