import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(__dirname, "../dist/cli.js");

function sh(args, cwd) {
  return execFileSync("node", [CLI, ...args], { cwd, encoding: "utf8" });
}

function git(args, cwd) {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

test("create/list/remove worktree end to end", () => {
  assert.ok(existsSync(CLI), "run `npm run build` before tests");
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-test-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);
    assert.ok(existsSync(path.join(repo, "mycadre.json")), "config written");

    sh(["create", "feature/x"], repo);
    const wt = path.join(worktrees, "feature-x");
    assert.ok(existsSync(wt), "worktree created");
    assert.equal(readFileSync(path.join(wt, ".env"), "utf8"), "SECRET=1\n", ".env copied");

    const list = sh(["list"], repo);
    assert.match(list, /feature\/x/);
    assert.match(list, /\bok\b/);

    sh(["remove", "feature/x", "--force"], repo);
    assert.doesNotMatch(sh(["list"], repo), /feature\/x/);
    assert.ok(!existsSync(wt), "worktree removed");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("clean untracks a stale worktree entry", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-clean-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);
    sh(["create", "feature/stale"], repo);
    const wt = path.join(worktrees, "feature-stale");
    assert.ok(existsSync(wt), "worktree created");

    // Simulate a stale entry: remove the worktree dir out from under git.
    rmSync(wt, { recursive: true, force: true });
    assert.match(sh(["list"], repo), /MISSING/, "list flags the stale entry");

    const out = sh(["clean"], repo);
    assert.match(out, /Untracking stale entry: feature\/stale/, "reports the untracked branch");
    assert.match(out, /Cleaned 1 stale entry\b/, "summarizes one cleaned entry");
    assert.doesNotMatch(sh(["list"], repo), /feature\/stale/, "entry no longer listed");
    assert.match(sh(["clean"], repo), /Nothing to clean\./, "second clean is a no-op");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create --from bases the new branch on the given branch", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-from-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    // Create a base branch with a unique file, then return to the default branch.
    const base = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
      cwd: repo,
      encoding: "utf8",
    }).trim();
    git(["checkout", "-b", "release"], repo);
    writeFileSync(path.join(repo, "RELEASE.txt"), "v1\n");
    git(["add", "RELEASE.txt"], repo);
    git(["commit", "-m", "release marker"], repo);
    git(["checkout", base], repo);

    sh(["init"], repo);
    const out = sh(["create", "hotfix/y", "--from", "release"], repo);
    assert.match(out, /from 'release'/, "reports the requested base branch");
    const wt = path.join(worktrees, "hotfix-y");
    assert.ok(existsSync(path.join(wt, "RELEASE.txt")), "branch inherits base branch commit");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("--version prints the package version", () => {
  const out = sh(["--version"]);
  assert.match(out, /0\.1\.0/, "--version outputs version");
  assert.equal(sh(["-v"]).trim(), sh(["version"]).trim(), "-v and version match");
});

test("no arguments prints help", () => {
  const out = sh([]);
  assert.match(out, /Usage:/, "prints usage section");
  assert.match(out, /mycadre init/, "lists the init command");
});

test("git-requiring command outside a repo errors clearly and exits 1", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "mycadre-nogit-"));
  let err;
  try {
    execFileSync("node", [CLI, "list"], { cwd: outside, encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    err = e;
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
  assert.ok(err, "should exit non-zero outside a git repo");
  assert.equal(err.status, 1, "exit code is 1");
  assert.match(err.stderr ?? "", /Not inside a git repository/, "clear error message");
});

test("unknown command exits 1 and suggests --help", () => {
  let err;
  try {
    execFileSync("node", [CLI, "bogus"], { encoding: "utf8", stdio: "pipe" });
  } catch (e) {
    err = e;
  }
  assert.ok(err, "unknown command should exit non-zero");
  assert.equal(err.status, 1, "exit code is 1");
  const stderr = err.stderr ?? "";
  assert.match(stderr, /Unknown command: bogus/, "reports the bad command");
  assert.match(stderr, /mycadre --help/, "suggests running --help");
});

test("create without a branch arg errors with usage info and exits 1", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-create-noarg-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);
    sh(["init"], repo);

    let err;
    try {
      execFileSync("node", [CLI, "create"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "create without branch should exit non-zero");
    assert.equal(err.status, 1, "exit code is 1");
    const stderr = err.stderr ?? "";
    assert.match(stderr, /Usage: mycadre create/, "shows usage for create command");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("remove of an untracked branch warns clearly and exits 0", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-rm-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);
    sh(["init"], repo);

    const res = spawnSync("node", [CLI, "remove", "does/not-exist"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, "removing an untracked branch is not fatal");
    assert.match(res.stderr, /No tracked worktree for branch 'does\/not-exist'/, "warns clearly");
    assert.match(res.stdout, /Removed 'does\/not-exist'/, "still confirms completion");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("remove without a branch arg errors with usage info and exits 1", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-remove-noarg-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);
    sh(["init"], repo);

    let err;
    try {
      execFileSync("node", [CLI, "remove"], { cwd: repo, encoding: "utf8", stdio: "pipe" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "remove without branch should exit non-zero");
    assert.equal(err.status, 1, "exit code is 1");
    const stderr = err.stderr ?? "";
    assert.match(stderr, /Usage: mycadre remove/, "shows usage for remove command");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("init writes mycadre.json with expected defaults", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-init-defaults-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);
    const configPath = path.join(repo, "mycadre.json");
    assert.ok(existsSync(configPath), "mycadre.json file created");

    const config = JSON.parse(readFileSync(configPath, "utf8"));
    assert.equal(config.worktreeDir, "../mycadre-worktrees", "worktreeDir default is correct");
    assert.deepEqual(config.copy, [".env", ".env.local"], "copy default is correct");
    assert.equal(config.setup, null, "setup default is null");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
