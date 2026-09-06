import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export class CdpClient {
  #nextId = 0;
  #pending = new Map();

  constructor(url) {
    this.socket = new WebSocket(url);
  }

  async open() {
    await new Promise((resolveOpen, reject) => {
      this.socket.addEventListener("open", resolveOpen, { once: true });
      this.socket.addEventListener("error", reject, { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (typeof message.id !== "number") return;
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      if (message.error) {
        pending.reject(new Error(JSON.stringify(message.error)));
      } else {
        pending.resolve(message.result);
      }
    });
    this.socket.addEventListener("close", () => {
      for (const pending of this.#pending.values()) {
        pending.reject(new Error("Chrome closed the DevTools connection."));
      }
      this.#pending.clear();
    });
    return this;
  }

  send(method, params = {}) {
    const id = ++this.#nextId;
    this.socket.send(JSON.stringify({ id, method, params }));
    return new Promise((resolveResult, reject) => {
      this.#pending.set(id, { resolve: resolveResult, reject });
    });
  }

  async evaluate(expression, { userGesture = false } = {}) {
    const result = await this.send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.exception?.description ??
          result.exceptionDetails.text ??
          "Page evaluation failed.",
      );
    }
    return result.result.value;
  }

  close() {
    this.socket.close();
  }
}

export async function jsonEndpoint(port, path) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`);
  if (!response.ok) throw new Error(`Chrome endpoint ${path} failed.`);
  return response.json();
}

export function targets(port) {
  return jsonEndpoint(port, "/json/list");
}

export async function capturePng(client, filePath, width, height) {
  await client.send("Page.enable");
  await client.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  const { data } = await client.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: true,
    captureBeyondViewport: false,
  });
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, Buffer.from(data, "base64"));
}
