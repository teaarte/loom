// The container-isolation toggle: mode parsing, credential resolution, the
// auto/require/off decision (with an injected Docker probe + a temp HOME, no
// real Docker), and the usage formatter. This is where the honesty rule lives
// — auto degrades with a loud notice; require refuses.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

import {
  containerModeFrom,
  formatUsage,
  resolveContainerCreds,
  resolveContainerPlan,
} from "../src/lib/container.js";

describe("containerModeFrom", () => {
  it("maps the toggle flags to a mode and rejects the contradiction", () => {
    assert.deepEqual(containerModeFrom({ docker: false, noDocker: false }), { mode: "auto" });
    assert.deepEqual(containerModeFrom({ docker: true, noDocker: false }), { mode: "require" });
    assert.deepEqual(containerModeFrom({ docker: false, noDocker: true }), { mode: "off" });
    assert.ok("error" in containerModeFrom({ docker: true, noDocker: true }));
  });
});

describe("resolveContainerCreds", () => {
  it("prefers the OAuth token env, then a file credential, else none", () => {
    const home = mkdtempSync(join(tmpdir(), "loom-creds-"));
    try {
      assert.deepEqual(resolveContainerCreds({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x" }, home), {
        kind: "token",
        token: "sk-ant-oat-x",
      });
      // No token, no file → none.
      assert.deepEqual(resolveContainerCreds({}, home), { kind: "none" });
      // No token, file present → file.
      mkdirSync(join(home, ".claude"), { recursive: true });
      writeFileSync(join(home, ".claude", ".credentials.json"), "{}", "utf8");
      assert.deepEqual(resolveContainerCreds({}, home), {
        kind: "file",
        path: join(home, ".claude", ".credentials.json"),
      });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("resolveContainerPlan — auto degrades loudly, require refuses", () => {
  const emptyHome = (): string => mkdtempSync(join(tmpdir(), "loom-plan-home-"));

  it("off → always worktree, never probes docker", () => {
    let probed = false;
    const plan = resolveContainerPlan({
      mode: "off",
      env: { LOOM_DOCKER_IMAGE: "img", CLAUDE_CODE_OAUTH_TOKEN: "t" },
      home: "/nope",
      dockerAvailable: () => {
        probed = true;
        return true;
      },
      onNotice: () => {},
    });
    assert.deepEqual(plan, { useDocker: false });
    assert.equal(probed, false);
  });

  it("auto + no docker → worktree fallback with a loud notice", () => {
    const notices: string[] = [];
    const plan = resolveContainerPlan({
      mode: "auto",
      env: {},
      home: "/nope",
      dockerAvailable: () => false,
      onNotice: (m) => notices.push(m),
    });
    assert.deepEqual(plan, { useDocker: false });
    assert.equal(notices.length, 1);
    assert.match(notices[0] ?? "", /Docker.*not found|falling back/i);
  });

  it("auto + docker + image + token → container active, settings gathered", () => {
    const home = emptyHome();
    try {
      const notices: string[] = [];
      const plan = resolveContainerPlan({
        mode: "auto",
        env: {
          LOOM_DOCKER_IMAGE: "loom-claude:latest",
          LOOM_DOCKER_NETWORK: "bridge",
          CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-x",
        },
        home,
        dockerAvailable: () => true,
        onNotice: (m) => notices.push(m),
      });
      assert.equal(plan.useDocker, true);
      if (plan.useDocker) {
        assert.equal(plan.container.image, "loom-claude:latest");
        assert.equal(plan.container.network, "bridge");
        assert.equal(plan.container.oauth_token, "sk-ant-oat-x");
        assert.equal(plan.container.cred_file, undefined);
      }
      assert.ok(notices.some((n) => /container isolation active/i.test(n)));
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("require + docker present + no image → throws (no silent run)", () => {
    const home = emptyHome();
    try {
      assert.throws(
        () =>
          resolveContainerPlan({
            mode: "require",
            env: { CLAUDE_CODE_OAUTH_TOKEN: "t" },
            home,
            dockerAvailable: () => true,
            onNotice: () => {},
          }),
        /--docker requires|image/i,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("require + docker present + image but no credential → throws", () => {
    const home = emptyHome();
    try {
      assert.throws(
        () =>
          resolveContainerPlan({
            mode: "require",
            env: { LOOM_DOCKER_IMAGE: "img" },
            home,
            dockerAvailable: () => true,
            onNotice: () => {},
          }),
        /credential|setup-token/i,
      );
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("require + no docker → throws", () => {
    assert.throws(
      () =>
        resolveContainerPlan({
          mode: "require",
          env: { LOOM_DOCKER_IMAGE: "img", CLAUDE_CODE_OAUTH_TOKEN: "t" },
          home: "/nope",
          dockerAvailable: () => false,
          onNotice: () => {},
        }),
      /--docker requires/i,
    );
  });
});

describe("formatUsage", () => {
  it("renders cost + tokens + turns", () => {
    const s = formatUsage({ tokens: { in: 3, out: 5, cached: 18312 }, cost_usd: 0.0367, num_turns: 2 });
    assert.match(s, /cost \$0\.0367/);
    assert.match(s, /3in\/5out\/18312cached/);
    assert.match(s, /2 turns/);
  });
});
