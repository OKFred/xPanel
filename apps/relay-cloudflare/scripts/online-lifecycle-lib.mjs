export const ONLINE_ACCEPTANCE_CONFIRMATION =
  "I_UNDERSTAND_THIS_DEPLOYS_AND_DELETES_WORKERS";

const WORKER_NAME_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const SAFE_RELAY_NAME_PATTERN = /(?:^|-)(?:dev|staging|test)(?:-|$)/u;
const FIXTURE_NAME_PATTERN = /^xpanel-relay-fixture-[a-f\d]{12}$/u;

function requiredEnvironment(env, name) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}.`);
  return value;
}

export function parseLifecycleEnvironment(env) {
  if (env.CI && env.CI.toLowerCase() !== "false") {
    throw new Error("Online lifecycle acceptance is disabled in CI.");
  }
  if (env.XPANEL_ONLINE_ACCEPTANCE !== ONLINE_ACCEPTANCE_CONFIRMATION) {
    throw new Error(
      `Set XPANEL_ONLINE_ACCEPTANCE=${ONLINE_ACCEPTANCE_CONFIRMATION} to authorize temporary Worker deployment.`,
    );
  }

  const relayName = requiredEnvironment(env, "XPANEL_REMOTE_RELAY_NAME");
  if (
    !WORKER_NAME_PATTERN.test(relayName) ||
    !SAFE_RELAY_NAME_PATTERN.test(relayName)
  ) {
    throw new Error(
      "XPANEL_REMOTE_RELAY_NAME must be a valid Worker name containing dev, staging, or test.",
    );
  }

  const relayBaseUrl = new URL(
    requiredEnvironment(env, "XPANEL_REMOTE_BASE_URL"),
  );
  if (
    relayBaseUrl.protocol !== "https:" ||
    relayBaseUrl.username !== "" ||
    relayBaseUrl.password !== "" ||
    relayBaseUrl.pathname !== "/" ||
    relayBaseUrl.search !== "" ||
    relayBaseUrl.hash !== ""
  ) {
    throw new Error(
      "XPANEL_REMOTE_BASE_URL must be a credential-free HTTPS origin.",
    );
  }
  const labels = relayBaseUrl.hostname.split(".");
  if (
    labels.length < 4 ||
    labels.at(-2) !== "workers" ||
    labels.at(-1) !== "dev"
  ) {
    throw new Error(
      "The lifecycle runner supports workers.dev development Relays only.",
    );
  }
  if (labels[0] !== relayName) {
    throw new Error(
      "XPANEL_REMOTE_RELAY_NAME must match the first label of XPANEL_REMOTE_BASE_URL.",
    );
  }

  const relayToken = requiredEnvironment(env, "XPANEL_REMOTE_TOKEN");
  if (relayToken.length > 1_024 || /\s/u.test(relayToken)) {
    throw new Error("XPANEL_REMOTE_TOKEN has an invalid shape.");
  }

  return {
    relayBaseUrl: relayBaseUrl.origin,
    relayName,
    relayToken,
    workersDevSuffix: labels.slice(1).join("."),
    chromiumExecutable: env.XPANEL_CHROMIUM_EXECUTABLE?.trim() || undefined,
  };
}

export function createFixtureName(randomBytes) {
  const suffix = Buffer.from(randomBytes).toString("hex");
  const name = `xpanel-relay-fixture-${suffix}`;
  if (!FIXTURE_NAME_PATTERN.test(name)) {
    throw new Error("The random Fixture name failed its safety guard.");
  }
  return name;
}

export function activeVersionId(status) {
  const versions = Array.isArray(status?.versions) ? status.versions : [];
  const active = versions.filter(
    (version) => version?.percentage === 100 && version.version_id,
  );
  if (active.length !== 1) {
    throw new Error("The Relay must have exactly one 100% active version.");
  }
  return active[0].version_id;
}

export function relayBindingState(version) {
  const bindings = Array.isArray(version?.resources?.bindings)
    ? version.resources.bindings
    : [];
  const plainText = new Map(
    bindings
      .filter((binding) => binding?.type === "plain_text")
      .map((binding) => [binding.name, binding.text]),
  );
  const required = [
    "TARGET_POLICY",
    "ALLOWED_TARGET_ORIGINS",
    "RELAY_SELF_ORIGINS",
  ];
  for (const name of required) {
    if (typeof plainText.get(name) !== "string") {
      throw new Error(`The active Relay version is missing ${name}.`);
    }
  }
  const unexpected = [...plainText.keys()].filter(
    (name) => !required.includes(name),
  );
  if (unexpected.length > 0) {
    throw new Error(
      `The Relay has unexpected plain-text bindings: ${unexpected.join(", ")}.`,
    );
  }
  return {
    policy: plainText.get("TARGET_POLICY"),
    allowedOrigins: plainText.get("ALLOWED_TARGET_ORIGINS"),
    selfOrigins: plainText.get("RELAY_SELF_ORIGINS"),
  };
}

function asError(value) {
  return value instanceof Error ? value : new Error(String(value));
}

export async function runOnlineLifecycle(config, operations) {
  const baseline = await operations.inspectRelay();
  if (baseline.policy !== "allowlist" || baseline.allowedOrigins !== "") {
    throw new Error(
      "Refusing online acceptance because the Relay does not currently have an empty allowlist.",
    );
  }
  await operations.preflightRelay(config);

  let fixtureTouched = false;
  let relayTouched = false;
  let primaryError;
  const cleanupErrors = [];

  try {
    fixtureTouched = true;
    await operations.deployFixture(config);
    await operations.waitForFixture(config);

    relayTouched = true;
    await operations.openRelay(config, baseline);
    await operations.runProtocolAcceptance(config);
    await operations.runChromiumAcceptance(config);
  } catch (error) {
    primaryError = asError(error);
  } finally {
    if (relayTouched) {
      try {
        await operations.restoreRelay(config, baseline);
      } catch (error) {
        cleanupErrors.push(asError(error));
      }
    }
    if (fixtureTouched) {
      try {
        await operations.deleteFixture(config);
      } catch (error) {
        cleanupErrors.push(asError(error));
      }
    }
  }

  if (primaryError && cleanupErrors.length > 0) {
    throw new AggregateError(
      [primaryError, ...cleanupErrors],
      "Online acceptance failed and cleanup was incomplete.",
    );
  }
  if (primaryError) throw primaryError;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(
      cleanupErrors,
      "Online acceptance passed but cleanup was incomplete.",
    );
  }
}
