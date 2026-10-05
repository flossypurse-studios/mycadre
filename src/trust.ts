import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  openSync,
  readSync,
  writeSync,
  closeSync,
  realpathSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

// A repo's mycadre.json `setup` command runs a shell command on your machine.
// A freshly cloned repo is untrusted, so the first run of a given command in a
// given repo asks first. Trust is keyed on (repo path, exact command): editing
// the command in mycadre.json asks again.

function trustFile(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "mycadre", "trusted.json");
}

function trustKey(root: string, setup: string): string {
  return createHash("sha256").update(realpathSync(root)).update("\0").update(setup).digest("hex");
}

function readTrusted(): Record<string, string> {
  try {
    const data = JSON.parse(readFileSync(trustFile(), "utf8"));
    return data && typeof data === "object" ? data : {};
  } catch {
    return {};
  }
}

export function isTrusted(root: string, setup: string): boolean {
  return Object.prototype.hasOwnProperty.call(readTrusted(), trustKey(root, setup));
}

export function recordTrust(root: string, setup: string): void {
  const file = trustFile();
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const trusted = readTrusted();
  trusted[trustKey(root, setup)] = realpathSync(root);
  writeFileSync(file, JSON.stringify(trusted, null, 2) + "\n", { mode: 0o600 });
}

/** Ask y/N on the controlling terminal. Returns false when there is no terminal. */
export function confirmOnTty(question: string): boolean {
  if (!process.stdin.isTTY || !existsSync("/dev/tty")) return false;
  let fd: number;
  try {
    fd = openSync("/dev/tty", "r+");
  } catch {
    return false;
  }
  try {
    writeSync(fd, question);
    const buf = Buffer.alloc(256);
    const n = readSync(fd, buf, 0, buf.length, null);
    return /^\s*y(es)?\s*$/i.test(buf.subarray(0, n).toString("utf8"));
  } catch {
    return false;
  } finally {
    closeSync(fd);
  }
}
