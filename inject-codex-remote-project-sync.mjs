#!/usr/bin/env node

const port = Number.parseInt(process.argv[2] ?? "9322", 10);
const deadline = Date.now() + Number.parseInt(process.argv[3] ?? "30000", 10);
const endpoint = `http://127.0.0.1:${port}/json/list`;

const syncSource = String.raw`
(() => {
  const version = "codex-windows-remote-project-sync-v2";
  const intervalMilliseconds = 30000;

  if (globalThis.__codexRemoteProjectSyncVersion === version) {
    globalThis.__codexRemoteProjectSyncNow?.();
    return true;
  }

  if (globalThis.__codexRemoteProjectSyncInterval != null) {
    clearInterval(globalThis.__codexRemoteProjectSyncInterval);
  }

  const status = {
    installed: true,
    version,
    running: false,
    lastRunAt: null,
    lastError: null,
    connectedHostCount: 0,
    discoveredProjectCount: 0,
    importedProjectCount: 0,
    imports: [],
    skippedHosts: [],
  };

  function fetchFromCodex(route, params, timeoutMilliseconds = 12000) {
    return new Promise((resolve, reject) => {
      const requestId = "remote-project-sync-fetch-" + crypto.randomUUID();
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out calling " + route));
      }, timeoutMilliseconds);

      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      }

      function onMessage(event) {
        const response = event.data;
        if (response?.type !== "fetch-response" || response.requestId !== requestId) return;
        cleanup();

        if (response.responseType !== "success") {
          reject(new Error(response.bodyJsonString || "Codex request failed: " + route));
          return;
        }

        try {
          resolve(JSON.parse(response.bodyJsonString));
        } catch (error) {
          reject(error);
        }
      }

      window.addEventListener("message", onMessage);
      try {
        electronBridge.sendMessageFromView({
          type: "fetch",
          requestId,
          method: "POST",
          url: "vscode://codex/" + route,
          body: JSON.stringify(params),
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  function requestAppServer(hostId, method, params, timeoutMilliseconds = 12000) {
    return new Promise((resolve, reject) => {
      const id = "remote-project-sync-mcp-" + crypto.randomUUID();
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Timed out calling " + method));
      }, timeoutMilliseconds);

      function cleanup() {
        clearTimeout(timeout);
        window.removeEventListener("message", onMessage);
      }

      function onMessage(event) {
        const response = event.data;
        if (
          response?.type !== "mcp-response" ||
          response.hostId !== hostId ||
          response.message?.id !== id
        ) return;

        cleanup();
        if (response.message.error) {
          reject(new Error(response.message.error.message || method + " failed"));
        } else {
          resolve(response.message.result);
        }
      }

      window.addEventListener("message", onMessage);
      try {
        electronBridge.sendMessageFromView({
          type: "mcp-request",
          hostId,
          request: { id, method, params },
        });
      } catch (error) {
        cleanup();
        reject(error);
      }
    });
  }

  function decodeBase64Utf8(value) {
    const binary = atob(value);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }

  function getConnections() {
    const snapshot = electronBridge.getSharedObjectSnapshotValue?.("remote_control_connections");
    const connections = Array.isArray(snapshot) ? snapshot : Object.values(snapshot ?? {});
    return connections.filter((connection) => (
      connection &&
      typeof connection.hostId === "string" &&
      connection.hostId.length > 0 &&
      !["disconnected", "offline", "error"].includes(
        String(connection.state ?? connection.status ?? "").toLowerCase(),
      )
    ));
  }

  function isWindowsHost(connection) {
    return /windows|win32/iu.test([
      connection.platform,
      connection.platformFamily,
      connection.platformOs,
      connection.os,
      connection.osName,
    ].filter(Boolean).join(" "));
  }

  function joinRemotePath(homeDirectory, windowsHost, ...parts) {
    const separator = windowsHost ? "\\" : "/";
    const trimmedHome = homeDirectory.replace(/[\\/]+$/u, "");
    return [trimmedHome, ...parts].join(separator);
  }

  function pathLabel(remotePath) {
    return remotePath.split(/[\\/]/u).filter(Boolean).at(-1) || remotePath;
  }

  function normalizedPath(remotePath, windowsHost) {
    const normalized = remotePath.replace(/\\/gu, "/").replace(/\/+$/u, "");
    return windowsHost ? normalized.toLowerCase() : normalized;
  }

  function projectsFromState(hostId, state, connection) {
    const projects = state?.["local-projects"];
    const candidates = [];
    const seenPaths = new Set();

    for (const project of Object.values(projects ?? {})) {
      if (!project || typeof project !== "object") continue;
      const roots = Array.isArray(project.rootPaths) ? project.rootPaths : [];
      for (const rootPath of roots) {
        if (typeof rootPath !== "string" || rootPath.length === 0 || seenPaths.has(rootPath)) continue;
        seenPaths.add(rootPath);
        candidates.push({
          hostId,
          remotePath: rootPath,
          label: typeof project.name === "string" && project.name.trim()
            ? project.name.trim()
            : pathLabel(rootPath),
          windowsHost: isWindowsHost(connection),
        });
      }
    }

    for (const rootPath of state?.["electron-saved-workspace-roots"] ?? []) {
      if (typeof rootPath !== "string" || rootPath.length === 0 || seenPaths.has(rootPath)) continue;
      seenPaths.add(rootPath);
      candidates.push({
        hostId,
        remotePath: rootPath,
        label: pathLabel(rootPath),
        windowsHost: isWindowsHost(connection),
      });
    }

    return candidates;
  }

  async function readRemoteProjects(connection) {
    const homeResult = await fetchFromCodex("home-directory", { hostId: connection.hostId });
    const home = homeResult?.homeDirectory;
    if (typeof home !== "string" || home.length === 0) {
      throw new Error("Remote home directory was unavailable");
    }

    const statePath = joinRemotePath(
      home,
      isWindowsHost(connection),
      ".codex",
      ".codex-global-state.json",
    );
    const file = await requestAppServer(connection.hostId, "fs/readFile", { path: statePath });
    if (typeof file?.dataBase64 !== "string") {
      throw new Error("Remote Codex state file was unavailable");
    }

    return projectsFromState(
      connection.hostId,
      JSON.parse(decodeBase64Utf8(file.dataBase64)),
      connection,
    );
  }

  async function syncRemoteProjects() {
    if (status.running) return { ...status };
    status.running = true;
    status.lastError = null;
    status.imports = [];
    status.skippedHosts = [];

    try {
      const connections = getConnections();
      status.connectedHostCount = connections.length;

      const candidates = [];
      for (const connection of connections) {
        try {
          candidates.push(...await readRemoteProjects(connection));
        } catch (error) {
          status.skippedHosts.push({
            hostId: connection.hostId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      status.discoveredProjectCount = candidates.length;

      const remoteProjectState = await fetchFromCodex("get-global-state", { key: "remote-projects" });
      const projectOrderState = await fetchFromCodex("get-global-state", { key: "project-order" });
      const existing = Array.isArray(remoteProjectState?.value) ? remoteProjectState.value : [];
      const existingOrder = Array.isArray(projectOrderState?.value) ? projectOrderState.value : [];
      const existingKeys = new Set(existing.map((project) => {
        const connection = connections.find((item) => item.hostId === project.hostId);
        return project.hostId + "\n" + normalizedPath(
          project.remotePath ?? "",
          isWindowsHost(connection ?? {}),
        );
      }));

      const imported = [];
      for (const candidate of candidates) {
        const key = candidate.hostId + "\n" + normalizedPath(
          candidate.remotePath,
          candidate.windowsHost,
        );
        if (existingKeys.has(key)) continue;
        existingKeys.add(key);
        imported.push({
          id: crypto.randomUUID(),
          hostId: candidate.hostId,
          remotePath: candidate.remotePath,
          label: candidate.label,
        });
      }

      if (imported.length > 0) {
        await fetchFromCodex("set-global-state", {
          key: "remote-projects",
          value: [...imported, ...existing],
        });
        await fetchFromCodex("set-global-state", {
          key: "project-order",
          value: [...imported.map((project) => project.id), ...existingOrder],
        });
      }

      status.importedProjectCount = imported.length;
      status.imports = imported.map(({ hostId, label, remotePath }) => ({ hostId, label, remotePath }));
      status.lastRunAt = new Date().toISOString();
      return { ...status };
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      status.lastRunAt = new Date().toISOString();
      return { ...status };
    } finally {
      status.running = false;
    }
  }

  let scheduledSync = null;
  function scheduleSync(delayMilliseconds = 250) {
    if (scheduledSync !== null) clearTimeout(scheduledSync);
    scheduledSync = setTimeout(() => {
      scheduledSync = null;
      void syncRemoteProjects();
    }, delayMilliseconds);
  }

  window.addEventListener("message", (event) => {
    if (
      event.data?.type === "codex-app-server-connection-changed" ||
      (event.data?.type === "shared-object-updated" &&
        event.data?.key === "remote_control_connections")
    ) {
      scheduleSync(500);
    }
  });

  globalThis.__codexRemoteProjectSyncVersion = version;
  globalThis.__codexRemoteProjectSyncNow = syncRemoteProjects;
  globalThis.__codexRemoteProjectSyncProbe = () => ({ ...status });
  globalThis.__codexRemoteProjectSyncInterval = setInterval(
    () => scheduleSync(0),
    intervalMilliseconds,
  );
  scheduleSync(500);
  return true;
})()
`;

async function main() {
  const injectedTargets = new Set();
  let lastError = null;

  while (Date.now() < deadline) {
    let targets = [];
    try {
      targets = await listTargets();
    } catch (error) {
      lastError = error;
      await delay(250);
      continue;
    }

    for (const target of targets) {
      const targetKey = target.id ?? target.webSocketDebuggerUrl;
      if (injectedTargets.has(targetKey)) continue;
      try {
        await injectTarget(target);
        injectedTargets.add(targetKey);
        console.log(`Installed remote-project sync in ${target.title || target.url || "Codex"}.`);
      } catch (error) {
        lastError = error;
      }
    }

    if (injectedTargets.size > 0 && await hasInstalledSync(targets)) {
      console.log("Codex remote-project metadata sync is active.");
      return;
    }
    await delay(250);
  }

  if (injectedTargets.size === 0) {
    throw new Error(`Timed out waiting for Codex renderer debugging on port ${port}: ${lastError?.message ?? "no target"}`);
  }
  throw new Error(lastError?.message ?? "Remote-project sync did not become active");
}

async function hasInstalledSync(targets) {
  for (const target of targets) {
    try {
      const result = await sendDevtoolsCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "globalThis.__codexRemoteProjectSyncProbe?.() ?? null",
        awaitPromise: false,
        returnByValue: true,
      });
      if (result?.result?.value?.installed === true) return true;
    } catch {}
  }
  return false;
}

async function listTargets() {
  const response = await fetch(endpoint);
  const targets = await response.json();
  return targets.filter((target) => {
    if (!target.webSocketDebuggerUrl) return false;
    if (target.type !== "page" && target.type !== "webview") return false;
    const identity = `${target.url ?? ""} ${target.title ?? ""}`;
    return /codex|localhost|file:|app:/iu.test(identity);
  });
}

async function injectTarget(target) {
  await sendDevtoolsCommand(target.webSocketDebuggerUrl, "Page.addScriptToEvaluateOnNewDocument", {
    source: syncSource,
  });
  await sendDevtoolsCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: syncSource,
    awaitPromise: false,
    returnByValue: true,
  });
}

function sendDevtoolsCommand(webSocketUrl, method, params) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error(`Timed out while running ${method}`));
    }, 15000);

    socket.addEventListener("open", () => {
      socket.send(JSON.stringify({ id: 1, method, params }));
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== 1) return;
      clearTimeout(timeout);
      socket.close();
      if (message.error) {
        reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      } else if (message.result?.exceptionDetails) {
        reject(new Error(message.result.exceptionDetails.text ?? `${method} failed`));
      } else {
        resolve(message.result);
      }
    });

    socket.addEventListener("error", () => {
      clearTimeout(timeout);
      reject(new Error(`WebSocket error while running ${method}`));
    });
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
