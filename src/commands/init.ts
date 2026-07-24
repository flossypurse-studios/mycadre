import { existsSync } from "node:fs";
import { repoRoot } from "../git.js";
import { configPath, DEFAULT_CONFIG, writeConfig } from "../config.js";

export function runInit(): void {
  const root = repoRoot();
  const p = configPath(root);
  if (existsSync(p)) {
    console.log(`mycadre.json already exists at ${p}`);
    return;
  }
  writeConfig(root, DEFAULT_CONFIG);
  console.log(`Created ${p}`);
  console.log(
    "Edit it to list the files mycadre should copy into new worktrees (e.g. .env) and an optional setup command (e.g. \"npm install\")."
  );
}
