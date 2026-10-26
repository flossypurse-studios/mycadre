import { execFileSync } from "node:child_process";
import { gitResult, tryGit } from "../git.js";

export interface FreshOptions {
  json?: boolean;
  remote?: string;
  base?: string;
  live?: string;
  noPr?: boolean;
}

/**
 * Exit codes. "unchecked" is deliberately distinct from both: a check that
 * could not run (offline, no remote, gh missing) must never read as fresh.
 */
export const EXIT_FRESH = 0;
export const EXIT_STALE = 1;
export const EXIT_UNCHECKED = 2;

type Status = "ok" | "stale" | "unchecked" | "skipped";

interface Check {
  name: string;
  status: Status;
  detail: string;
  lines?: string[];
  data?: Record<string, unknown>;
}

interface Report {
  verdict: "fresh" | "stale" | "unchecked";
  exitCode: number;
  remote: string | null;
  defaultBranch: string | null;
  remoteSha: string | null;
  head: string | null;
  branch: string | null;
  checks: Check[];
}

// Network git calls must never hang on a credential or passphrase prompt, and must give up.
const NET_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GCM_INTERACTIVE: "never",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
};
const NET_TIMEOUT_MS = 20_000;
// The fetch is the one write fresh makes: keep it to objects + remote-tracking refs
// (and FETCH_HEAD) — no tags, no submodules, no background gc or maintenance.
const FETCH = ["-c", "gc.auto=0", "-c", "maintenance.auto=false", "fetch", "--quiet", "--no-tags", "--no-recurse-submodules"];
const MISSING_SUBJECTS = 5;

function netGit(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: NET_ENV,
      timeout: NET_TIMEOUT_MS,
    });
    return { ok: true, stdout: stdout.trim(), stderr: "" };
  } catch (err) {
    const e = err as { stderr?: Buffer | string; code?: string };
    const stderr = (e.stderr?.toString() ?? "").trim();
    return { ok: false, stdout: "", stderr: stderr || (e.code === "ETIMEDOUT" ? "timed out" : "failed") };
  }
}

// git puts the useful part ("fatal: ...") on the last line.
function lastLine(s: string): string {
  return s.split("\n").map((l) => l.trim()).filter(Boolean).pop() ?? "";
}

function short(sha: string | null | undefined): string {
  return sha ? sha.slice(0, 7) : "?";
}

function hasCommit(sha: string): boolean {
  return tryGit(["cat-file", "-e", `${sha}^{commit}`]) !== null;
}

function isAncestor(a: string, b: string): boolean {
  return gitResult(["merge-base", "--is-ancestor", a, b]).ok;
}

function countRange(range: string): number {
  return Number(tryGit(["rev-list", "--count", range]) ?? "0");
}

function subjects(range: string): string[] {
  const out = tryGit(["log", `-n${MISSING_SUBJECTS}`, "--format=%h %s", range]) ?? "";
  return out ? out.split("\n") : [];
}

function listRemotes(): string[] {
  return (tryGit(["remote"]) ?? "").split("\n").map((r) => r.trim()).filter(Boolean);
}

/**
 * Pick the remote that holds the default branch: --remote, else origin, else the
 * only one. Deliberately NOT the current branch's upstream — a branch that tracks
 * a fork would then be compared against the fork's (usually stale) main.
 */
function pickRemote(explicit: string | undefined, remotes: string[]): string | null {
  if (explicit) return remotes.includes(explicit) ? explicit : null;
  if (remotes.includes("origin")) return "origin";
  return remotes.length === 1 ? remotes[0] : null;
}

/** The remote this branch pushes to: pushRemote, pushDefault, its upstream remote, else the base remote. */
function pushRemoteFor(branch: string, base: string, remotes: string[]): string {
  for (const key of [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]) {
    const r = tryGit(["config", key]);
    if (r && remotes.includes(r)) return r;
  }
  return base;
}

/** owner/repo from a GitHub remote URL (raw config value, before insteadOf rewriting). */
export function githubSlug(url: string): string | null {
  const m = url.match(/github\.com(?::\d+)?[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

/** Pull a commit SHA out of a deploy-info response: plain text, or JSON with sha/commit/git_sha. */
export function parseLiveSha(body: string): string | null {
  const text = body.trim();
  const isSha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{7,40}$/i.test(v.trim());
  try {
    const json = JSON.parse(text);
    if (json && typeof json === "object") {
      for (const key of ["sha", "commit", "git_sha", "gitSha", "commit_sha"]) {
        const v = (json as Record<string, unknown>)[key];
        if (isSha(v)) return v.trim().toLowerCase();
      }
      return null;
    }
    if (isSha(json)) return json.trim().toLowerCase();
    // An all-digit short SHA ("1234567") parses as a number: read it as text.
  } catch {
    // not JSON: plain text
  }
  const token = text.split(/\s+/)[0] ?? "";
  return isSha(token) ? token.toLowerCase() : null;
}

/**
 * `mycadre fresh` — a read-only check to run right before diffing, reviewing,
 * pushing, opening a PR, deploying or publishing. It asks the REMOTE (not your
 * possibly-stale remote-tracking refs) whether your work is built on the
 * current default branch, whether your local default branch has fallen behind,
 * whether the branch's PR is still open at your HEAD, and optionally whether
 * production is running something origin doesn't have.
 *
 * It never checks out, rebases, merges or pushes. The only write is a
 * `git fetch` of the commits it needs to compare against, which updates
 * remote-tracking refs and FETCH_HEAD and nothing else.
 */
export async function runFresh(opts: FreshOptions = {}): Promise<void> {
  const report = await check(opts);
  print(report, opts);
  process.exitCode = report.exitCode;
}

async function check(opts: FreshOptions): Promise<Report> {
  const checks: Check[] = [];
  const report: Report = {
    verdict: "unchecked",
    exitCode: EXIT_UNCHECKED,
    remote: null,
    defaultBranch: null,
    remoteSha: null,
    head: null,
    branch: null,
    checks,
  };
  const finish = (): Report => {
    if (checks.some((c) => c.status === "stale")) {
      report.verdict = "stale";
      report.exitCode = EXIT_STALE;
    } else if (checks.length === 0 || checks.some((c) => c.status === "unchecked")) {
      report.verdict = "unchecked";
      report.exitCode = EXIT_UNCHECKED;
    } else {
      report.verdict = "fresh";
      report.exitCode = EXIT_FRESH;
    }
    return report;
  };
  const unchecked = (name: string, detail: string): Report => {
    checks.push({ name, status: "unchecked", detail });
    return finish();
  };

  if (tryGit(["rev-parse", "--is-inside-work-tree"]) !== "true") {
    return unchecked("repo", "not inside a git working tree");
  }
  const head = tryGit(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (!head) return unchecked("repo", "HEAD has no commits yet");
  report.head = head;
  const symbolic = tryGit(["symbolic-ref", "--quiet", "--short", "HEAD"]);
  report.branch = symbolic;

  const remotes = listRemotes();
  const remote = pickRemote(opts.remote, remotes);
  if (!remote) {
    return unchecked(
      "remote",
      opts.remote
        ? `no remote named '${opts.remote}'`
        : remotes.length
          ? `no 'origin' among remotes ${remotes.join(", ")} — pass --remote <name>`
          : "no remote to check against (add one, or pass --remote <name>)"
    );
  }
  report.remote = remote;

  // 1. Ask the remote itself. A local refs/remotes/* can be arbitrarily old.
  let defaultBranch = opts.base ?? null;
  let remoteSha: string | null = null;
  if (defaultBranch) {
    const res = netGit(["ls-remote", remote, `refs/heads/${defaultBranch}`]);
    if (!res.ok) return unchecked("base", `could not reach '${remote}': ${lastLine(res.stderr)}`);
    remoteSha = res.stdout.split(/\s+/)[0] || null;
    if (!remoteSha) return unchecked("base", `branch '${defaultBranch}' does not exist on '${remote}'`);
  } else {
    const res = netGit(["ls-remote", "--symref", remote, "HEAD"]);
    if (!res.ok) return unchecked("base", `could not reach '${remote}': ${lastLine(res.stderr)}`);
    for (const line of res.stdout.split("\n")) {
      const sym = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
      if (sym) defaultBranch = sym[1];
      else if (/\tHEAD$/.test(line)) remoteSha = line.split(/\s+/)[0];
    }
    if (!defaultBranch || !remoteSha) {
      return unchecked(
        "base",
        `'${remote}' did not report a default branch (empty remote, or a server that hides HEAD) — pass --base <branch>`
      );
    }
  }
  report.defaultBranch = defaultBranch;
  report.remoteSha = remoteSha;
  const remoteName = `${remote}/${defaultBranch}`;

  const trackingBefore = tryGit(["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteName}`]);
  if (!hasCommit(remoteSha)) {
    const res = netGit([...FETCH, remote, defaultBranch]);
    if (!res.ok || !hasCommit(remoteSha)) {
      return unchecked("base", `could not fetch ${remoteName} (${short(remoteSha)}): ${lastLine(res.stderr) || "commit still missing"}`);
    }
  }

  const trackingNote =
    trackingBefore && trackingBefore !== remoteSha
      ? ` (your local ${remoteName} ref was ${short(trackingBefore)} — out of date)`
      : "";
  if (isAncestor(remoteSha, head)) {
    checks.push({
      name: "base",
      status: "ok",
      detail: `HEAD contains ${remoteName} (${short(remoteSha)})${trackingNote}`,
      data: { behind: 0 },
    });
  } else {
    const behind = countRange(`${head}..${remoteSha}`);
    checks.push({
      name: "base",
      status: "stale",
      detail: `HEAD is ${behind} commit${behind === 1 ? "" : "s"} behind ${remoteName} (${short(remoteSha)})${trackingNote} — a diff against it will show their changes reverted`,
      lines: subjects(`${head}..${remoteSha}`),
      data: { behind },
    });
  }

  // 2. Local default branch vs the remote.
  const localDefault = tryGit(["rev-parse", "--verify", "--quiet", `refs/heads/${defaultBranch}`]);
  if (!localDefault) {
    checks.push({ name: "local", status: "skipped", detail: `no local '${defaultBranch}' branch` });
  } else if (localDefault === remoteSha) {
    checks.push({ name: "local", status: "ok", detail: `local ${defaultBranch} matches ${remoteName}` });
  } else if (isAncestor(localDefault, remoteSha)) {
    const behind = countRange(`${localDefault}..${remoteSha}`);
    checks.push({
      name: "local",
      status: "stale",
      detail: `local ${defaultBranch} is ${behind} commit${behind === 1 ? "" : "s"} behind ${remoteName} — anything built or branched from it is out of date`,
      data: { behind },
    });
  } else if (isAncestor(remoteSha, localDefault)) {
    const ahead = countRange(`${remoteSha}..${localDefault}`);
    checks.push({
      name: "local",
      status: "ok",
      detail: `local ${defaultBranch} is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of ${remoteName} (not pushed)`,
      data: { ahead },
    });
  } else {
    checks.push({
      name: "local",
      status: "stale",
      detail: `local ${defaultBranch} has diverged from ${remoteName}`,
    });
  }

  // 3. The branch's pull request.
  checks.push(checkPr(opts, remote, remotes, symbolic, defaultBranch, head));

  // 4. Production.
  if (opts.live) checks.push(await checkLive(opts.live, remote, remoteName, remoteSha));

  return finish();
}

function checkPr(
  opts: FreshOptions,
  remote: string,
  remotes: string[],
  branch: string | null,
  defaultBranch: string,
  head: string
): Check {
  const name = "pr";
  if (opts.noPr) return { name, status: "skipped", detail: "skipped (--no-pr)" };
  if (!branch) return { name, status: "skipped", detail: "detached HEAD — no branch to look up a PR for" };
  if (branch === defaultBranch) return { name, status: "skipped", detail: `on ${defaultBranch} itself — no PR to check` };

  // PRs live on the base remote's repo; the head may come from a fork we push to.
  const slug = githubSlug(tryGit(["config", `remote.${remote}.url`]) ?? "");
  const pushRemote = pushRemoteFor(branch, remote, remotes);
  const pushSlug = githubSlug(tryGit(["config", `remote.${pushRemote}.url`]) ?? "");
  const headOwner = pushSlug ? pushSlug.split("/")[0].toLowerCase() : null;
  // The PR's head branch is the upstream name if this branch tracks one on its push remote.
  const merge = tryGit(["config", `branch.${branch}.merge`]);
  const upstreamRemote = tryGit(["config", `branch.${branch}.remote`]);
  // A branch cut from origin/main often tracks origin/main itself; that is not its PR head.
  const upstreamBranch = merge && upstreamRemote === pushRemote ? merge.replace(/^refs\/heads\//, "") : null;
  const headBranch = upstreamBranch && upstreamBranch !== defaultBranch ? upstreamBranch : branch;

  const args = [
    "pr", "list", "--head", headBranch, "--state", "all", "--limit", "30",
    "--json", "number,state,headRefOid,url,headRepositoryOwner",
  ];
  if (slug) args.push("--repo", slug);

  let out: string;
  try {
    out = execFileSync("gh", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1" },
      timeout: NET_TIMEOUT_MS,
    });
  } catch (err) {
    const e = err as { code?: string; stderr?: Buffer | string };
    if (e.code === "ENOENT") {
      if (!slug) return { name, status: "skipped", detail: `'${remote}' is not a GitHub remote and gh is not installed` };
      return { name, status: "unchecked", detail: "not checked — gh is not installed (install it, or pass --no-pr)" };
    }
    const msg = lastLine(e.stderr?.toString() ?? "") || "gh failed";
    if (!slug && /known GitHub host|not a git repository|no git remotes/i.test(msg)) {
      return { name, status: "skipped", detail: `'${remote}' is not a GitHub remote` };
    }
    return { name, status: "unchecked", detail: `not checked — gh: ${msg} (run gh auth login, or pass --no-pr)` };
  }

  let prs: Array<{ number: number; state: string; headRefOid: string; url: string; headRepositoryOwner?: { login?: string } }>;
  try {
    prs = JSON.parse(out);
    if (!Array.isArray(prs)) throw new Error("not an array");
  } catch {
    return { name, status: "unchecked", detail: "not checked — could not read gh output" };
  }
  // `--head` matches the branch name in ANY fork; keep only PRs from the repo we push to.
  if (headOwner) {
    prs = prs.filter((p) => !p.headRepositoryOwner?.login || p.headRepositoryOwner.login.toLowerCase() === headOwner);
  }
  if (prs.length === 0) return { name, status: "ok", detail: `no PR for '${headBranch}' yet` };

  const pr = prs.find((p) => p.state === "OPEN") ?? prs[0];
  const data = { number: pr.number, state: pr.state, headRefOid: pr.headRefOid, url: pr.url };
  const label = `PR #${pr.number}`;
  if (pr.state === "MERGED") {
    return {
      name, status: "stale", data,
      detail: `${label} is ALREADY MERGED — pushing to '${headBranch}' goes nowhere; start a new branch from ${defaultBranch}`,
    };
  }
  if (pr.state !== "OPEN") {
    return { name, status: "stale", data, detail: `${label} is ${pr.state.toLowerCase()} — pushing will not update an open PR` };
  }
  if (pr.headRefOid === head) {
    return { name, status: "ok", data, detail: `${label} is open and its head matches HEAD (${short(head)})` };
  }
  if (pr.headRefOid && hasCommit(pr.headRefOid) && isAncestor(pr.headRefOid, head)) {
    const ahead = countRange(`${pr.headRefOid}..${head}`);
    return {
      name, status: "ok", data,
      detail: `${label} is open; HEAD is ${ahead} commit${ahead === 1 ? "" : "s"} ahead of it (not pushed yet)`,
    };
  }
  return {
    name, status: "stale", data,
    detail: `${label} is open but its head (${short(pr.headRefOid)}) is not in HEAD (${short(head)}) — the PR has commits you don't, or you rewrote history`,
  };
}

async function checkLive(url: string, remote: string, remoteName: string, remoteSha: string): Promise<Check> {
  const name = "live";
  let body: string;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS), headers: { accept: "application/json, text/plain" } });
    if (!res.ok) return { name, status: "unchecked", detail: `not checked — ${url} returned HTTP ${res.status}` };
    body = await res.text();
  } catch (err) {
    return { name, status: "unchecked", detail: `not checked — could not fetch ${url}: ${(err as Error).message}` };
  }
  const sha = parseLiveSha(body);
  if (!sha) return { name, status: "unchecked", detail: `not checked — no commit SHA in the response from ${url}` };

  let full = tryGit(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
  const data: Record<string, unknown> = { sha: full ?? sha };
  if (!full && sha.length < 40) {
    return {
      name, status: "unchecked", data,
      detail: `not checked — production reports short SHA ${sha}, which is not in ${remoteName} here; serve the full 40-character SHA`,
    };
  }
  if (!full) {
    const res = netGit([...FETCH, remote, sha]);
    full = tryGit(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]);
    if (!full) {
      if (/not our ref|couldn't find remote ref|no such remote ref|unadvertised object/i.test(res.stderr)) {
        return {
          name, status: "stale", data,
          detail: `production runs ${short(sha)}, which ${remote} does not have — deploying would replace work that was never pushed`,
        };
      }
      return { name, status: "unchecked", data, detail: `not checked — could not fetch ${short(sha)} from ${remote}: ${lastLine(res.stderr)}` };
    }
  }
  if (full === remoteSha) {
    return { name, status: "ok", data: { ...data, relation: "equal" }, detail: `production matches ${remoteName} (${short(full)})` };
  }
  if (isAncestor(full, remoteSha)) {
    const behind = countRange(`${full}..${remoteSha}`);
    return {
      name, status: "ok", data: { ...data, relation: "behind", behind },
      detail: `production (${short(full)}) is ${behind} commit${behind === 1 ? "" : "s"} behind ${remoteName}`,
    };
  }
  if (isAncestor(remoteSha, full)) {
    const ahead = countRange(`${remoteSha}..${full}`);
    return {
      name, status: "stale", data: { ...data, relation: "ahead", ahead },
      detail: `production (${short(full)}) is ${ahead} commit${ahead === 1 ? "" : "s"} AHEAD of ${remoteName} — deploying from ${remoteName} would revert it`,
      lines: subjects(`${remoteSha}..${full}`),
    };
  }
  return {
    name, status: "stale", data: { ...data, relation: "diverged" },
    detail: `production (${short(full)}) has diverged from ${remoteName} — deploying would drop its unique commits`,
    lines: subjects(`${remoteSha}..${full}`),
  };
}

const MARK: Record<Status, string> = { ok: "✓", stale: "✗", unchecked: "?", skipped: "-" };

function print(report: Report, opts: FreshOptions): void {
  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  for (const c of report.checks) {
    console.log(`${MARK[c.status]} ${c.name}: ${c.detail}`);
    for (const l of c.lines ?? []) console.log(`    ${l}`);
  }
  const summary =
    report.verdict === "fresh"
      ? "\nFresh."
      : report.verdict === "stale"
        ? "\nSTALE — see ✗ lines above. Nothing was changed."
        : "\nCOULD NOT CHECK — see ? lines above. This is not a pass.";
  console.log(summary);
}
