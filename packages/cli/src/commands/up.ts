// `loom up` (and a bare `loom`) — the one-command start: bring the control
// plane up on localhost defaults and open the dashboard in a browser. A thin
// wrapper over `loom serve` with ZERO required flags; every serve flag still
// passes through (`--port`, `--token`, `--project`, …). `--no-open` suppresses
// the browser for an SSH / headless session (the URL is still printed). Auth
// posture is unchanged — same loopback bind + optional bearer token as `serve`.

import { spawn } from "node:child_process";
import { platform } from "node:os";

import type { CliEnv } from "../lib/env.js";
import { serve, type ServeOverrides } from "./serve.js";

export interface UpOverrides extends ServeOverrides {
  // Open a URL in the user's browser (a test injects a spy). Production uses a
  // cross-platform, best-effort launcher.
  openBrowser?: (url: string) => void;
}

export async function up(argv: string[], env: CliEnv, overrides: UpOverrides = {}): Promise<number> {
  const { serveArgs, noOpen } = parseUpFlags(argv);
  const open = overrides.openBrowser ?? defaultOpenBrowser;

  // `openBrowser` rides in via the spread but is not a serve concern; it is
  // exempt from the excess-property check (spread members are). `onListening` is
  // the serve hook that fires once the plane is listening.
  return serve(serveArgs, env, {
    ...overrides,
    onListening: (url) => {
      if (noOpen) {
        env.out("loom up: --no-open — open the dashboard yourself at the URL above");
        return;
      }
      env.out(`loom up: opening ${url}`);
      open(url);
    },
  });
}

interface UpFlags {
  serveArgs: string[];
  noOpen: boolean;
}

// Strip `--no-open` (an `up`-only flag); everything else is a serve flag.
export function parseUpFlags(argv: string[]): UpFlags {
  const serveArgs: string[] = [];
  let noOpen = false;
  for (const a of argv) {
    if (a === "--no-open") noOpen = true;
    else serveArgs.push(a);
  }
  return { serveArgs, noOpen };
}

// Open a URL in the default browser, cross-platform. Best-effort: a missing
// opener or a headless host fails silently — the URL is already printed, so the
// operator can open it by hand.
function defaultOpenBrowser(url: string): void {
  const [cmd, args] = openCommand(url);
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      /* no browser / headless — the URL was printed */
    });
    child.unref();
  } catch {
    /* best-effort */
  }
}

function openCommand(url: string): [string, string[]] {
  switch (platform()) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      return ["cmd", ["/c", "start", "", url]];
    default:
      return ["xdg-open", [url]];
  }
}
