import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, symlinkSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/cli.js");

// `mycadre fresh` tests. Every remote is a local bare repo, so nothing here
// touches the network. PATH is controlled per test so the PR check sees either
// no `gh` at all or a fake one that prints canned JSON.

const GIT_BIN = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim();
const GH_URL = "https://github.com/acme/widget.git";

function g(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function configure(repo) {
  g(["config", "user.email", "t@t.co"], repo);
  g(["config", "user.name", "t"], repo);
  g(["config", "commit.gpgsign", "false"], repo);
}

function commit(repo, file, msg) {
  writeFileSync(path.join(repo, file), `${msg}\n`);
  g(["add", file], repo);
  g(["commit", "-q", "-m", msg], repo);
  return g(["rev-parse", "HEAD"], repo);
}

/**
 * A scratch dir holding: remote.git (bare, default branch main), work (a clone
 * with one pushed commit), and bin/ (node + git only; add a fake gh with fakeGh).
 */
function setup({ githubUrl = false } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "mycadre-fresh-"));
  const remote = path.join(dir, "remote.git");
  const work = path.join(dir, "work");
  const bin = path.join(dir, "bin");
  mkdirSync(bin);
  symlinkSync(process.execPath, path.join(bin, "node"));
  symlinkSync(GIT_BIN, path.join(bin, "git"));

  g(["init", "-q", "--bare", remote]);
  g(["symbolic-ref", "HEAD", "refs/heads/main"], remote);
  mkdirSync(work);
  g(["init", "-q"], work);
  g(["checkout", "-q", "-b", "main"], work);
  configure(work);
  commit(work, "a.txt", "first");
  if (githubUrl) {
    // The remote looks like GitHub, but git is redirected to the local bare repo.
    g(["remote", "add", "origin", GH_URL], work);
    g(["config", `url.${remote}.insteadOf`, GH_URL], work);
  } else {
    g(["remote", "add", "origin", remote], work);
  }
  g(["push", "-q", "-u", "origin", "main"], work);
  return { dir, remote, work, bin, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Push commits to the remote's main from a second clone, so `work` falls behind. */
function advanceRemote(ctx, subjects) {
  const other = path.join(ctx.dir, `other-${Math.floor(Math.random() * 1e9)}`);
  g(["clone", "-q", ctx.remote, other]);
  configure(other);
  for (const s of subjects) commit(other, `${s.replace(/\W/g, "_")}.txt`, s);
  g(["push", "-q", "origin", "main"], other);
  return g(["rev-parse", "HEAD"], other);
}

/** A fake gh that prints $FAKE_GH_OUT (or fails with $FAKE_GH_ERR) and logs its args. */
function fakeGh(ctx) {
  const script = path.join(ctx.bin, "gh");
  writeFileSync(
    script,
    `#!/bin/sh
echo "$@" >> "${path.join(ctx.dir, "gh-args.log")}"
if [ -n "$FAKE_GH_ERR" ]; then echo "$FAKE_GH_ERR" >&2; exit 1; fi
printf '%s' "$FAKE_GH_OUT"
`
  );
  chmodSync(script, 0o755);
}

function fresh(ctx, args = [], { env = {}, cwd = ctx.work } = {}) {
  const res = spawnSync(path.join(ctx.bin, "node"), [CLI, "fresh", ...args], {
    cwd,
    encoding: "utf8",
    env: { HOME: ctx.dir, PATH: ctx.bin, ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr };
}

function freshJson(ctx, args = [], opts) {
  const res = fresh(ctx, [...args, "--json"], opts);
  return { ...res, json: JSON.parse(res.stdout) };
}

function byName(json, name) {
  return json.checks.find((c) => c.name === name);
}

/** Everything fresh must never change: branches, HEAD, index/worktree, stash. */
function snapshot(repo) {
  return {
    heads: g(["for-each-ref", "refs/heads", "refs/tags", "--format=%(refname) %(objectname)"], repo),
    head: g(["rev-parse", "HEAD"], repo),
    symbolic: spawnSync("git", ["symbolic-ref", "-q", "HEAD"], { cwd: repo, encoding: "utf8" }).stdout,
    status: g(["status", "--porcelain"], repo),
    stash: spawnSync("git", ["stash", "list"], { cwd: repo, encoding: "utf8" }).stdout,
  };
}

test("fresh: up to date with the remote exits 0", () => {
  assert.ok(existsSync(CLI), "run `npm run build` before tests");
  const ctx = setup();
  try {
    const r = freshJson(ctx);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.json.verdict, "fresh");
    assert.equal(r.json.defaultBranch, "main");
    assert.equal(byName(r.json, "base").status, "ok");
    assert.equal(byName(r.json, "local").status, "ok");
    // On main itself, and not a GitHub remote: no PR to look up.
    assert.equal(byName(r.json, "pr").status, "skipped");
    assert.match(fresh(ctx).stdout, /\nFresh\.\n/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: behind the remote default branch exits 1, lists missing subjects, changes nothing", () => {
  const ctx = setup();
  try {
    g(["checkout", "-q", "-b", "feature"], ctx.work);
    commit(ctx.work, "f.txt", "my feature");
    writeFileSync(path.join(ctx.work, "dirty.txt"), "uncommitted\n");
    const remoteSha = advanceRemote(ctx, ["their fix one", "their fix two"]);

    const before = snapshot(ctx.work);
    const r = fresh(ctx);
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /✗ base: HEAD is 2 commits behind origin\/main/);
    // The local origin/main ref had not been fetched: it is called out, not trusted.
    assert.match(r.stdout, /local origin\/main ref was \w{7} — out of date/);
    assert.match(r.stdout, /their fix two/);
    assert.match(r.stdout, /their fix one/);
    assert.match(r.stdout, /STALE/);
    assert.deepEqual(snapshot(ctx.work), before, "fresh must not touch branches, HEAD, the tree or the stash");

    const j = freshJson(ctx).json;
    assert.equal(j.verdict, "stale");
    assert.equal(j.remoteSha, remoteSha);
    assert.equal(byName(j, "base").data.behind, 2);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: local default branch behind the remote is stale even when HEAD is current", () => {
  const ctx = setup();
  try {
    advanceRemote(ctx, ["upstream change"]);
    g(["fetch", "-q", "origin"], ctx.work);
    g(["checkout", "-q", "-b", "feature", "origin/main"], ctx.work);
    const j = freshJson(ctx).json;
    assert.equal(byName(j, "base").status, "ok");
    const local = byName(j, "local");
    assert.equal(local.status, "stale");
    assert.equal(local.data.behind, 1);
    assert.equal(j.exitCode, 1);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: local default branch ahead (unpushed) is not stale", () => {
  const ctx = setup();
  try {
    commit(ctx.work, "b.txt", "unpushed");
    const r = freshJson(ctx);
    assert.equal(r.status, 0, r.out);
    assert.match(byName(r.json, "local").detail, /1 commit ahead of origin\/main \(not pushed\)/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: no remote is 'could not check' (exit 2), never fresh", () => {
  const ctx = setup();
  try {
    g(["remote", "remove", "origin"], ctx.work);
    const r = freshJson(ctx);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.json.verdict, "unchecked");
    assert.match(r.json.checks[0].detail, /no remote/);
    assert.match(fresh(ctx).stdout, /COULD NOT CHECK — .* This is not a pass\./);
    assert.doesNotMatch(fresh(ctx).stdout, /Fresh\./);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: an unreachable remote (offline) is exit 2 even though local refs look current", () => {
  const ctx = setup();
  try {
    // origin/main is present locally and equal to HEAD — a ref-only check would call this fresh.
    g(["remote", "set-url", "origin", path.join(ctx.dir, "gone.git")], ctx.work);
    const r = freshJson(ctx);
    assert.equal(r.status, 2, r.out);
    assert.equal(r.json.verdict, "unchecked");
    assert.match(byName(r.json, "base").detail, /could not reach 'origin'/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: an empty remote, a missing --base, or a missing --remote are exit 2", () => {
  const ctx = setup();
  try {
    const empty = path.join(ctx.dir, "empty.git");
    g(["init", "-q", "--bare", empty]);
    g(["remote", "add", "blank", empty], ctx.work);
    assert.equal(fresh(ctx, ["--remote", "blank"]).status, 2);
    assert.equal(fresh(ctx, ["--remote", "nope"]).status, 2);
    const r = freshJson(ctx, ["--base", "does-not-exist"]);
    assert.equal(r.status, 2);
    assert.match(r.json.checks[0].detail, /does not exist on 'origin'/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: outside a git repo, usage errors, and --live with no value are exit 2", () => {
  const ctx = setup();
  try {
    const outside = path.join(ctx.dir, "plain");
    mkdirSync(outside);
    const r = fresh(ctx, ["--json"], { cwd: outside, env: { GIT_CEILING_DIRECTORIES: ctx.dir } });
    assert.equal(r.status, 2, r.out);
    assert.equal(JSON.parse(r.stdout).verdict, "unchecked");
    assert.equal(fresh(ctx, ["--bogus"]).status, 2);
    assert.equal(fresh(ctx, ["--live"]).status, 2);
    const help = fresh(ctx, ["--help"]);
    assert.equal(help.status, 0);
    assert.match(help.stdout, /Exit codes: 0 fresh, 1 stale, 2 could not check/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: detached HEAD still checks the base and skips the PR lookup", () => {
  const ctx = setup({ githubUrl: true });
  try {
    g(["checkout", "-q", "--detach", "HEAD"], ctx.work);
    let j = freshJson(ctx).json; // no gh on PATH — must not matter when detached
    assert.equal(j.branch, null);
    assert.equal(byName(j, "base").status, "ok");
    assert.match(byName(j, "pr").detail, /detached HEAD/);
    assert.equal(j.exitCode, 0);

    advanceRemote(ctx, ["moved on"]);
    j = freshJson(ctx).json;
    assert.equal(byName(j, "base").status, "stale");
    assert.equal(j.exitCode, 1);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: no gh on a GitHub remote is 'could not check' unless --no-pr", () => {
  const ctx = setup({ githubUrl: true });
  try {
    g(["checkout", "-q", "-b", "feature"], ctx.work);
    let r = freshJson(ctx);
    assert.equal(r.status, 2, r.out);
    assert.equal(byName(r.json, "pr").status, "unchecked");
    assert.match(byName(r.json, "pr").detail, /gh is not installed/);
    assert.doesNotMatch(fresh(ctx).stdout, /✓ pr/);

    r = freshJson(ctx, ["--no-pr"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(byName(r.json, "pr").status, "skipped");
  } finally {
    ctx.cleanup();
  }
});

test("fresh: no gh on a non-GitHub remote skips the PR check", () => {
  const ctx = setup();
  try {
    g(["checkout", "-q", "-b", "feature"], ctx.work);
    const r = freshJson(ctx);
    assert.equal(r.status, 0, r.out);
    assert.match(byName(r.json, "pr").detail, /not a GitHub remote/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: PR states via gh — merged, closed, open at HEAD, open behind HEAD, open diverged, gh unauthenticated", () => {
  const ctx = setup({ githubUrl: true });
  try {
    fakeGh(ctx);
    g(["checkout", "-q", "-b", "feature"], ctx.work);
    const pushed = commit(ctx.work, "f.txt", "feature work");
    g(["push", "-q", "-u", "origin", "feature"], ctx.work);
    const pr = (state, headRefOid) =>
      JSON.stringify([{ number: 7, state, headRefOid, url: "https://github.com/acme/widget/pull/7" }]);

    let r = freshJson(ctx, [], { env: { FAKE_GH_OUT: pr("MERGED", pushed) } });
    assert.equal(r.status, 1, r.out);
    assert.match(byName(r.json, "pr").detail, /PR #7 is ALREADY MERGED — pushing to 'feature' goes nowhere/);
    const args = readFileSync(path.join(ctx.dir, "gh-args.log"), "utf8");
    assert.match(args, /pr list --head feature --state all/);
    assert.match(args, /--repo acme\/widget/);

    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: pr("CLOSED", pushed) } });
    assert.equal(r.status, 1);
    assert.match(byName(r.json, "pr").detail, /closed/);

    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: pr("OPEN", pushed) } });
    assert.equal(r.status, 0, r.out);
    assert.match(byName(r.json, "pr").detail, /open and its head matches HEAD/);

    // An open PR wins over an older merged one for the same branch.
    const both = JSON.stringify([
      { number: 3, state: "MERGED", headRefOid: "0".repeat(40), url: "u" },
      { number: 9, state: "OPEN", headRefOid: pushed, url: "u" },
    ]);
    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: both } });
    assert.equal(byName(r.json, "pr").data.number, 9);

    commit(ctx.work, "g.txt", "not pushed yet");
    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: pr("OPEN", pushed) } });
    assert.equal(r.status, 0, r.out);
    assert.match(byName(r.json, "pr").detail, /HEAD is 1 commit ahead of it \(not pushed yet\)/);

    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: pr("OPEN", "f".repeat(40)) } });
    assert.equal(r.status, 1);
    assert.match(byName(r.json, "pr").detail, /not in HEAD/);

    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: "[]" } });
    assert.equal(r.status, 0);
    assert.match(byName(r.json, "pr").detail, /no PR for 'feature' yet/);

    r = freshJson(ctx, [], { env: { FAKE_GH_ERR: "To get started with GitHub CLI, please run:  gh auth login" } });
    assert.equal(r.status, 2, r.out);
    assert.equal(byName(r.json, "pr").status, "unchecked");
    assert.match(byName(r.json, "pr").detail, /gh auth login/);

    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: "not json" } });
    assert.equal(r.status, 2);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: stale wins over could-not-check", () => {
  const ctx = setup({ githubUrl: true });
  try {
    g(["checkout", "-q", "-b", "feature"], ctx.work);
    advanceRemote(ctx, ["ahead of you"]);
    const j = freshJson(ctx).json; // pr unchecked (no gh), base stale
    assert.equal(byName(j, "pr").status, "unchecked");
    assert.equal(j.verdict, "stale");
    assert.equal(j.exitCode, 1);
  } finally {
    ctx.cleanup();
  }
});

test("fresh --live: equal, behind, ahead, unknown, JSON fields, and unreadable responses", () => {
  const ctx = setup();
  try {
    const old = g(["rev-parse", "HEAD"], ctx.work);
    commit(ctx.work, "b.txt", "second");
    g(["push", "-q", "origin", "main"], ctx.work);
    const main = g(["rev-parse", "HEAD"], ctx.work);
    const live = (body, type = "text/plain") => ["--live", `data:${type},${encodeURIComponent(body)}`];

    let r = freshJson(ctx, live(`${main}\n`));
    assert.equal(r.status, 0, r.out);
    assert.equal(byName(r.json, "live").data.relation, "equal");

    r = freshJson(ctx, live(JSON.stringify({ commit: old.slice(0, 12) }), "application/json"));
    assert.equal(r.status, 0, r.out);
    assert.equal(byName(r.json, "live").data.relation, "behind");

    r = freshJson(ctx, live(JSON.stringify({ git_sha: main }), "application/json"));
    assert.equal(byName(r.json, "live").data.relation, "equal");

    // Production runs a commit that exists here but was never pushed.
    g(["checkout", "-q", "-b", "hotfix"], ctx.work);
    const hot = commit(ctx.work, "h.txt", "deployed from a laptop");
    g(["checkout", "-q", "main"], ctx.work);
    r = fresh(ctx, live(JSON.stringify({ sha: hot }), "application/json"));
    assert.equal(r.status, 1, r.out);
    assert.match(r.stdout, /production \(\w{7}\) is 1 commit AHEAD of origin\/main — deploying from origin\/main would revert it/);
    assert.match(r.stdout, /deployed from a laptop/);

    r = freshJson(ctx, live("e".repeat(40)));
    assert.equal(r.status, 1);
    assert.match(byName(r.json, "live").detail, /does not have/);

    r = freshJson(ctx, live("<html>hello</html>", "text/html"));
    assert.equal(r.status, 2);
    assert.equal(byName(r.json, "live").status, "unchecked");

    r = freshJson(ctx, ["--live", "http://127.0.0.1:9/version"]);
    assert.equal(r.status, 2, r.out);
    assert.match(byName(r.json, "live").detail, /could not fetch/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: a branch tracking a fork is still compared against origin's default branch", () => {
  const ctx = setup();
  try {
    const fork = path.join(ctx.dir, "fork.git");
    g(["clone", "-q", "--bare", ctx.remote, fork]);
    g(["remote", "add", "fork", fork], ctx.work);
    g(["checkout", "-q", "-b", "feat"], ctx.work);
    commit(ctx.work, "f.txt", "feature");
    g(["push", "-q", "-u", "fork", "feat"], ctx.work);
    advanceRemote(ctx, ["landed on origin"]); // the fork's main stays behind
    const r = freshJson(ctx);
    assert.equal(r.json.remote, "origin");
    assert.equal(byName(r.json, "base").status, "stale", r.out);
    assert.equal(r.status, 1);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: PRs are looked up on the base repo and filtered to the repo we push to", () => {
  const ctx = setup({ githubUrl: true });
  try {
    fakeGh(ctx);
    // Push to a fork (me/widget); the PR lives on acme/widget.
    const forkUrl = "https://github.com/me/widget.git";
    const fork = path.join(ctx.dir, "fork.git");
    g(["clone", "-q", "--bare", ctx.remote, fork]);
    g(["remote", "add", "fork", forkUrl], ctx.work);
    g(["config", `url.${fork}.insteadOf`, forkUrl], ctx.work);
    g(["checkout", "-q", "-b", "patch-1"], ctx.work);
    const pushed = commit(ctx.work, "p.txt", "patch");
    g(["push", "-q", "-u", "fork", "patch-1"], ctx.work);

    const prs = JSON.stringify([
      { number: 4, state: "MERGED", headRefOid: "1".repeat(40), url: "u", headRepositoryOwner: { login: "stranger" } },
      { number: 8, state: "OPEN", headRefOid: pushed, url: "u", headRepositoryOwner: { login: "Me" } },
    ]);
    let r = freshJson(ctx, [], { env: { FAKE_GH_OUT: prs } });
    assert.equal(r.status, 0, r.out);
    assert.equal(byName(r.json, "pr").data.number, 8);
    assert.match(readFileSync(path.join(ctx.dir, "gh-args.log"), "utf8"), /--head patch-1 .*--repo acme\/widget/);

    // Only a stranger's same-named PR exists: that is not ours.
    const stranger = JSON.stringify([
      { number: 4, state: "MERGED", headRefOid: "1".repeat(40), url: "u", headRepositoryOwner: { login: "stranger" } },
    ]);
    r = freshJson(ctx, [], { env: { FAKE_GH_OUT: stranger } });
    assert.equal(r.status, 0, r.out);
    assert.match(byName(r.json, "pr").detail, /no PR for 'patch-1' yet/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh --live: a short SHA we can't resolve is 'could not check', not a claim about production", () => {
  const ctx = setup();
  try {
    const r = freshJson(ctx, ["--live", "data:text/plain,1234567"]);
    assert.equal(r.status, 2, r.out);
    assert.match(byName(r.json, "live").detail, /short SHA 1234567/);
  } finally {
    ctx.cleanup();
  }
});

test("fresh: parseLiveSha and githubSlug edge cases", async () => {
  const { parseLiveSha, githubSlug } = await import(pathToFileURL(path.resolve(__dirname, "../dist/commands/fresh.js")).href);
  assert.equal(parseLiveSha("1234567"), "1234567", "all-digit short SHA parses as JSON number");
  assert.equal(parseLiveSha("1234e56\n"), "1234e56", "exponent-looking SHA");
  assert.equal(parseLiveSha('"ABCDEF0"'), "abcdef0");
  assert.equal(parseLiveSha('{"sha":"abcdef0123"}'), "abcdef0123");
  assert.equal(parseLiveSha('{"version":"1.2.3"}'), null);
  assert.equal(parseLiveSha("deadbeef built 2026-01-01"), "deadbeef");
  assert.equal(parseLiveSha("hello"), null);
  assert.equal(parseLiveSha(""), null);
  assert.equal(githubSlug("git@github.com:acme/widget.git"), "acme/widget");
  assert.equal(githubSlug("https://github.com/acme/widget"), "acme/widget");
  assert.equal(githubSlug("ssh://git@github.com:22/acme/widget.git"), "acme/widget");
  assert.equal(githubSlug("https://gitlab.com/acme/widget.git"), null);
});
