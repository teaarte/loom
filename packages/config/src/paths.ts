// Where the four stores live. The global home is provider-NEUTRAL
// `~/.config/loom` (XDG), NOT `~/.claude/` — loom must run without Claude, so
// its global config can't sit under a vendor dir. A `$LOOM_HOME` override is the
// test seam + the escape hatch for non-standard setups, mirroring `serve`'s
// existing `LOOM_SERVER_STATE_DIR`-or-default pattern.
//
// The per-project config lives under the provider-neutral `<repo>/.loom/`
// footprint (alongside the state DB and `providers.json`). `config` is a
// dependency-free leaf package, so it cannot import the kernel's footprint
// migrator; instead the reader falls back to a legacy `<repo>/.claude/loom.json`
// a kernel-side migration has not relocated yet, and the writer always targets
// `.loom/`.

import { homedir } from "node:os";
import { join } from "node:path";

// Resolve the global home: $LOOM_HOME wins; else $XDG_CONFIG_HOME/loom; else
// ~/.config/loom. `home` is passed so a test points it at a temp dir without
// touching the real `~`; it defaults to the OS home.
export function resolveLoomHome(env: NodeJS.ProcessEnv, home: string = homedir()): string {
  const explicit = env["LOOM_HOME"];
  if (explicit !== undefined && explicit.length > 0) return explicit;
  const xdg = env["XDG_CONFIG_HOME"];
  if (xdg !== undefined && xdg.length > 0) return join(xdg, "loom");
  return join(home, ".config", "loom");
}

export function configPath(loomHome: string): string {
  return join(loomHome, "config.json");
}

export function secretsPath(loomHome: string): string {
  return join(loomHome, "secrets.json");
}

export function workspacePath(loomHome: string): string {
  return join(loomHome, "workspace.json");
}

// The optional per-project override — committable, secret-free.
export function projectConfigPath(projectDir: string): string {
  return join(projectDir, ".loom", "loom.json");
}

// The legacy location the reader falls back to until a kernel-side footprint
// migration relocates it to `.loom/`. Never written.
export function legacyProjectConfigPath(projectDir: string): string {
  return join(projectDir, ".claude", "loom.json");
}
