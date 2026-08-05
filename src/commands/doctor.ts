import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { repoRoot, listGitWorktrees } from "../git.js";
import { configPath, loadConfig, loadState, STATE_FILENAME, CONFIG_FILENAME } from "../config.js";
import type { CopyEntry } from "../config.js";

export interface DoctorOptions {
  json?: boolean;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/**
 * `mycadre doctor` — a health check that catches common setup problems before
 * they surface as a confusing failure mid-`create`: missing git, no config,
 * a worktreeDir that can't be created, copy entries that don't exist, stale
 * tracked worktrees, etc. Prints a pass/fail list and exits 1 if anything failed.
 */
export function runDoctor(opts: DoctorOptions = {}): void {
  const checks: Check[] = [];

  // 1. git on PATH
  try {
    const version = execFileSync("git", ["--version"], { encoding: "utf8" }).trim();
    checks.push({ name: "git", ok: true, detail: version });
  } catch {
    checks.push({ name: "git", ok: false, detail: "git not found on PATH" });
    report(checks, opts);
    return;
  }

  // 2. inside a git repo
  let root: string;
  try {
    root = repoRoot();
    checks.push({ name: "repo", ok: true, detail: root });
  } catch (err) {
    checks.push({ name: "repo", ok: false, detail: (err as Error).message });
    report(checks, opts);
    return;
  }

  // 3. config file present and parses
  const cfgPath = configPath(root);
  let config;
  if (!existsSync(cfgPath)) {
    checks.push({
      name: "config",
      ok: false,
      detail: `no ${CONFIG_FILENAME} found (run: mycadre init) — using built-in defaults for the remaining checks`,
    });
    config = loadConfig(root);
  } else {
    try {
      JSON.parse(readFileSync(cfgPath, "utf8"));
      config = loadConfig(root);
      checks.push({ name: "config", ok: true, detail: cfgPath });
    } catch (err) {
      checks.push({ name: "config", ok: false, detail: `${cfgPath} is not valid JSON: ${(err as Error).message}` });
      report(checks, opts);
      return;
    }
  }

  // 4. worktreeDir resolvable and creatable (parent exists / is a directory)
  const worktreeDirAbs = path.resolve(root, config.worktreeDir);
  const parent = path.dirname(worktreeDirAbs);
  if (existsSync(worktreeDirAbs)) {
    const st = statSync(worktreeDirAbs);
    checks.push({
      name: "worktreeDir",
      ok: st.isDirectory(),
      detail: st.isDirectory()
        ? worktreeDirAbs
        : `${worktreeDirAbs} exists but is not a directory`,
    });
  } else if (existsSync(parent) && statSync(parent).isDirectory()) {
    checks.push({ name: "worktreeDir", ok: true, detail: `${worktreeDirAbs} (will be created on first use)` });
  } else {
    checks.push({
      name: "worktreeDir",
      ok: false,
      detail: `${worktreeDirAbs} — parent directory ${parent} does not exist`,
    });
  }

  // 5. copy entries exist in the repo root
  const copyEntries: CopyEntry[] = config.copy ?? [];
  const missingCopy = copyEntries
    .map((e) => (typeof e === "string" ? e : e.path))
    .filter((p) => !existsSync(path.join(root, p)));
  checks.push({
    name: "copy entries",
    ok: true, // missing copy entries are skipped silently by design, not an error
    detail:
      missingCopy.length === 0
        ? `all ${copyEntries.length} present`
        : `${missingCopy.length} of ${copyEntries.length} not found in repo root (skipped at create time, this is normal for files like .env.local): ${missingCopy.join(", ")}`,
  });

  // 6. setup command configured
  checks.push({
    name: "setup command",
    ok: true,
    detail: config.setup ? config.setup : "none configured (--no-setup effectively always on)",
  });

  // 7. state file parses and tracked worktrees are alive
  const statePath = path.join(root, STATE_FILENAME);
  if (existsSync(statePath)) {
    try {
      JSON.parse(readFileSync(statePath, "utf8"));
      const state = loadState(root);
      const gitTrees = listGitWorktrees(root);
      const missing = state.worktrees.filter(
        (w) => !(existsSync(w.path) && gitTrees.some((g) => g.path === w.path))
      );
      checks.push({
        name: "tracked worktrees",
        ok: missing.length === 0,
        detail:
          missing.length === 0
            ? `${state.worktrees.length} tracked, all present`
            : `${missing.length} of ${state.worktrees.length} missing on disk (run: mycadre clean): ${missing.map((w) => w.branch).join(", ")}`,
      });
    } catch (err) {
      checks.push({ name: "tracked worktrees", ok: false, detail: `${statePath} is not valid JSON: ${(err as Error).message}` });
    }
  } else {
    checks.push({ name: "tracked worktrees", ok: true, detail: "none tracked yet" });
  }

  report(checks, opts);
}

function report(checks: Check[], opts: DoctorOptions): void {
  const allOk = checks.every((c) => c.ok);

  if (opts.json) {
    console.log(JSON.stringify({ ok: allOk, checks }, null, 2));
  } else {
    for (const c of checks) {
      console.log(`${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`);
    }
    console.log(allOk ? "\nAll checks passed." : "\nSome checks failed — see ✗ lines above.");
  }

  if (!allOk) process.exitCode = 1;
}
