// The static-asset handler, over REAL files on disk (a fixture stand-in for the
// dashboard's built dist). Proves: the SPA shell + hashed assets serve with the
// right content-type/cache headers, a path-traversal escape is refused, a
// non-asset path falls through (so API routing still owns it), and an unbuilt
// deploy gets the honest plain-text notice rather than a confusing 404.

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import { serveDashboard } from "../src/dashboard/assets.js";
import { makeDashboardFixture } from "./fixtures.js";

interface Captured {
  status: number;
  headers: Record<string, string>;
  body: string;
}

// A minimal ServerResponse stand-in capturing what the handler writes — the
// handler only calls writeHead + end, so a structural stub is enough (no DB, no
// socket). Cast through `unknown` at this transport boundary.
function capture(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: 0, headers: {}, body: "" };
  const stub = {
    writeHead(status: number, headers: Record<string, string>): void {
      out.status = status;
      out.headers = headers;
    },
    end(chunk?: string | Buffer): void {
      out.body = chunk === undefined ? "" : typeof chunk === "string" ? chunk : chunk.toString("utf8");
    },
  };
  return { res: stub as unknown as ServerResponse, out };
}

describe("dashboard assets", () => {
  const dist = makeDashboardFixture();

  it("serves the SPA shell at /", () => {
    const { res, out } = capture();
    assert.equal(serveDashboard(res, "/", dist), true);
    assert.equal(out.status, 200);
    assert.match(out.headers["content-type"] ?? "", /text\/html/);
    assert.match(out.headers["cache-control"] ?? "", /no-cache/);
    assert.match(out.body, /<div id="root">/);
  });

  it("serves a hashed asset as immutable", () => {
    const { res, out } = capture();
    assert.equal(serveDashboard(res, "/assets/app.js", dist), true);
    assert.equal(out.status, 200);
    assert.match(out.headers["content-type"] ?? "", /javascript/);
    assert.match(out.headers["cache-control"] ?? "", /immutable/);
  });

  it("refuses a path-traversal escape", () => {
    const { res } = capture();
    assert.equal(serveDashboard(res, "/assets/../../../etc/passwd", dist), false);
  });

  it("lets a non-asset path fall through to API routing", () => {
    const { res } = capture();
    assert.equal(serveDashboard(res, "/config", dist), false);
    assert.equal(serveDashboard(res, "/projects", dist), false);
  });

  it("returns an honest notice at / when the dashboard is not built", () => {
    const empty = mkdtempSync(join(tmpdir(), "loom-dashboard-empty-"));
    const { res, out } = capture();
    assert.equal(serveDashboard(res, "/", empty), true);
    assert.equal(out.status, 200);
    assert.match(out.headers["content-type"] ?? "", /text\/plain/);
    assert.match(out.body, /not built/);
  });

  it("does not serve assets when unbuilt (falls through)", () => {
    const empty = mkdtempSync(join(tmpdir(), "loom-dashboard-empty-"));
    const { res } = capture();
    assert.equal(serveDashboard(res, "/assets/app.js", empty), false);
  });
});
