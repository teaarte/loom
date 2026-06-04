// Static-asset serving for the React dashboard. `@loomfsm/dashboard` ships its
// PREBUILT `dist/` (index.html + hashed `assets/…`); this module resolves that
// directory off the workspace dependency and streams files from disk at `/`.
//
// The server imports NO JavaScript from the dashboard — it only reads files —
// so its runtime dependency graph stays workspace-only and the zero-non-
// workspace-dep posture holds. The framework (React/Vite) is a DEV dependency of
// the dashboard alone and never reaches a consumer.
//
// `/` serves the SPA; an unbuilt/dev checkout (no resolvable `dist`) gets an
// honest plain-text notice rather than a confusing 404 — there is no fallback
// UI (the vanilla page was removed). Asset paths under `/assets/` are content-
// hashed, so they are served immutable; index.html must revalidate.

import { existsSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import type { ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";

// Resolution is memoized: undefined = not yet probed, null = unresolved.
let cached: string | null | undefined;

// The dashboard's built `dist/` dir, or null if it cannot be found / is unbuilt.
// An explicit override (a test fixture, or a custom deploy) is validated the
// same way — an override without an `index.html` is treated as unbuilt, not
// memoized, so it never poisons the resolved cache.
function distDir(override?: string): string | null {
  if (override !== undefined && override.length > 0) {
    return existsSync(join(override, "index.html")) ? override : null;
  }
  if (cached !== undefined) return cached;
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@loomfsm/dashboard/package.json");
    const dir = join(dirname(pkgJson), "dist");
    cached = existsSync(join(dir, "index.html")) ? dir : null;
  } catch {
    cached = null;
  }
  return cached;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

// Try to serve a dashboard asset for a GET request. Returns true when it has
// written a response (a file, or the not-built notice for `/`); false when the
// path is not a dashboard asset, so the caller proceeds to API routing / 404.
// Unauthenticated by design — the static shell carries no secrets and must load
// so it can prompt for the bearer token; the API behind it stays gated.
export function serveDashboard(res: ServerResponse, pathname: string, override?: string): boolean {
  const dir = distDir(override);
  if (dir === null) {
    if (pathname === "/") {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end("loom dashboard assets are not built — run `pnpm --filter @loomfsm/dashboard build`.\n");
      return true;
    }
    return false;
  }

  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const full = resolve(dir, rel);
  // Path-traversal guard: the resolved path must stay within dist.
  if (full !== dir && !full.startsWith(dir + sep)) return false;
  if (!existsSync(full) || !statSync(full).isFile()) return false;

  const type = CONTENT_TYPES[extname(full)] ?? "application/octet-stream";
  const cacheControl = pathname.startsWith("/assets/")
    ? "public, max-age=31536000, immutable"
    : "no-cache";
  res.writeHead(200, { "content-type": type, "cache-control": cacheControl });
  res.end(readFileSync(full));
  return true;
}
