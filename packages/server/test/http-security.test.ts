// The HTTP control plane's network defenses, over REAL servers (loopback,
// ephemeral port) + REAL stores. Proves the layered posture: an un-tokened
// loopback server is open to the local browser but refused to a rebinding /
// cross-origin web page and to a drive on a non-allowlisted directory; a tokened
// server treats the token as the authority (LAN/tunnel host fine, allowlist
// bypassed) and accepts `?token=` only for the SSE stream. No mocked DB.

import assert from "node:assert/strict";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  hostHeaderAllowed,
  isLoopbackBindHost,
  isLoopbackHostname,
  isStateChanging,
  originAllowed,
} from "../src/net-guards.js";
import { startControlPlane, type ControlPlaneHandle } from "../src/index.js";
import { cleanup, freshProject, makeDashboardFixture, recordingExecutor, spawnRegistry, tempStateDir } from "./fixtures.js";
import type { Registry } from "@loomfsm/kernel";

const FAST = { watch_idle_ms: 15, wake: { poll_base_ms: 15, poll_factor: 1, poll_ceiling_ms: 40 } };

// ----- pure guards (no server) ---------------------------------------------

describe("net-guards — loopback + same-origin predicates", () => {
  it("recognises loopback hostnames (and only those)", () => {
    for (const h of ["localhost", "app.localhost", "127.0.0.1", "127.5.6.7", "::1", "[::1]"]) {
      assert.equal(isLoopbackHostname(h), true, h);
    }
    for (const h of ["evil.example", "0.0.0.0", "10.0.0.4", "169.254.1.1", "example.com"]) {
      assert.equal(isLoopbackHostname(h), false, h);
    }
  });

  it("treats 0.0.0.0 / :: / LAN bind hosts as non-loopback", () => {
    assert.equal(isLoopbackBindHost("127.0.0.1"), true);
    assert.equal(isLoopbackBindHost("localhost"), true);
    assert.equal(isLoopbackBindHost("0.0.0.0"), false);
    assert.equal(isLoopbackBindHost("192.168.1.20"), false);
  });

  it("Host check: enforced only when un-tokened; refuses a forged/absent Host", () => {
    assert.equal(hostHeaderAllowed("127.0.0.1:4317", false), true);
    assert.equal(hostHeaderAllowed("evil.example", false), false);
    assert.equal(hostHeaderAllowed(undefined, false), false);
    // Token-gated: a LAN / tunnel Host is expected, so the check is skipped.
    assert.equal(hostHeaderAllowed("my-tunnel.example", true), true);
  });

  it("Origin check: absent passes, same-origin passes, cross-origin / opaque fail", () => {
    assert.equal(originAllowed(undefined, "127.0.0.1:4317"), true);
    assert.equal(originAllowed("http://127.0.0.1:4317", "127.0.0.1:4317"), true);
    assert.equal(originAllowed("http://evil.example", "127.0.0.1:4317"), false);
    assert.equal(originAllowed("null", "127.0.0.1:4317"), false);
  });

  it("only POST/PUT/DELETE/PATCH are state-changing", () => {
    assert.equal(isStateChanging("GET"), false);
    assert.equal(isStateChanging("POST"), true);
    assert.equal(isStateChanging("DELETE"), true);
  });
});

// ----- M12: refuse a non-loopback bind without a token ----------------------

describe("startControlPlane — non-loopback bind requires a token (M12)", () => {
  it("throws when binding 0.0.0.0 with no token", async () => {
    await assert.rejects(
      startControlPlane({
        stateDir: tempStateDir(),
        host: "0.0.0.0",
        port: 0,
        resolveRegistry: () => spawnRegistry(),
        buildExecutor: () => recordingExecutor([]),
      }),
      /non-loopback host/,
    );
  });
});

// ----- a low-level client that can forge Host / Origin (fetch forbids both) --

interface Raw {
  status: number;
  json: any;
}
function raw(
  port: number,
  method: string,
  path: string,
  opts: { headers?: Record<string, string>; body?: unknown } = {},
): Promise<Raw> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { ...(opts.headers ?? {}) };
    let data: string | undefined;
    if (opts.body !== undefined) {
      data = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
      if (headers["content-type"] === undefined) headers["content-type"] = "application/json";
    }
    let settled = false;
    // `agent: false` → a fresh, un-pooled socket per request. The default global
    // agent keep-alives, and reusing a socket after an abnormal (413, body not
    // consumed) response wedges the next request — exactly what these adversarial
    // cases exercise.
    const req = httpRequest({ host: "127.0.0.1", port, path, method, headers, agent: false }, (res) => {
      let buf = "";
      res.on("data", (c) => (buf += c));
      res.on("end", () => {
        settled = true;
        let json: any = null;
        try {
          json = buf.length > 0 ? JSON.parse(buf) : null;
        } catch {
          /* non-JSON (dashboard html) */
        }
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    // An early 413 closes the socket while we may still be writing — tolerate it
    // once the response has been delivered.
    req.on("error", (err) => {
      if (!settled) reject(err);
    });
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// Open an SSE request and resolve with just the status code, then tear down.
function sseStatus(port: number, path: string, headers: Record<string, string> = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers, agent: false }, (res) => {
      resolve(res.statusCode ?? 0);
      res.destroy();
      req.destroy();
    });
    req.on("error", reject);
    req.end();
  });
}

// ----- un-tokened loopback server: Host / Origin / Content-Type / allowlist --

describe("http security — un-tokened loopback server", () => {
  let handle: ControlPlaneHandle;
  let port: number;
  const controller = new AbortController();
  const dirs: string[] = [];
  const stateDir = tempStateDir();
  const home = mkdtempSync(join(tmpdir(), "loom-sec-home-"));
  const allowFile = join(home, "projects.allow");
  const registries = new Map<string, Registry>();
  let allowedDir = "";

  before(async () => {
    allowedDir = await freshProject("loom-sec-allowed-");
    dirs.push(allowedDir);
    registries.set(allowedDir, spawnRegistry());
    registries.set(realpathSync(allowedDir), spawnRegistry());
    // The allowlist holds the canonical (realpath'd) directory, as the gate reads it.
    writeFileSync(allowFile, `${realpathSync(allowedDir)}\n`, "utf8");

    handle = await startControlPlane({
      stateDir,
      host: "127.0.0.1",
      port: 0,
      // NO token → the open-loopback posture: Host/Origin guards + allowlist gate.
      allowlistPath: allowFile,
      resolveRegistry: (dir) => registries.get(dir) ?? spawnRegistry(),
      buildExecutor: () => recordingExecutor([]),
      dashboardDir: makeDashboardFixture(),
      signal: controller.signal,
      ...FAST,
    });
    port = handle.port;
  });

  after(async () => {
    controller.abort();
    await handle.closed;
    for (const d of dirs) cleanup(d);
    rmSync(home, { recursive: true, force: true });
  });

  it("serves /health to a loopback Host", async () => {
    const res = await raw(port, "GET", "/health", { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, true);
  });

  it("refuses a forged (rebinding) Host with 403", async () => {
    const res = await raw(port, "GET", "/health", { headers: { host: "evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "FORBIDDEN_HOST");
  });

  it("refuses a cross-origin state-changing request with 403", async () => {
    const res = await raw(port, "POST", "/projects", {
      headers: { host: `127.0.0.1:${port}`, origin: "http://evil.example" },
      body: { dir: realpathSync(allowedDir) },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "FORBIDDEN_ORIGIN");
  });

  it("refuses a non-JSON content-type on a body route with 415", async () => {
    const res = await raw(port, "POST", "/projects", {
      headers: { host: `127.0.0.1:${port}`, "content-type": "text/plain" },
      body: JSON.stringify({ dir: realpathSync(allowedDir) }),
    });
    assert.equal(res.status, 415);
    assert.equal(res.json.error.code, "UNSUPPORTED_MEDIA_TYPE");
  });

  it("refuses an oversized body with 413", async () => {
    const big = "x".repeat(1_200_000);
    const res = await raw(port, "POST", "/projects", {
      headers: { host: `127.0.0.1:${port}` },
      body: { dir: big },
    });
    assert.equal(res.status, 413);
    assert.equal(res.json.error.code, "PAYLOAD_TOO_LARGE");
  });

  it("gates POST /projects on the allowlist: refuses a non-allowlisted dir (403)", async () => {
    const other = await freshProject("loom-sec-denied-");
    dirs.push(other);
    const res = await raw(port, "POST", "/projects", {
      headers: { host: `127.0.0.1:${port}` },
      body: { dir: other },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "PROJECT_DIR_NOT_ALLOWED");
  });

  it("allows POST /projects for an allowlisted dir (201)", async () => {
    const res = await raw(port, "POST", "/projects", {
      headers: { host: `127.0.0.1:${port}` },
      body: { dir: realpathSync(allowedDir) },
    });
    assert.equal(res.status, 201, JSON.stringify(res.json));
    assert.ok(res.json.id);
  });

  it("gates POST /submit on the allowlist: refuses a non-allowlisted path", async () => {
    const other = await freshProject("loom-sec-submit-denied-");
    dirs.push(other);
    const res = await raw(port, "POST", "/submit", {
      headers: { host: `127.0.0.1:${port}` },
      body: { project: other, task: "drive me" },
    });
    assert.equal(res.status, 403);
    assert.equal(res.json.error.code, "PROJECT_DIR_NOT_ALLOWED");
  });
});

// ----- tokened server: token is the authority -------------------------------

describe("http security — tokened server", () => {
  const TOKEN = "sec-token";
  let handle: ControlPlaneHandle;
  let port: number;
  const controller = new AbortController();
  const dirs: string[] = [];
  const stateDir = tempStateDir();
  const registries = new Map<string, Registry>();

  before(async () => {
    handle = await startControlPlane({
      stateDir,
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      // An allowlist file that authorizes NOTHING — proving the token bypasses it.
      allowlistPath: join(tempStateDir(), "empty.allow"),
      resolveRegistry: (dir) => registries.get(dir) ?? spawnRegistry(),
      buildExecutor: () => recordingExecutor([]),
      dashboardDir: makeDashboardFixture(),
      signal: controller.signal,
      ...FAST,
    });
    port = handle.port;
  });

  after(async () => {
    controller.abort();
    await handle.closed;
    for (const d of dirs) cleanup(d);
  });

  function authed(method: string, path: string, body?: unknown): Promise<Raw> {
    return raw(port, method, path, {
      headers: { host: `127.0.0.1:${port}`, authorization: `Bearer ${TOKEN}` },
      ...(body !== undefined ? { body } : {}),
    });
  }

  it("rejects a query-string token on a normal route (401) but accepts the header", async () => {
    const viaQuery = await raw(port, "GET", `/projects?token=${TOKEN}`, { headers: { host: `127.0.0.1:${port}` } });
    assert.equal(viaQuery.status, 401, "?token= must not authenticate a non-SSE route");
    const viaHeader = await authed("GET", "/projects");
    assert.equal(viaHeader.status, 200);
  });

  it("rejects a wrong bearer token (401)", async () => {
    const res = await raw(port, "GET", "/projects", {
      headers: { host: `127.0.0.1:${port}`, authorization: "Bearer not-the-token" },
    });
    assert.equal(res.status, 401);
  });

  it("the token bypasses the allowlist — drives any directory", async () => {
    const dir = await freshProject("loom-sec-token-bypass-");
    dirs.push(dir);
    registries.set(dir, spawnRegistry());
    registries.set(realpathSync(dir), spawnRegistry());
    const res = await authed("POST", "/projects", { dir });
    assert.equal(res.status, 201, JSON.stringify(res.json));
  });

  it("skips the Host check when token-gated (a LAN/tunnel Host is accepted)", async () => {
    const res = await raw(port, "GET", "/projects", {
      headers: { host: "my-tunnel.example", authorization: `Bearer ${TOKEN}` },
    });
    assert.equal(res.status, 200);
  });

  it("accepts ?token= ONLY on the SSE log stream", async () => {
    const dir = await freshProject("loom-sec-sse-");
    dirs.push(dir);
    registries.set(dir, spawnRegistry());
    registries.set(realpathSync(dir), spawnRegistry());
    const reg = await authed("POST", "/projects", { dir });
    assert.equal(reg.status, 201, JSON.stringify(reg.json));
    const id = reg.json.id as string;

    const ok = await sseStatus(port, `/projects/${id}/log?token=${TOKEN}`, { host: `127.0.0.1:${port}` });
    assert.equal(ok, 200);
    const denied = await sseStatus(port, `/projects/${id}/log`, { host: `127.0.0.1:${port}` });
    assert.equal(denied, 401);
  });
});
