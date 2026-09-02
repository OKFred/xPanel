import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ONLINE_ACCEPTANCE_CONFIRMATION,
  activeVersionId,
  createFixtureName,
  parseLifecycleEnvironment,
  preflightRelay,
  relayBindingState,
  runOnlineLifecycle,
} from "./online-lifecycle-lib.mjs";

const validEnvironment = {
  XPANEL_ONLINE_ACCEPTANCE: ONLINE_ACCEPTANCE_CONFIRMATION,
  XPANEL_REMOTE_BASE_URL: "https://xpanel-relay-dev.this-time.workers.dev",
  XPANEL_REMOTE_RELAY_NAME: "xpanel-relay-dev",
  XPANEL_REMOTE_TOKEN: "synthetic-token",
};

function lifecycleConfig() {
  return {
    fixtureName: "xpanel-relay-fixture-0123456789ab",
    fixtureOrigin:
      "https://xpanel-relay-fixture-0123456789ab.this-time.workers.dev",
  };
}

function fakeOperations(overrides = {}) {
  const calls = [];
  const operation =
    (name, result) =>
    async (...args) => {
      calls.push([name, ...args]);
      if (result instanceof Error) throw result;
      return result;
    };
  return {
    calls,
    operations: {
      inspectRelay: operation("inspectRelay", {
        policy: "allowlist",
        allowedOrigins: "",
        selfOrigins: "https://relay-alias.example.com",
      }),
      preflightRelay: operation("preflightRelay"),
      deployFixture: operation("deployFixture"),
      waitForFixture: operation("waitForFixture"),
      openRelay: operation("openRelay"),
      runProtocolAcceptance: operation("runProtocolAcceptance"),
      runChromiumAcceptance: operation("runChromiumAcceptance"),
      restoreRelay: operation("restoreRelay"),
      deleteFixture: operation("deleteFixture"),
      ...overrides,
    },
  };
}

describe("online lifecycle environment", () => {
  test("accepts a guarded workers.dev development Relay", () => {
    assert.deepEqual(parseLifecycleEnvironment(validEnvironment), {
      relayBaseUrl: "https://xpanel-relay-dev.this-time.workers.dev",
      relayName: "xpanel-relay-dev",
      relayToken: "synthetic-token",
      workersDevSuffix: "this-time.workers.dev",
      chromiumExecutable: undefined,
    });
  });

  test("rejects CI, missing authorization, production-like names, and mismatched hosts", () => {
    assert.throws(() =>
      parseLifecycleEnvironment({ ...validEnvironment, CI: "true" }),
    );
    assert.throws(() =>
      parseLifecycleEnvironment({
        ...validEnvironment,
        XPANEL_ONLINE_ACCEPTANCE: "",
      }),
    );
    assert.throws(() =>
      parseLifecycleEnvironment({
        ...validEnvironment,
        XPANEL_REMOTE_RELAY_NAME: "xpanel-relay",
        XPANEL_REMOTE_BASE_URL: "https://xpanel-relay.this-time.workers.dev",
      }),
    );
    assert.throws(() =>
      parseLifecycleEnvironment({
        ...validEnvironment,
        XPANEL_REMOTE_RELAY_NAME: "different-dev",
      }),
    );
  });

  test("creates only guarded random Fixture names", () => {
    assert.equal(
      createFixtureName(Uint8Array.from([0, 1, 2, 3, 4, 5])),
      "xpanel-relay-fixture-000102030405",
    );
    assert.throws(() => createFixtureName(Uint8Array.of(1)));
  });
});

describe("Wrangler state parsing", () => {
  test("requires one 100% active version", () => {
    assert.equal(
      activeVersionId({
        versions: [{ version_id: "version-1", percentage: 100 }],
      }),
      "version-1",
    );
    assert.throws(() => activeVersionId({ versions: [] }));
    assert.throws(() =>
      activeVersionId({
        versions: [
          { version_id: "one", percentage: 100 },
          { version_id: "two", percentage: 100 },
        ],
      }),
    );
  });

  test("reads only the expected plain-text Relay bindings", () => {
    assert.deepEqual(
      relayBindingState({
        resources: {
          bindings: [
            { name: "TARGET_POLICY", text: "allowlist", type: "plain_text" },
            {
              name: "ALLOWED_TARGET_ORIGINS",
              text: "",
              type: "plain_text",
            },
            {
              name: "RELAY_SELF_ORIGINS",
              text: "https://relay.example.com",
              type: "plain_text",
            },
            { name: "RELAY_TOKEN_SHA256", type: "secret_text" },
          ],
        },
      }),
      {
        policy: "allowlist",
        allowedOrigins: "",
        selfOrigins: "https://relay.example.com",
      },
    );
    assert.throws(() =>
      relayBindingState({
        resources: {
          bindings: [
            { name: "TARGET_POLICY", text: "allowlist", type: "plain_text" },
            {
              name: "ALLOWED_TARGET_ORIGINS",
              text: "",
              type: "plain_text",
            },
            { name: "RELAY_SELF_ORIGINS", text: "", type: "plain_text" },
            { name: "UNEXPECTED", text: "value", type: "plain_text" },
          ],
        },
      }),
    );
  });
});

describe("Relay authentication preflight", () => {
  test("sends the token only as Bearer authentication with protocol V1", async () => {
    let observedUrl;
    let observedInit;
    await preflightRelay(
      {
        relayBaseUrl: "https://xpanel-relay-dev.example.workers.dev",
        relayToken: "synthetic-token",
      },
      async (url, init) => {
        observedUrl = url;
        observedInit = init;
        return new Response(
          JSON.stringify({ protocolVersion: 1, provider: "cloudflare" }),
          { headers: { "Content-Type": "application/json" }, status: 200 },
        );
      },
    );
    assert.equal(
      observedUrl,
      "https://xpanel-relay-dev.example.workers.dev/v1/capabilities",
    );
    assert.deepEqual(observedInit.headers, {
      Authorization: "Bearer synthetic-token",
      "X-XPanel-Protocol": "1",
    });
    assert.equal(observedUrl.includes("synthetic-token"), false);
  });

  test("rejects authentication and unsupported capability responses", async () => {
    await assert.rejects(
      preflightRelay(
        validEnvironment,
        async () => new Response(null, { status: 401 }),
      ),
      /HTTP 401/u,
    );
    await assert.rejects(
      preflightRelay(
        validEnvironment,
        async () =>
          new Response(
            JSON.stringify({ protocolVersion: 2, provider: "cloudflare" }),
            { status: 200 },
          ),
      ),
      /unsupported capabilities/u,
    );
  });
});

describe("guarded online lifecycle", () => {
  test("runs both acceptance layers and always closes the Relay before deleting the Fixture", async () => {
    const { calls, operations } = fakeOperations();
    await runOnlineLifecycle(lifecycleConfig(), operations);
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        "inspectRelay",
        "preflightRelay",
        "deployFixture",
        "waitForFixture",
        "openRelay",
        "runProtocolAcceptance",
        "runChromiumAcceptance",
        "restoreRelay",
        "deleteFixture",
      ],
    );
    assert.equal(calls[4][1].fixtureOrigin.endsWith("workers.dev"), true);
    assert.equal(calls[4][2].selfOrigins, "https://relay-alias.example.com");
    assert.equal(calls[7][2].selfOrigins, "https://relay-alias.example.com");
  });

  test("deletes a possibly-created Fixture when deployment reports failure", async () => {
    const { calls, operations } = fakeOperations({
      deployFixture: async () => {
        calls.push(["deployFixture"]);
        throw new Error("synthetic deploy failure");
      },
    });
    await assert.rejects(
      runOnlineLifecycle(lifecycleConfig(), operations),
      /synthetic deploy failure/u,
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["inspectRelay", "preflightRelay", "deployFixture", "deleteFixture"],
    );
  });

  test("restores and deletes when opening the Relay reports failure", async () => {
    const { calls, operations } = fakeOperations({
      openRelay: async () => {
        calls.push(["openRelay"]);
        throw new Error("synthetic open failure");
      },
    });
    await assert.rejects(
      runOnlineLifecycle(lifecycleConfig(), operations),
      /synthetic open failure/u,
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        "inspectRelay",
        "preflightRelay",
        "deployFixture",
        "waitForFixture",
        "openRelay",
        "restoreRelay",
        "deleteFixture",
      ],
    );
  });

  test("restores and deletes after an acceptance failure", async () => {
    const { calls, operations } = fakeOperations({
      runProtocolAcceptance: async () => {
        calls.push(["runProtocolAcceptance"]);
        throw new Error("synthetic protocol failure");
      },
    });
    await assert.rejects(
      runOnlineLifecycle(lifecycleConfig(), operations),
      /synthetic protocol failure/u,
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      [
        "inspectRelay",
        "preflightRelay",
        "deployFixture",
        "waitForFixture",
        "openRelay",
        "runProtocolAcceptance",
        "restoreRelay",
        "deleteFixture",
      ],
    );
  });

  test("refuses an invalid token before touching Cloudflare", async () => {
    const { calls, operations } = fakeOperations({
      preflightRelay: async () => {
        calls.push(["preflightRelay"]);
        throw new Error("synthetic authentication failure");
      },
    });
    await assert.rejects(
      runOnlineLifecycle(lifecycleConfig(), operations),
      /synthetic authentication failure/u,
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["inspectRelay", "preflightRelay"],
    );
  });

  test("attempts both cleanup steps and reports every cleanup failure", async () => {
    const { calls, operations } = fakeOperations({
      restoreRelay: async () => {
        calls.push(["restoreRelay"]);
        throw new Error("synthetic restore failure");
      },
      deleteFixture: async () => {
        calls.push(["deleteFixture"]);
        throw new Error("synthetic delete failure");
      },
    });
    await assert.rejects(
      runOnlineLifecycle(lifecycleConfig(), operations),
      (error) =>
        error instanceof AggregateError &&
        error.errors.length === 2 &&
        error.message.includes("cleanup was incomplete"),
    );
    assert.deepEqual(
      calls.slice(-2).map(([name]) => name),
      ["restoreRelay", "deleteFixture"],
    );
  });

  test("refuses a non-empty baseline before touching Cloudflare", async () => {
    const { calls, operations } = fakeOperations({
      inspectRelay: async () => {
        calls.push(["inspectRelay"]);
        return {
          policy: "allowlist",
          allowedOrigins: "https://already-open.example.com",
          selfOrigins: "",
        };
      },
    });
    await assert.rejects(
      runOnlineLifecycle(lifecycleConfig(), operations),
      /does not currently have an empty allowlist/u,
    );
    assert.deepEqual(
      calls.map(([name]) => name),
      ["inspectRelay"],
    );
  });
});
