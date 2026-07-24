#!/usr/bin/env node
import { runInit } from "./commands/init.js";
import { runCreate } from "./commands/create.js";
import { runList } from "./commands/list.js";
import { runRemove } from "./commands/remove.js";
import { runClean } from "./commands/clean.js";

const HELP = `mycadre — git worktrees that are ready to work

Usage:
  mycadre init                       Create a mycadre.json config in this repo
  mycadre create <branch> [--from <base>]
                                      Create a worktree for <branch>, copy
                                      configured files (e.g. .env) into it,
                                      and run the configured setup command
  mycadre list                       List tracked worktrees
  mycadre remove <branch> [--keep-branch] [--force]
                                      Remove a worktree and its branch
  mycadre clean                      Prune worktrees and drop stale tracking entries

Config (mycadre.json at repo root):
  {
    "worktreeDir": "../mycadre-worktrees",
    "copy": [".env", ".env.local"],
    "setup": "npm install"
  }
`;

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

  try {
    switch (cmd) {
      case "init":
        runInit();
        break;
      case "create":
        runCreate(positional[0], { from: flags.from as string | undefined });
        break;
      case "list":
      case "ls":
        runList();
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
      case "--help":
      case "-h":
      case "help":
      case undefined:
        console.log(HELP);
        break;
      default:
        console.error(`Unknown command: ${cmd}\n`);
        console.log(HELP);
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`Error: ${(err as Error).message}`);
    process.exitCode = 1;
  }
}

main();
