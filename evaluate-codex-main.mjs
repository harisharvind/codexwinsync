#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const port = Number.parseInt(process.argv[2] ?? "9333", 10);
const expression = process.argv[3] === "--file"
  ? await readFile(process.argv[4], "utf8")
  : Buffer.from(process.argv[3] ?? "", "base64").toString("utf8");
const targetType = process.argv[3] === "--file"
  ? process.argv[5] ?? "node"
  : process.argv[4] ?? "node";
const endpoint = `http://127.0.0.1:${port}/json/list`;
const deadline = Date.now() + 30000;

async function main() {
  let lastError = null;

  while (Date.now() < deadline) {
    try {
      const response = await fetch(endpoint);
      const targets = await response.json();
      const target = targets.find((candidate) => (
        candidate.type === targetType && candidate.url === "app://-/index.html"
      )) ?? targets.find((candidate) => candidate.type === targetType);
      if (target?.webSocketDebuggerUrl) {
        const result = await evaluate(target.webSocketDebuggerUrl, expression);
        process.stdout.write(JSON.stringify(result));
        return;
      }
    } catch (error) {
      lastError = error;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(lastError?.message ?? "Timed out waiting for Codex main-process inspector");
}

function evaluate(webSocketUrl, source) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("Timed out evaluating Codex main-process expression"));
    }, 15000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({
        id: 1,
        method: "Runtime.evaluate",
        params: {
          expression: source,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) {
        reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text ?? "Main-process evaluation failed"));
      } else {
        resolve(message.result?.result?.value);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error("WebSocket error while evaluating Codex main process"));
    });
  });
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
