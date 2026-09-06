export const restartExecutionId = "execution-restart-orphan-e2e";
const restartPayloadHandle = "payload-restart-orphan-e2e";
const previousSessionId = "previous-chrome-session-e2e";

export async function seedRestartOrphanCandidate(client, requestTemplate) {
  return client.evaluate(`(async () => {
    const now = new Date().toISOString();
    const request = {
      ...${JSON.stringify(requestTemplate)},
      id: "request-restart-orphan-e2e",
      name: "Chrome restart orphan probe",
    };
    const execution = {
      summary: {
        schemaVersion: 1,
        executionId: ${JSON.stringify(restartExecutionId)},
        requestId: request.id,
        executor: "browser",
        state: "running",
        retention: "10m",
        revision: 1,
        progress: {
          phase: "waiting",
          loadedBytes: 0,
          elapsedMs: 25,
        },
        createdAt: now,
        updatedAt: now,
      },
      sessionId: ${JSON.stringify(previousSessionId)},
    };
    const payload = {
      schemaVersion: 1,
      handle: ${JSON.stringify(restartPayloadHandle)},
      executionId: execution.summary.executionId,
      request,
      target: { kind: "browser" },
      responseLimitBytes: 20 * 1024 * 1024,
      createdAt: now,
    };
    const db = await new Promise((resolveOpen, reject) => {
      const open = indexedDB.open("xpanel");
      open.onsuccess = () => resolveOpen(open.result);
      open.onerror = () => reject(open.error);
    });
    const transaction = db.transaction(
      ["executions", "execution-payloads"],
      "readwrite",
    );
    transaction.objectStore("executions").put(execution);
    transaction.objectStore("execution-payloads").put(payload);
    await new Promise((resolveDone, reject) => {
      transaction.oncomplete = resolveDone;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();
    return true;
  })()`);
}

export async function restartOrphanSnapshot(client) {
  return client.evaluate(`(async () => {
    const db = await new Promise((resolveOpen, reject) => {
      const open = indexedDB.open("xpanel");
      open.onsuccess = () => resolveOpen(open.result);
      open.onerror = () => reject(open.error);
    });
    const transaction = db.transaction(
      ["executions", "execution-payloads"],
      "readonly",
    );
    const read = (store, key) => new Promise((resolveRead, reject) => {
      const request = transaction.objectStore(store).get(key);
      request.onsuccess = () => resolveRead(request.result);
      request.onerror = () => reject(request.error);
    });
    const [execution, payload] = await Promise.all([
      read("executions", ${JSON.stringify(restartExecutionId)}),
      read("execution-payloads", ${JSON.stringify(restartPayloadHandle)}),
    ]);
    db.close();
    return { execution, payload };
  })()`);
}

export function isRecoveredRestartOrphan(snapshot) {
  return (
    snapshot?.execution?.summary?.state === "orphaned" &&
    snapshot.execution.summary.error?.code === "orphaned" &&
    snapshot.execution.sessionId !== previousSessionId &&
    snapshot.payload === undefined
  );
}
