import { existsSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { repoRoot } from "../git.js";
import {
  configPath,
  DEFAULT_CONFIG,
  writeConfig,
  STATE_FILENAME,
} from "../config.js";

/** Ensure the local state file is gitignored (issue #5): it holds machine-specific
 * absolute paths and must never be committed. */
function ensureGitignored(root: string): void {
  const gitignorePath = path.join(root, ".gitignore");
  const entry = STATE_FILENAME;
  let contents = "";
  if (existsSync(gitignorePath)) {
    contents = readFileSync(gitignorePath, "utf8");
    const lines = contents.split("\n").map((l) => l.trim());
    if (lines.includes(entry) || lines.includes(`/${entry}`)) return;
    const prefix = contents.endsWith("\n") || contents === "" ? "" : "\n";
    appendFileSync(gitignorePath, `${prefix}${entry}\n`);
  } else {
    writeFileSync(gitignorePath, `${entry}\n`);
  }
  console.log(`Added ${entry} to .gitignore`);
}

export function runInit(): void {
  const root = repoRoot();
  const p = configPath(root);
  if (existsSync(p)) {
    console.log(`mycadre.json already exists at ${p}`);
  } else {
    writeConfig(root, DEFAULT_CONFIG);
    console.log(`Created ${p}`);
    console.log(
      "Edit it to list the files mycadre should copy into new worktrees (e.g. .env) and set an optional setup command (\"setup\", e.g. \"npm install\" — it is null by default, so no command runs until you set one)."
    );
  }
  ensureGitignored(root);
}
