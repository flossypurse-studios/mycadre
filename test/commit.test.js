import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync, mkdirSync, chmodSync, unlinkSync, renameSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/cli.js");

// `mycadre commit` tests. Each one builds a throwaway repo standing in for a
// checkout several agents share, and plays the other agent with plain git.

function g(args, cwd) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

function setup() {
  const dir = realpathSync(mkdtempSync(path.join(tmpdir(), "mycadre-commit-")));
  const repo = path.join(dir, "repo");
  mkdirSync(repo);
  g(["init", "-q", "-b", "main"], repo);
  g(["config", "user.email", "t@t.co"], repo);
  g(["config", "user.name", "t"], repo);
  g(["config", "commit.gpgsign", "false"], repo);
  // Isolate from the machine's global hooks (e.g. a core.hooksPath set globally).
  g(["config", "core.hooksPath", path.join(repo, ".git", "hooks")], repo);
  mkdirSync(path.join(repo, "src"));
  for (const f of ["a.txt", "b.txt", "src/one.txt", "src/two.txt", "src/old.txt"]) write(repo, f, `${f}\n`);
  write(repo, ".gitignore", "*.log\n");
  g(["add", "."], repo);
  g(["commit", "-q", "-m", "init"], repo);
  return { dir, repo, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function write(repo, file, body) {
  writeFileSync(path.join(repo, file), body);
}

function env() {
  // Scrub anything that would point git at another index or repo.
  const e = { ...process.env };
  for (const k of Object.keys(e)) if (k.startsWith("GIT_")) delete e[k];
  return e;
}

function mc(ctx, args, { cwd = ctx.repo } = {}) {
  const res = spawnSync(process.execPath, [CLI, "commit", ...args], { cwd, encoding: "utf8", env: env() });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr, out: res.stdout + res.stderr };
}

function mcJson(ctx, args, opts) {
  const res = mc(ctx, [...args, "--json"], opts);
  return { ...res, json: JSON.parse(res.stdout) };
}

function mcAsync(ctx, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, "commit", ...args], { cwd: ctx.repo, env: env() });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (status) => resolve({ status, stdout, stderr, out: stdout + stderr }));
  });
}

/** Files changed by a commit, as "S path" lines (renames as "R old -> new"). */
function changed(repo, sha) {
  const out = g(["diff-tree", "-r", "-M", "--no-commit-id", "--name-status", `${sha}^`, sha], repo);
  return out
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const [s, a, b] = l.split("\t");
      return b ? `${s[0]} ${a} -> ${b}` : `${s[0]} ${a}`;
    })
    .sort();
}

/** The shared index and working tree, exactly. */
function snapshot(repo) {
  return {
    head: g(["rev-parse", "HEAD"], repo),
    index: g(["ls-files", "-s"], repo),
    staged: g(["diff", "--cached", "--name-status"], repo),
    status: g(["status", "--porcelain", "--untracked-files=all"], repo),
    branches: g(["for-each-ref", "--format=%(refname) %(objectname)"], repo),
  };
}

function hook(ctx, name, body) {
  const p = path.join(ctx.repo, ".git", "hooks", name);
  writeFileSync(p, `#!/bin/sh\n${body}\n`);
  chmodSync(p, 0o755);
}

test("commit: another agent's staged file stays staged and is not in the commit", () => {
  assert.ok(existsSync(CLI), "run `npm run build` before tests");
  const ctx = setup();
  try {
    // Agent B staged a change and a new file, and has an unstaged edit.
    write(ctx.repo, "b.txt", "b's staged change\n");
    write(ctx.repo, "theirs-new.txt", "b's new file\n");
    g(["add", "b.txt", "theirs-new.txt"], ctx.repo);
    write(ctx.repo, "src/two.txt", "b's unstaged edit\n");
    const stagedBefore = g(["diff", "--cached", "--name-status"], ctx.repo);
    const bBlob = g(["rev-parse", ":b.txt"], ctx.repo);

    // We changed a.txt and added mine.txt (both untracked to the index).
    write(ctx.repo, "a.txt", "our change\n");
    write(ctx.repo, "mine.txt", "our new file\n");
    const before = g(["rev-parse", "HEAD"], ctx.repo);

    const r = mcJson(ctx, ["-m", "ours", "a.txt", "mine.txt"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(r.json.result, "committed");
    assert.equal(r.json.sha, g(["rev-parse", "HEAD"], ctx.repo));
    assert.equal(r.json.parent, before);
    assert.deepEqual(changed(ctx.repo, r.json.sha), ["A mine.txt", "M a.txt"]);
    assert.deepEqual(r.json.files.map((f) => `${f.status} ${f.path}`).sort(), ["A mine.txt", "M a.txt"]);

    // B's staged entries are exactly as they were; ours are no longer staged.
    assert.equal(g(["diff", "--cached", "--name-status"], ctx.repo), stagedBefore);
    assert.equal(g(["rev-parse", ":b.txt"], ctx.repo), bBlob);
    assert.match(g(["status", "--porcelain"], ctx.repo), / M src\/two\.txt/);
    assert.equal(g(["status", "--porcelain", "--", "a.txt", "mine.txt"], ctx.repo), "");

    // Human output names the sha and every file.
    write(ctx.repo, "a.txt", "again\n");
    const h = mc(ctx, ["-m", "again", "a.txt"]);
    assert.equal(h.status, 0, h.out);
    const sha = g(["rev-parse", "HEAD"], ctx.repo);
    assert.match(h.stdout, new RegExp(`^${sha}$`, "m"));
    assert.match(h.stdout, /^ {4}M a\.txt$/m);
  } finally {
    ctx.cleanup();
  }
});

test("commit: a deletion and a rename inside a named directory", () => {
  const ctx = setup();
  try {
    unlinkSync(path.join(ctx.repo, "src/one.txt"));
    renameSync(path.join(ctx.repo, "src/old.txt"), path.join(ctx.repo, "src/new.txt"));
    write(ctx.repo, "a.txt", "not ours to commit\n");

    const dry = mcJson(ctx, ["-m", "tidy", "--dry-run", "src"]);
    assert.equal(dry.status, 0, dry.out);
    assert.equal(dry.json.result, "dry-run");
    assert.equal(dry.json.sha, null);
    const before = snapshot(ctx.repo);

    const r = mcJson(ctx, ["-m", "tidy", "src"]);
    assert.equal(r.status, 0, r.out);
    assert.deepEqual(changed(ctx.repo, r.json.sha), ["D src/one.txt", "R src/old.txt -> src/new.txt"]);
    assert.deepEqual(
      r.json.files.map((f) => (f.from ? `${f.status} ${f.from} -> ${f.path}` : `${f.status} ${f.path}`)).sort(),
      ["D src/one.txt", "R src/old.txt -> src/new.txt"]
    );
    // The dry run promised the same files, and wrote nothing.
    assert.deepEqual(dry.json.files, r.json.files);
    assert.notEqual(before.head, r.json.sha);
    assert.equal(g(["status", "--porcelain", "--untracked-files=all"], ctx.repo), "M a.txt");
  } finally {
    ctx.cleanup();
  }
});

test("commit: a dry run writes nothing", () => {
  const ctx = setup();
  try {
    write(ctx.repo, "a.txt", "x\n");
    write(ctx.repo, "fresh.txt", "x\n");
    g(["add", "b.txt"], ctx.repo);
    const before = snapshot(ctx.repo);
    const r = mc(ctx, ["-m", "x", "--dry-run", "a.txt", "fresh.txt"]);
    assert.equal(r.status, 0, r.out);
    assert.match(r.stdout, /would commit 2 files/);
    assert.match(r.stdout, /A fresh\.txt/);
    assert.deepEqual(snapshot(ctx.repo), before);
  } finally {
    ctx.cleanup();
  }
});

test("commit: refusals exit 1 and write nothing", () => {
  const ctx = setup();
  try {
    write(ctx.repo, "a.txt", "changed\n");
    write(ctx.repo, "debug.log", "ignored\n");
    g(["add", "src/two.txt"], ctx.repo); // someone else's (empty) stage, for the snapshot
    write(ctx.repo, "b.txt", "staged by someone\n");
    g(["add", "b.txt"], ctx.repo);
    const before = snapshot(ctx.repo);
    const outside = path.join(ctx.dir, "elsewhere.txt");
    writeFileSync(outside, "x\n");

    const cases = [
      [["-m", "x", "a.txt", "src/one.txt"], /'src\/one\.txt' has no change against HEAD/],
      [["-m", "x", "a.txt", "nope.txt"], /'nope\.txt' matches nothing/],
      [["-m", "x", "a.txt", outside], /outside the repository/],
      [["-m", "x", "../elsewhere.txt"], /outside the repository/],
      [["-m", "x", "."], /whole repository/],
      [["-m", "x", "debug.log"], /ignored/],
      [["-m", "x", ".git/config"], /inside \.git/],
      [["-m", "x"], /name the paths/],
      [["a.txt"], /commit message is required/],
      [["-m"], /needs a value/],
      [["-m", "x", "--lock-timeout", "soon", "a.txt"], /--lock-timeout must be/],
      [["-m", "x", "--all", "a.txt"], /unknown option: --all/],
    ];
    for (const [args, re] of cases) {
      const r = mc(ctx, args);
      assert.equal(r.status, 1, `${args.join(" ")}: ${r.out}`);
      assert.match(r.out, re, args.join(" "));
      assert.deepEqual(snapshot(ctx.repo), before, `${args.join(" ")} changed something`);
    }
    // A JSON refusal says so, with no sha.
    const j = mcJson(ctx, ["-m", "x", "nope.txt"]);
    assert.equal(j.status, 1);
    assert.equal(j.json.result, "refused");
    assert.equal(j.json.sha, null);

    // Outside any repo.
    const r = mc(ctx, ["-m", "x", "elsewhere.txt"], { cwd: ctx.dir });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /not inside a git working tree/);
  } finally {
    ctx.cleanup();
  }
});

test("commit: paths are taken literally and relative to the current directory", () => {
  const ctx = setup();
  try {
    write(ctx.repo, "src/*.txt", "a file literally named with a star\n");
    write(ctx.repo, "src/one.txt", "changed but not named\n");
    write(ctx.repo, "--weird.txt", "dash file\n");
    // --json goes before "--": everything after it is a path.
    const res = mc(ctx, ["--json", "-m", "--looks-like-a-flag", "*.txt", "--", "../--weird.txt"], { cwd: path.join(ctx.repo, "src") });
    assert.equal(res.status, 0, res.out);
    const r = { json: JSON.parse(res.stdout) };
    assert.deepEqual(changed(ctx.repo, r.json.sha), ["A --weird.txt", "A src/*.txt"]);
    assert.equal(g(["log", "-1", "--format=%s"], ctx.repo), "--looks-like-a-flag");
  } finally {
    ctx.cleanup();
  }
});

test("commit: an index.lock released mid-retry succeeds, and the lock is never deleted by us", async () => {
  const ctx = setup();
  try {
    write(ctx.repo, "a.txt", "ours\n");
    write(ctx.repo, "mine.txt", "new\n"); // also exercises the intent-to-add step under a lock
    const lock = path.join(ctx.repo, ".git", "index.lock");
    writeFileSync(lock, "");
    const pending = mcAsync(ctx, ["-m", "waited", "--json", "a.txt", "mine.txt"]);
    await new Promise((r) => setTimeout(r, 1500));
    assert.ok(existsSync(lock), "mycadre removed a lock it did not own");
    unlinkSync(lock);
    const r = await pending;
    assert.equal(r.status, 0, r.out);
    const json = JSON.parse(r.stdout);
    assert.equal(json.result, "committed");
    assert.ok(json.attempts > 1, `expected retries, got ${json.attempts}`);
    assert.ok(json.waitedMs >= 1000, `waited only ${json.waitedMs}ms`);
    assert.deepEqual(changed(ctx.repo, json.sha), ["A mine.txt", "M a.txt"]);
  } finally {
    ctx.cleanup();
  }
});

test("commit: an index.lock that is never released exits 2, names the lock, and leaves it", () => {
  const ctx = setup();
  try {
    write(ctx.repo, "a.txt", "ours\n");
    write(ctx.repo, "mine.txt", "new\n");
    const lock = path.join(ctx.repo, ".git", "index.lock");
    writeFileSync(lock, "");
    const before = snapshot(ctx.repo);
    const t0 = Date.now();
    const r = mcJson(ctx, ["-m", "x", "--lock-timeout", "1", "a.txt", "mine.txt"]);
    const elapsed = Date.now() - t0;
    assert.equal(r.status, 2, r.out);
    assert.equal(r.json.result, "locked");
    assert.equal(r.json.lock, lock);
    assert.ok(elapsed >= 1000 && elapsed < 10_000, `took ${elapsed}ms`);
    assert.ok(existsSync(lock));
    unlinkSync(lock);
    assert.deepEqual(snapshot(ctx.repo), before);

    // Human output names it too.
    writeFileSync(lock, "");
    const h = mc(ctx, ["-m", "x", "--lock-timeout", "0", "a.txt"]);
    assert.equal(h.status, 2, h.out);
    assert.ok(h.stderr.includes(lock), h.stderr);
    assert.match(h.stderr, /never deletes a lock/);
  } finally {
    ctx.cleanup();
  }
});

test("commit: HEAD advancing concurrently — the commit builds on the new HEAD and keeps its change", () => {
  const ctx = setup();
  try {
    // Another agent commits other.txt while our pre-commit hook runs (plumbing,
    // so it never needs the index lock git commit is holding). Once only.
    hook(
      ctx,
      "pre-commit",
      `if [ ! -f .other-done ]; then
  touch .other-done
  unset GIT_INDEX_FILE
  blob=$(echo other | git hash-object -w --stdin)
  tree=$( (git ls-tree HEAD; printf '100644 blob %s\\tother.txt\\n' "$blob") | git mktree)
  c=$(git commit-tree "$tree" -p HEAD -m other)
  git update-ref HEAD "$c"
fi`
    );
    write(ctx.repo, ".gitignore", "*.log\n.other-done\n");
    g(["commit", "-q", "-m", "ignore marker", "--no-verify", ".gitignore"], ctx.repo);
    write(ctx.repo, "a.txt", "ours\n");
    const start = g(["rev-parse", "HEAD"], ctx.repo);

    const r = mcJson(ctx, ["-m", "ours", "a.txt"]);
    assert.equal(r.status, 0, r.out);
    const other = g(["rev-parse", `${r.json.sha}^`], ctx.repo);
    assert.notEqual(other, start, "the other commit should have landed first");
    assert.equal(g(["log", "-1", "--format=%s", other], ctx.repo), "other");
    assert.equal(r.json.parent, other);
    // git refused to move HEAD off the parent it built on; mycadre rebuilt and retried.
    assert.equal(r.json.attempts, 2);
    assert.deepEqual(changed(ctx.repo, r.json.sha), ["M a.txt"]);
    // Their file is still in the tree: nothing was reverted.
    assert.equal(g(["show", `${r.json.sha}:other.txt`], ctx.repo), "other");
    assert.equal(g(["rev-parse", "HEAD"], ctx.repo), r.json.sha);
  } finally {
    ctx.cleanup();
  }
});

test("commit: a failing pre-commit hook leaves the index, HEAD and working tree as they were", () => {
  const ctx = setup();
  try {
    write(ctx.repo, "b.txt", "someone's stage\n");
    g(["add", "b.txt"], ctx.repo);
    write(ctx.repo, "a.txt", "ours\n");
    write(ctx.repo, "mine.txt", "new, so it gets marked intent-to-add first\n");
    hook(ctx, "pre-commit", `echo "secret scanner: found a key" >&2\nexit 1`);
    const before = snapshot(ctx.repo);

    const r = mcJson(ctx, ["-m", "nope", "a.txt", "mine.txt"]);
    assert.equal(r.status, 1, r.out);
    assert.equal(r.json.result, "failed");
    assert.equal(r.json.sha, null);
    assert.match(r.stderr, /secret scanner: found a key/);
    assert.deepEqual(snapshot(ctx.repo), before);
  } finally {
    ctx.cleanup();
  }
});

test("commit: hooks run (never --no-verify) and see only our paths staged", () => {
  const ctx = setup();
  try {
    const seen = path.join(ctx.dir, "seen.txt");
    hook(ctx, "pre-commit", `git diff --cached --name-only > "${seen}"`);
    hook(ctx, "commit-msg", `echo "msg-hook-ran" >> "$1"`);
    write(ctx.repo, "b.txt", "someone's stage\n");
    g(["add", "b.txt"], ctx.repo);
    write(ctx.repo, "a.txt", "ours\n");
    const r = mcJson(ctx, ["-m", "ours", "a.txt"]);
    assert.equal(r.status, 0, r.out);
    assert.equal(execFileSync("cat", [seen], { encoding: "utf8" }).trim(), "a.txt");
    assert.match(g(["log", "-1", "--format=%B"], ctx.repo), /msg-hook-ran/);
  } finally {
    ctx.cleanup();
  }
});

test("commit --help prints usage and exits 0", () => {
  const ctx = setup();
  try {
    const r = mc(ctx, ["--help"]);
    assert.equal(r.status, 0);
    assert.match(r.stdout, /Usage: mycadre commit -m <message>/);
  } finally {
    ctx.cleanup();
  }
});
