import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export interface CommitOptions {
  message?: string;
  paths: string[];
  json?: boolean;
  dryRun?: boolean;
  /** Seconds to keep retrying while another process holds a git lock. */
  lockTimeout?: number;
  cwd?: string;
}

/**
 * Exit codes. 0 committed (or, with --dry-run, would commit). 1 refused or the
 * commit failed, with nothing written. 2 a lock was still held when the wait ran
 * out: nothing was committed, and the lock is named so you can find its owner.
 */
export const EXIT_COMMITTED = 0;
export const EXIT_REFUSED = 1;
export const EXIT_LOCKED = 2;

export const DEFAULT_LOCK_TIMEOUT_S = 30;
const FIRST_BACKOFF_MS = 100;
const MAX_BACKOFF_MS = 2_000;

interface FileChange {
  status: string;
  path: string;
  from?: string;
}

interface Report {
  result: "committed" | "dry-run" | "refused" | "failed" | "locked";
  exitCode: number;
  sha: string | null;
  parent: string | null;
  branch: string | null;
  files: FileChange[];
  detail: string;
  lock?: string;
  attempts?: number;
  waitedMs?: number;
}

interface Run {
  ok: boolean;
  stdout: string;
  stderr: string;
}

function run(args: string[], cwd: string, env?: NodeJS.ProcessEnv): Run {
  try {
    const stdout = execFileSync("git", ["--literal-pathspecs", ...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: env ?? process.env,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string; message?: string };
    return {
      ok: false,
      stdout: e.stdout?.toString() ?? "",
      stderr: e.stderr?.toString() || e.message || "git failed",
    };
  }
}

function errorLine(s: string): string {
  const lines = s.split("\n").map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error):/i.test(l));
  return (fatal ?? lines.pop() ?? "").replace(/^(fatal|error):\s*/i, "");
}

/** The lock another process holds, if this failure was lock contention. */
export function heldLock(stderr: string): string | null {
  const m = stderr.match(/Unable to create '([^']+\.lock)': File exists/);
  return m ? m[1] : null;
}

/** HEAD moved under a running commit (it CAS-checks the ref). The commit did not land. */
function headMoved(stderr: string): boolean {
  return /cannot lock ref '[^']+': is at [0-9a-f]+ but expected/i.test(stderr);
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** NUL-separated `--name-status` output, with or without renames, as file changes. */
function parseNameStatus(out: string): FileChange[] {
  const parts = out.split("\0").filter((p) => p !== "");
  const files: FileChange[] = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (/^[RC]/.test(status)) {
      files.push({ status: status[0], from: parts[i + 1], path: parts[i + 2] });
      i += 2;
    } else {
      files.push({ status: status[0], path: parts[i + 1] });
      i += 1;
    }
  }
  return files;
}

/** Real path of the longest existing prefix of `p`, with the rest appended. */
function realDir(p: string): string {
  let head = p;
  const tail: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(head), ...tail.reverse());
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return p;
      tail.push(path.basename(head));
      head = parent;
    }
  }
}

/**
 * Resolve `p` the way plain `git commit <path>` does: real, except the final
 * path component is never followed even if it is itself a symlink — that
 * component is the thing named and committed, not whatever it points to. If a
 * symlink shows up earlier in the path (a directory the final component sits
 * inside), the path goes beyond a symbolic link the same way git refuses to,
 * so `beyondSymlink` comes back true instead of silently resolving through it.
 */
function realishPath(p: string): { real: string; beyondSymlink: boolean } {
  const dir = path.dirname(p);
  const base = path.basename(p);
  const realParent = realDir(dir);
  return { real: path.join(realParent, base), beyondSymlink: realParent !== dir };
}

/**
 * `mycadre commit -m <msg> <path>...` — commit exactly the named paths in a
 * checkout other agents are also using, and nothing else.
 *
 * It is `git commit --only -- <paths>`: git builds the commit from HEAD plus the
 * working-tree content of those paths, and anything else someone has staged in
 * the shared index stays staged and out of the commit. New files under the paths
 * are first marked intent-to-add (an entry another agent's plain `git commit`
 * does not pick up), and unmarked again if the commit fails. git holds the index
 * lock across the whole commit and refuses to move HEAD from a parent it did not
 * build on, so a commit that lands concurrently cannot be reverted by this one.
 *
 * When another process holds a lock it retries with backoff, then exits 2 naming
 * the lock. It never deletes a lock and never passes --no-verify.
 */
export function runCommit(opts: CommitOptions): void {
  const report = commit(opts);
  print(report, opts);
  process.exitCode = report.exitCode;
}

function commit(opts: CommitOptions): Report {
  const report: Report = { result: "refused", exitCode: EXIT_REFUSED, sha: null, parent: null, branch: null, files: [], detail: "" };
  const refuse = (detail: string): Report => ({ ...report, result: "refused", exitCode: EXIT_REFUSED, detail });

  if (!opts.message || !opts.message.trim()) return refuse("a commit message is required: -m <message>");
  if (opts.paths.length === 0) return refuse("name the paths to commit: mycadre commit -m <message> <path>...");
  const cwd = opts.cwd ?? process.cwd();

  const top = run(["rev-parse", "--show-toplevel"], cwd);
  if (!top.ok) return refuse("not inside a git working tree");
  const root = realDir(top.stdout.trim());
  const head = run(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], root);
  if (!head.ok) return refuse("HEAD has no commits yet — make the first commit with git");
  const startHead = head.stdout.trim();
  report.branch = run(["symbolic-ref", "--quiet", "--short", "HEAD"], root).stdout.trim() || null;

  // Repo-relative paths. Outside the repo, inside .git, or the whole repo: refused.
  const rel: string[] = [];
  for (const p of opts.paths) {
    const { real, beyondSymlink } = realishPath(path.resolve(cwd, p));
    if (beyondSymlink) return refuse(`'${p}' is beyond a symbolic link — name the real path`);
    const r = path.relative(root, real);
    if (r.startsWith("..") || path.isAbsolute(r)) return refuse(`'${p}' is outside the repository (${root})`);
    if (r === "") return refuse(`'${p}' is the whole repository — name the files or directories you changed`);
    if (r === ".git" || r.startsWith(`.git${path.sep}`)) return refuse(`'${p}' is inside .git`);
    rel.push(r.split(path.sep).join("/"));
  }

  // Work out what would be committed in a throwaway index (HEAD + each path's
  // working-tree content), so checking never takes the shared index's lock.
  const tmp = mkdtempSync(path.join(tmpdir(), "mycadre-commit-"));
  const tmpEnv = { ...process.env, GIT_INDEX_FILE: path.join(tmp, "index") };
  try {
    const read = run(["read-tree", "HEAD"], root, tmpEnv);
    if (!read.ok) return refuse(`could not read HEAD: ${errorLine(read.stderr)}`);
    for (let i = 0; i < rel.length; i++) {
      const added = run(["add", "-A", "--", rel[i]], root, tmpEnv);
      if (!added.ok) {
        if (/did not match any files/i.test(added.stderr)) return refuse(`'${opts.paths[i]}' matches nothing in the working tree or HEAD`);
        if (/ignored by one of your \.gitignore/i.test(added.stderr)) return refuse(`'${opts.paths[i]}' is ignored by .gitignore`);
        return refuse(`could not read '${opts.paths[i]}': ${errorLine(added.stderr)}`);
      }
      const changed = run(["diff", "--cached", "--name-only", "HEAD", "--", rel[i]], root, tmpEnv);
      if (!changed.ok) return refuse(`could not diff '${opts.paths[i]}': ${errorLine(changed.stderr)}`);
      if (!changed.stdout.trim()) return refuse(`'${opts.paths[i]}' has no change against HEAD`);
    }
    const preview = run(["diff", "--cached", "-M", "--name-status", "-z", "HEAD"], root, tmpEnv);
    report.files = parseNameStatus(preview.stdout);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  if (opts.dryRun) {
    return {
      ...report,
      result: "dry-run",
      exitCode: EXIT_COMMITTED,
      parent: startHead,
      detail: `would commit ${report.files.length} file${report.files.length === 1 ? "" : "s"} on ${startHead.slice(0, 7)} — nothing was written`,
    };
  }

  // New files have to be known to git for a pathspec commit to take them.
  const untracked = run(["ls-files", "--others", "--exclude-standard", "-z", "--", ...rel], root);
  const newFiles = untracked.stdout.split("\0").filter(Boolean);

  const timeoutMs = Math.max(0, (opts.lockTimeout ?? DEFAULT_LOCK_TIMEOUT_S) * 1000);
  const started = Date.now();
  let attempts = 0;
  let backoff = FIRST_BACKOFF_MS;
  let marked = false;

  // Run a git write, waiting out other processes' locks; `lock` is set only if the wait ran out.
  const withRetry = (args: string[]): { res: Run; lock: string | null } => {
    for (;;) {
      attempts++;
      const res = run(args, root);
      if (res.ok) return { res, lock: null };
      const lock = heldLock(res.stderr);
      if (!lock && !headMoved(res.stderr)) return { res, lock: null };
      if (Date.now() - started >= timeoutMs) return { res, lock: lock ?? "HEAD" };
      sleep(Math.min(backoff, Math.max(1, timeoutMs - (Date.now() - started))));
      backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
    }
  };

  const unmark = (): string => {
    if (!marked) return "";
    const res = withRetry(["reset", "-q", "--", ...newFiles]).res;
    return res.ok ? "" : ` — and could not unmark the new files (${newFiles.join(", ")}): ${errorLine(res.stderr)}; run git reset -- <file>`;
  };

  if (newFiles.length) {
    const { res, lock } = withRetry(["add", "--intent-to-add", "--", ...newFiles]);
    if (lock) return locked(report, lock, attempts, Date.now() - started);
    if (!res.ok) return { ...report, result: "failed", exitCode: EXIT_REFUSED, detail: `could not add new files: ${errorLine(res.stderr)}` };
    marked = true;
  }

  const { res, lock } = withRetry(["commit", "--only", "-m", opts.message, "--", ...rel]);
  if (res.stderr && res.ok) process.stderr.write(res.stderr);
  if (lock) {
    const r = locked(report, lock, attempts, Date.now() - started);
    return { ...r, detail: r.detail + unmark() };
  }
  if (!res.ok) {
    process.stderr.write(res.stderr);
    return {
      ...report,
      result: "failed",
      exitCode: EXIT_REFUSED,
      attempts,
      detail: `git commit failed: ${errorLine(res.stderr) || "see hook output above"} — nothing was committed${unmark()}`,
    };
  }

  // The sha git reports for THIS commit (HEAD may already have moved on again).
  const m = res.stdout.match(/^\[[^\]]* ([0-9a-f]{4,})\] /m);
  const sha = m ? run(["rev-parse", "--verify", "--quiet", `${m[1]}^{commit}`], root).stdout.trim() : "";
  if (!sha) {
    return { ...report, result: "committed", exitCode: EXIT_COMMITTED, attempts, detail: "committed, but could not read the new sha from git's output" };
  }
  const parent = run(["rev-parse", "--verify", "--quiet", `${sha}^`], root).stdout.trim() || null;
  const landed = run(["diff-tree", "-r", "-M", "--no-commit-id", "--name-status", "-z", `${sha}^`, sha], root);
  const files = parseNameStatus(landed.stdout);
  const moved = parent && parent !== startHead ? ` (HEAD moved from ${startHead.slice(0, 7)} while this ran; built on the new HEAD)` : "";
  return {
    ...report,
    result: "committed",
    exitCode: EXIT_COMMITTED,
    sha,
    parent,
    files,
    attempts,
    waitedMs: Date.now() - started,
    detail: `committed ${sha.slice(0, 7)} on ${parent ? parent.slice(0, 7) : "?"}${moved}`,
  };
}

function locked(report: Report, lock: string, attempts: number, waitedMs: number): Report {
  return {
    ...report,
    result: "locked",
    exitCode: EXIT_LOCKED,
    lock,
    attempts,
    waitedMs,
    detail:
      lock === "HEAD"
        ? `HEAD kept moving for ${Math.round(waitedMs / 1000)}s — nothing was committed`
        : `${lock} is still held by another process after ${Math.round(waitedMs / 1000)}s — nothing was committed. ` +
          `mycadre never deletes a lock; if no git process is running, the lock is stale and yours to remove`,
  };
}

const MARK: Record<Report["result"], string> = { committed: "✓", "dry-run": "-", refused: "✗", failed: "✗", locked: "?" };

function print(report: Report, opts: CommitOptions): void {
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (report.exitCode !== EXIT_COMMITTED) {
    console.error(`${MARK[report.result]} ${report.detail}`);
    return;
  }
  console.log(`${MARK[report.result]} ${report.detail}`);
  for (const f of report.files) console.log(`    ${f.status} ${f.from ? `${f.from} -> ` : ""}${f.path}`);
  if (report.result === "committed" && report.sha) console.log(report.sha);
}
