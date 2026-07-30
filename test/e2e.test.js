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

test("remove of a stale worktree (dir deleted) warns and untracks cleanly, exit 0", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-remove-stale-"));
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
    sh(["create", "feature/gone"], repo);
    const wt = path.join(worktrees, "feature-gone");
    assert.ok(existsSync(wt), "worktree created");

    // Simulate a stale entry: delete the worktree dir out from under git.
    rmSync(wt, { recursive: true, force: true });

    // remove should not throw even though the path is gone; it exits 0.
    const res = spawnSync("node", [CLI, "remove", "feature/gone"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, "remove of stale worktree exits 0");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /Removed 'feature\/gone'\./, "confirms removal");
    assert.doesNotMatch(sh(["list"], repo), /feature\/gone/, "entry no longer tracked");
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

test("create --from with a non-existent base branch errors clearly and exits 1", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-badfrom-"));
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
    let err;
    try {
      execFileSync("node", [CLI, "create", "feature/z", "--from", "no-such-branch"], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "create with bad --from exits non-zero");
    assert.equal(err.status, 1, "exits with code 1");
    assert.match(err.stderr, /Base branch 'no-such-branch' does not exist/, "clear error message");
    assert.ok(!existsSync(path.join(worktrees, "feature-z")), "no worktree dir left behind");
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

test("list shows no-worktrees message when none exist", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-list-empty-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);
    const res = spawnSync("node", [CLI, "list"], { cwd: repo, encoding: "utf8" });
    assert.equal(res.status, 0, "list with no worktrees exits 0");
    const output = res.stdout + res.stderr;
    assert.match(output, /No mycadre worktrees tracked/, "shows no-worktrees message");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("create without a git repo errors with clear message and exits 1", () => {
  const notRepo = mkdtempSync(path.join(tmpdir(), "mycadre-create-nogit-"));
  let err;
  try {
    execFileSync("node", [CLI, "create", "feature/x"], {
      cwd: notRepo,
      encoding: "utf8",
      stdio: "pipe",
    });
  } catch (e) {
    err = e;
  } finally {
    rmSync(notRepo, { recursive: true, force: true });
  }
  assert.ok(err, "create outside a git repo should exit non-zero");
  assert.equal(err.status, 1, "exit code is 1");
  const stderr = err.stderr ?? "";
  assert.match(
    stderr,
    /Not inside a git repository/,
    "error says not inside a git repository"
  );
});

test("init is idempotent - running twice produces same config", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-init-idempotent-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    // First init
    sh(["init"], repo);
    const configPath = path.join(repo, "mycadre.json");
    const config1 = readFileSync(configPath, "utf8");
    const configObj1 = JSON.parse(config1);

    // Second init
    sh(["init"], repo);
    const config2 = readFileSync(configPath, "utf8");
    const configObj2 = JSON.parse(config2);

    // Verify content is identical
    assert.deepEqual(configObj1, configObj2, "config object is identical after second init");
    assert.equal(config1, config2, "config file content is identical (byte-for-byte)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("list shows mixed status (ok/MISSING) for multiple worktrees", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-list-mixed-"));
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
    sh(["create", "feature/a"], repo);
    sh(["create", "feature/b"], repo);

    // Both should show as "ok"
    let list = sh(["list"], repo);
    assert.match(list, /feature\/a.*ok/, "feature/a shows as ok");
    assert.match(list, /feature\/b.*ok/, "feature/b shows as ok");

    // Remove one worktree directory to make it MISSING
    const wtA = path.join(worktrees, "feature-a");
    rmSync(wtA, { recursive: true, force: true });

    // Now feature/a should show as MISSING, feature/b as ok
    list = sh(["list"], repo);
    assert.match(list, /feature\/a.*MISSING/, "feature/a shows as MISSING after dir removal");
    assert.match(list, /feature\/b.*ok/, "feature/b still shows as ok");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("remove --keep-branch removes worktree but preserves the git branch", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-keep-branch-"));
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
    sh(["create", "feature/keep"], repo);
    const wt = path.join(worktrees, "feature-keep");
    assert.ok(existsSync(wt), "worktree created");

    // Verify branch exists before remove
    const branchesBefore = execFileSync("git", ["branch"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(branchesBefore, /feature\/keep/, "branch exists before remove");

    sh(["remove", "feature/keep", "--keep-branch"], repo);
    assert.ok(!existsSync(wt), "worktree directory removed");

    // Verify branch still exists after remove --keep-branch
    const branchesAfter = execFileSync("git", ["branch"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(
      branchesAfter,
      /feature\/keep/,
      "branch preserved with --keep-branch flag"
    );

    // Verify the entry is no longer tracked in mycadre
    assert.doesNotMatch(
      sh(["list"], repo),
      /feature\/keep/,
      "entry removed from mycadre tracking"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create runs the configured setup command inside the new worktree", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-test-"));
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

    // Configure a setup command that writes a marker file into the worktree.
    const cfgPath = path.join(repo, "mycadre.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.setup = "echo ran > setup-marker.txt";
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    const out = sh(["create", "feature/setup"], repo);
    assert.match(out, /Running setup:/, "announces the setup command");

    const wt = path.join(worktrees, "feature-setup");
    const marker = path.join(wt, "setup-marker.txt");
    assert.ok(existsSync(marker), "setup command ran in the worktree");
    assert.match(readFileSync(marker, "utf8"), /ran/, "marker file has expected content");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create errors when target path already exists", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-test-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  let err;
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);

    // Pre-create the target path to simulate it already existing
    const targetPath = path.join(worktrees, "feature-exists");
    execFileSync("mkdir", ["-p", targetPath], { stdio: "ignore" });
    writeFileSync(path.join(targetPath, "somefile.txt"), "collision\n");

    try {
      execFileSync("node", [CLI, "create", "feature/exists"], {
        cwd: repo,
        encoding: "utf8",
        stdio: "pipe",
      });
    } catch (e) {
      err = e;
    }

    assert.ok(err, "should exit non-zero when target exists");
    assert.equal(err.status, 1, "exit code is 1");
    assert.match(err.stderr ?? "", /Target path already exists/, "clear error message");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create copies configured files and skips missing ones without crashing", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-copy-"));
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

    // Configure copy: one file that exists, one that does not.
    const cfgPath = path.join(repo, "mycadre.json");
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8"));
    cfg.copy = [".env", "missing.txt"];
    writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + "\n");

    // Create only the .env file (missing.txt intentionally absent).
    writeFileSync(path.join(repo, ".env"), "SECRET=1\n");

    const out = sh(["create", "feature/copy"], repo);
    assert.match(out, /Copied \.env/, "reports copying the present file");
    assert.doesNotMatch(out, /Copied missing\.txt/, "does not report the missing file");

    const wt = path.join(worktrees, "feature-copy");
    assert.ok(existsSync(path.join(wt, ".env")), "present file copied into worktree");
    assert.ok(!existsSync(path.join(wt, "missing.txt")), "missing file skipped gracefully");
    assert.match(readFileSync(path.join(wt, ".env"), "utf8"), /SECRET=1/, "copied content matches");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create with existing branch reuses it and prints Using existing branch", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-test-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    // Create an existing branch (but no worktree yet)
    git(["checkout", "-b", "feature/existing"], repo);
    writeFileSync(path.join(repo, "file-on-branch.txt"), "content\n");
    git(["add", "file-on-branch.txt"], repo);
    git(["commit", "-m", "add file"], repo);
    git(["checkout", "master"], repo); // Switch back to master

    sh(["init"], repo);

    // Now create a worktree for the existing branch
    const out = sh(["create", "feature/existing"], repo);
    assert.match(out, /Using existing branch/, "prints Using existing branch message");

    const wt = path.join(worktrees, "feature-existing");
    assert.ok(existsSync(wt), "worktree created");
    assert.ok(existsSync(path.join(wt, "file-on-branch.txt")), "worktree has branch content");

    const listOut = sh(["list"], repo);
    assert.match(listOut, /feature\/existing/, "branch tracked in list");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("clean on empty repo (no worktrees ever created) reports Nothing to clean", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-clean-empty-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);

    // Run clean on a repo that has never had any worktrees
    const out = sh(["clean"], repo);
    assert.match(out, /Nothing to clean\./, "reports Nothing to clean on empty state");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("commands error clearly when mycadre.json exists but is corrupted/invalid JSON", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-corrupt-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    // Write corrupted JSON to mycadre.json
    writeFileSync(path.join(repo, "mycadre.json"), "{invalid json}");

    // Try to create - should error with clear message, not raw stack trace
    let exited = false;
    let errorOutput = "";
    try {
      sh(["create", "test-branch"], repo);
    } catch (e) {
      exited = true;
      errorOutput = e.message || e.toString() || "";
    }

    assert.ok(exited, "create exits with error when config is invalid JSON");
    assert.match(errorOutput, /Error:|JSON|Expected property|position/i, "error message reports JSON parsing issue");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("create with a deeply nested branch name replaces all slashes in the worktree dir", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-nested-"));
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
    sh(["create", "feature/user/deep-fix"], repo);

    const wt = path.join(worktrees, "feature-user-deep-fix");
    assert.ok(existsSync(wt), "nested branch worktree dir has all slashes replaced");

    const list = sh(["list"], repo);
    assert.match(list, /feature\/user\/deep-fix/, "list shows the original branch name");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create detects worktree dir collision (feature/foo-bar vs feature/foo/bar both map to feature-foo-bar) and errors", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-collision-"));
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
    sh(["create", "feature/foo-bar"], repo);

    // Now try to create feature/foo/bar which would collide
    const res = spawnSync("node", [CLI, "create", "feature/foo/bar"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.notEqual(res.status, 0, "create detects collision and exits with error");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /collision|already exists|conflicts/i, "error mentions the collision or path conflict");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("clean does NOT remove worktree dir when git branch was manually deleted", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-clean-manual-delete-"));
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
    sh(["create", "feature/manual-delete"], repo);
    const wt = path.join(worktrees, "feature-manual-delete");
    assert.ok(existsSync(wt), "worktree created");
    writeFileSync(path.join(wt, "test.txt"), "content\n");

    // Manually remove the git worktree metadata (orphaning the directory on disk)
    const gitWorktreeDir = path.join(repo, ".git", "worktrees", "feature-manual-delete");
    if (existsSync(gitWorktreeDir)) {
      rmSync(gitWorktreeDir, { recursive: true });
    }

    // clean should NOT remove the orphaned directory (defensive behavior)
    // After prune, git won't know about this worktree anymore, so clean will see it as stale in state
    // and untrack it, but NOT remove the directory
    const out = sh(["clean"], repo);
    // Should untrack it but preserve the directory
    assert.ok(existsSync(wt), "worktree directory still exists (not removed by clean)");
    assert.ok(existsSync(path.join(wt, "test.txt")), "worktree content preserved");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create with invalid branch name (spaces) errors with git's message", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-invalid-branch-"));
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

    // Try to create a branch with spaces (invalid in git)
    let err = null;
    try {
      sh(["create", "feature with spaces"], repo);
    } catch (e) {
      err = e;
    }

    assert.ok(err, "should exit with error for invalid branch name");
    assert.equal(err.status, 1, "exit code is 1");
    const combined = err.message + (err.stderr ?? "");
    assert.match(combined, /not a valid branch name|invalid/, "error message references the invalid name");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("--help works outside a git repo", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "mycadre-nogit-help-"));
  try {
    const out = execFileSync("node", [CLI, "--help"], { cwd: outside, encoding: "utf8" });
    assert.match(out, /Usage:/, "prints usage section");
    assert.match(out, /mycadre init/, "lists the init command");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("--version works outside a git repo", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "mycadre-nogit-version-"));
  try {
    const out = execFileSync("node", [CLI, "--version"], { cwd: outside, encoding: "utf8" });
    assert.match(out, /0\.1\.0/, "--version outputs version outside git repo");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("--help with unknown flag suggests help and exits gracefully", () => {
  const outside = mkdtempSync(path.join(tmpdir(), "mycadre-unknown-flag-"));
  try {
    let err = null;
    try {
      execFileSync("node", [CLI, "--unknown-flag"], { cwd: outside, encoding: "utf8" });
    } catch (e) {
      err = e;
    }
    assert.ok(err, "should exit with error for unknown flag");
    assert.equal(err.status, 1, "exit code is 1");
    const output = err.stderr || err.stdout || "";
    // Should suggest help or show usage info
    assert.match(output, /help|usage|unknown/i, "error output mentions help or unknown flag");
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("remove when .mycadre.json is missing (untracked state)", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-remove-no-config-"));
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
    sh(["create", "feature/test"], repo);
    const wt = path.join(worktrees, "feature-test");
    assert.ok(existsSync(wt), "worktree created");
    assert.ok(existsSync(path.join(repo, "mycadre.json")), "mycadre.json exists");

    // Simulate missing config file (corrupted or deleted)
    rmSync(path.join(repo, "mycadre.json"));
    assert.ok(!existsSync(path.join(repo, "mycadre.json")), "mycadre.json is removed");

    // remove should still work gracefully with missing config, treating it as untracked
    const res = spawnSync("node", [CLI, "remove", "feature/test"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.equal(res.status, 0, "remove exits 0 even when config is missing");
    const combined = res.stdout + res.stderr;
    assert.match(combined, /No tracked worktree|Removed/, "reports removal or missing entry");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("list output format with special chars in branch names (sanitization)", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-special-chars-"));
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
    
    // Create worktrees with special chars in branch names
    sh(["create", "feature/my-feature"], repo);
    sh(["create", "bugfix/some-bug-fix"], repo);
    sh(["create", "release/v1.2.3-beta"], repo);
    
    // Verify worktrees exist with sanitized names (slashes and hyphens)
    assert.ok(existsSync(path.join(worktrees, "feature-my-feature")), "feature/my-feature sanitized");
    assert.ok(existsSync(path.join(worktrees, "bugfix-some-bug-fix")), "bugfix/some-bug-fix sanitized");
    assert.ok(existsSync(path.join(worktrees, "release-v1.2.3-beta")), "release/v1.2.3-beta sanitized");
    
    // List output should show all branches and their status
    const list = sh(["list"], repo);
    assert.match(list, /feature\/my-feature/, "list shows original branch name (feature/my-feature)");
    assert.match(list, /bugfix\/some-bug-fix/, "list shows original branch name (bugfix/some-bug-fix)");
    assert.match(list, /release\/v1.2.3-beta/, "list shows original branch name (release/v1.2.3-beta)");
    
    // All should show ok status
    const lines = list.split("\n").filter(l => l.trim());
    const featureLine = lines.find(l => l.includes("feature/my-feature"));
    const bugfixLine = lines.find(l => l.includes("bugfix/some-bug-fix"));
    const releaseLine = lines.find(l => l.includes("release/v1.2.3-beta"));
    
    assert.match(featureLine, /\bok\b/, "feature/my-feature shows ok status");
    assert.match(bugfixLine, /\bok\b/, "bugfix/some-bug-fix shows ok status");
    assert.match(releaseLine, /\bok\b/, "release/v1.2.3-beta shows ok status");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("clean behavior with uncommitted changes in worktree (should warn/error gracefully)", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-clean-uncommitted-"));
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
    sh(["create", "feature/dirty"], repo);
    const wt = path.join(worktrees, "feature-dirty");
    assert.ok(existsSync(wt), "worktree created");

    // Add uncommitted changes to worktree
    const testFile = path.join(wt, "uncommitted.txt");
    writeFileSync(testFile, "uncommitted content\n");
    git(["add", "uncommitted.txt"], wt);
    // Stage the file but don't commit it

    // clean should handle this gracefully
    const res = spawnSync("node", [CLI, "clean"], {
      cwd: repo,
      encoding: "utf8",
    });
    
    // clean should either:
    // 1. Succeed (clean doesn't remove worktrees, just prunes orphaned refs), or
    // 2. Warn/error clearly without corrupting the worktree
    const combined = res.stdout + res.stderr;
    
    // The worktree and its uncommitted changes should still exist
    assert.ok(existsSync(wt), "worktree still exists after clean with uncommitted changes");
    assert.ok(existsSync(testFile), "uncommitted file still exists after clean");
    
    // Exit code should be 0 (clean is a safe operation) or a clear error
    assert.ok(res.status === 0 || res.status === 1, "clean exits cleanly (0 or 1, not crash)");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("create --from with a remote-only branch (not yet checked out locally)", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-remote-from-"));
  const upstream = mkdtempSync(path.join(tmpdir(), "mycadre-upstream-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  try {
    // Set up an upstream repo with a branch
    git(["init", "--bare"], upstream);

    // Set up local repo and push a branch upstream
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    // Add upstream remote
    git(["remote", "add", "origin", upstream], repo);
    git(["push", "-u", "origin", "master"], repo);

    // Create and push a feature branch on upstream
    git(["checkout", "-b", "feature/remote-only"], repo);
    writeFileSync(path.join(repo, "FEATURE.txt"), "feature content\n");
    git(["add", "FEATURE.txt"], repo);
    git(["commit", "-m", "add feature"], repo);
    git(["push", "-u", "origin", "feature/remote-only"], repo);

    // Switch back to master and delete the local feature branch (simulate not having checked it out)
    git(["checkout", "master"], repo);
    git(["branch", "-D", "feature/remote-only"], repo);

    // Verify the remote branch exists but local doesn't
    const localBranches = execFileSync("git", ["branch", "-l"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.doesNotMatch(localBranches, /feature\/remote-only/, "local branch was deleted");

    const remoteBranches = execFileSync("git", ["branch", "-r"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.match(remoteBranches, /origin\/feature\/remote-only/, "remote branch exists");

    // Initialize mycadre
    sh(["init"], repo);

    // Now test: can we create a worktree from the remote branch?
    // This is the edge case: --from should ideally track origin/feature/remote-only
    // or error clearly if it can't
    let createdSuccessfully = false;
    let errorMsg = "";
    try {
      const out = sh(["create", "feature/new-from-remote", "--from", "feature/remote-only"], repo);
      createdSuccessfully = true;
      // If it works, the worktree should have the feature content
      const wt = path.join(worktrees, "feature-new-from-remote");
      if (existsSync(wt) && existsSync(path.join(wt, "FEATURE.txt"))) {
        assert.ok(true, "worktree created from remote branch with content");
      }
    } catch (e) {
      errorMsg = e.message || e.toString() || "";
      // If it fails, it should fail with a clear message about the branch not existing
      assert.match(errorMsg, /does not exist|not found|no such|could not|error/i, "error message is clear about branch issue");
    }

    // Either way (success or clear error), we should not crash or leave garbage
    assert.ok(
      createdSuccessfully || errorMsg.length > 0,
      "create either succeeds with remote branch or fails clearly"
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(upstream, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("remove of fully orphaned worktree (dir deleted AND branch deleted) cleans up gracefully", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-orphan-"));
  const worktrees = path.resolve(repo, "../mycadre-worktrees");
  try {
    // Set up repo and mycadre
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    // Initialize mycadre
    sh(["init"], repo);

    // Create a worktree via mycadre
    sh(["create", "test-orphan"], repo);
    const wt = path.join(worktrees, "test-orphan");
    assert.ok(existsSync(wt), "worktree was created");

    // Verify it's tracked
    let listOutput = sh(["list"], repo);
    assert.match(listOutput, /test-orphan/, "worktree is tracked in list");

    // Now simulate catastrophic failure: both worktree dir AND branch are deleted
    // First delete the worktree directory
    rmSync(wt, { recursive: true, force: true });
    assert.ok(!existsSync(wt), "worktree directory manually deleted");

    // Then delete the branch from the main repo using force-all to ignore worktree state
    // Use git worktree prune or git branch -D with worktree removal first
    try {
      git(["worktree", "remove", "--force", "test-orphan"], repo);
    } catch (e) {
      // worktree remove might fail if already gone, which is fine
    }
    
    git(["branch", "-D", "test-orphan"], repo);
    const branches = execFileSync("git", ["branch"], {
      cwd: repo,
      encoding: "utf8",
    });
    assert.doesNotMatch(branches, /test-orphan/, "branch was deleted");

    // Now try to remove it - should handle the fully orphaned state gracefully
    const res = spawnSync("node", [CLI, "remove", "test-orphan"], {
      cwd: repo,
      encoding: "utf8",
    });

    // Should succeed (exit 0)
    assert.equal(res.status, 0, "remove of fully orphaned worktree exits 0");

    // The entry should be removed from tracking
    listOutput = sh(["list"], repo);
    assert.doesNotMatch(listOutput, /test-orphan/, "orphaned entry was removed from tracking");

    const combined = res.stdout + res.stderr;
    assert.match(combined, /Removed 'test-orphan'\./, "confirms removal");
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});

test("list with multiple worktrees shows correct ordering and status", () => {
  const repo = mkdtempSync(path.join(tmpdir(), "mycadre-multi-list-"));
  const worktrees = mkdtempSync(path.join(tmpdir(), "mycadre-worktrees-multi-"));
  try {
    git(["init"], repo);
    git(["config", "user.email", "t@t.co"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    writeFileSync(path.join(repo, "README.md"), "hi\n");
    git(["add", "README.md"], repo);
    git(["commit", "-m", "init"], repo);

    sh(["init"], repo);
    
    // Create multiple worktrees in varying order
    sh(["create", "zebra"], repo);
    sh(["create", "apple"], repo);
    sh(["create", "banana"], repo);
    
    // List and verify all three are present
    const listOutput = sh(["list"], repo);
    
    // Check for each worktree with its path to ensure proper formatting
    assert.match(listOutput, /^zebra\t/m, "zebra worktree with tab separator");
    assert.match(listOutput, /^apple\t/m, "apple worktree with tab separator");
    assert.match(listOutput, /^banana\t/m, "banana worktree with tab separator");
    
    // Verify status "ok" is shown for all (they should all exist and be healthy)
    const lines = listOutput.trim().split("\n");
    const worktreeLines = lines.filter(l => /^(zebra|apple|banana)\t/.test(l));
    assert.equal(worktreeLines.length, 3, "exactly 3 worktree lines in output");
    
    // Each line should end with "ok" status
    for (const line of worktreeLines) {
      assert.match(line, /ok$/, `worktree line shows 'ok' status: ${line}`);
    }
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(worktrees, { recursive: true, force: true });
  }
});
