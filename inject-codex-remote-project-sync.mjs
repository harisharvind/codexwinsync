#!/usr/bin/env node

const port = Number.parseInt(process.argv[2] ?? "9322", 10);
const deadline = Date.now() + Number.parseInt(process.argv[3] ?? "30000", 10);
const endpoint = `http://127.0.0.1:${port}/json/list`;

const syncSource = String.raw`
(() => {
  const version = "codex-windows-remote-workspace-sync-v7";
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
    discoveredChatCount: 0,
    importedChatCount: 0,
    convertedProjectlessChatCount: 0,
    hydratedChatCount: 0,
    imports: [],
    chatImports: [],
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

  function pathContains(rootPath, candidatePath, windowsHost) {
    const root = normalizedPath(rootPath, windowsHost);
    const candidate = normalizedPath(candidatePath, windowsHost);
    return root.length > 0 && (candidate === root || candidate.startsWith(root + "/"));
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

  async function readRemoteState(connection) {
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
    const file = await requestAppServer(
      connection.hostId,
      "fs/readFile",
      { path: statePath },
      30000,
    );
    if (typeof file?.dataBase64 !== "string") {
      throw new Error("Remote Codex state file was unavailable");
    }

    const state = JSON.parse(decodeBase64Utf8(file.dataBase64));
    return {
      projects: projectsFromState(connection.hostId, state, connection),
    };
  }

  async function listRemoteThreads(connection) {
    const threads = [];
    const seenThreadIds = new Set();
    const seenCursors = new Set();
    let cursor = null;

    for (let page = 0; page < 100; page++) {
      const result = await requestAppServer(connection.hostId, "thread/list", {
        limit: 100,
        sortKey: "updated_at",
        ...(cursor == null ? {} : { cursor }),
      });
      const pageThreads = Array.isArray(result?.data) ? result.data : [];
      for (const thread of pageThreads) {
        if (
          typeof thread?.id !== "string" ||
          seenThreadIds.has(thread.id) ||
          thread.ephemeral === true
        ) continue;
        seenThreadIds.add(thread.id);
        threads.push(thread);
      }

      const nextCursor = typeof result?.nextCursor === "string" ? result.nextCursor : null;
      if (nextCursor == null || seenCursors.has(nextCursor)) break;
      seenCursors.add(nextCursor);
      cursor = nextCursor;
    }

    return threads;
  }

  function findProjectForThread(projects, hostId, cwd, windowsHost) {
    return projects
      .filter((project) => (
        project.hostId === hostId &&
        typeof project.remotePath === "string" &&
        pathContains(project.remotePath, cwd, windowsHost)
      ))
      .sort((left, right) => (
        normalizedPath(right.remotePath, windowsHost).length -
        normalizedPath(left.remotePath, windowsHost).length
      ))[0] ?? null;
  }

  function findQueryClient() {
    const root = globalThis.__codexRoot;
    if (root == null) return null;
    const seen = new WeakSet();
    const stack = [root];
    let visited = 0;

    while (stack.length > 0 && visited < 10000) {
      const value = stack.pop();
      if (
        value == null ||
        (typeof value !== "object" && typeof value !== "function") ||
        seen.has(value)
      ) continue;
      seen.add(value);
      visited++;

      if (
        typeof value.getQueryCache === "function" &&
        typeof value.invalidateQueries === "function"
      ) return value;

      let descriptors;
      try {
        descriptors = Object.getOwnPropertyDescriptors(value);
      } catch {
        continue;
      }
      for (const descriptor of Object.values(descriptors)) {
        if ("value" in descriptor) stack.push(descriptor.value);
      }
    }
    return null;
  }

  let internalRequestPromise = null;
  async function getInternalRequest() {
    if (internalRequestPromise != null) return internalRequestPromise;

    internalRequestPromise = (async () => {
      const mainScriptUrl = Array.from(document.scripts)
        .map((script) => script.src)
        .find((source) => /\/assets\/index-[^/]+\.js$/u.test(source));
      if (mainScriptUrl == null) throw new Error("Codex application script was unavailable");

      const mainSource = await fetch(mainScriptUrl).then((response) => {
        if (!response.ok) throw new Error("Could not inspect the Codex application script");
        return response.text();
      });
      const modulePath = mainSource.match(
        /\.\/broadcast-query-cache-invalidation-[A-Za-z0-9_-]+\.js/u,
      )?.[0];
      if (modulePath == null) throw new Error("Codex internal request module was unavailable");

      const internalModule = await import(new URL(modulePath, mainScriptUrl).href);
      const request = Object.values(internalModule).find((value) => (
        typeof value === "function" && /\.sendRequest\(/u.test(String(value))
      ));
      if (request == null) throw new Error("Codex internal request function was unavailable");
      return request;
    })();

    try {
      return await internalRequestPromise;
    } catch (error) {
      internalRequestPromise = null;
      throw error;
    }
  }

  async function hydrateRemoteChats(hostSnapshots) {
    const request = await getInternalRequest();
    let hydratedChatCount = 0;

    for (const { connection, threads } of hostSnapshots) {
      const threadIds = threads
        .map((thread) => thread?.id)
        .filter((threadId) => typeof threadId === "string");
      if (threadIds.length === 0) continue;

      await request("hydrate-pinned-threads", {
        hostId: connection.hostId,
        threadIds,
      });
      await request("refresh-recent-conversations-for-host", {
        hostId: connection.hostId,
        mode: "expanded",
        sortKey: "updated_at",
      });
      hydratedChatCount += threadIds.length;
    }

    return hydratedChatCount;
  }

  function refreshRemoteChatQueries() {
    const queryClient = findQueryClient();
    if (queryClient == null) return false;
    void queryClient.invalidateQueries({
      predicate(query) {
        return query.queryKey?.[0] === "recent-conversations-meta";
      },
    });
    return true;
  }

  async function syncRemoteProjects() {
    if (status.running) return { ...status };
    status.running = true;
    status.lastError = null;
    status.discoveredProjectCount = 0;
    status.importedProjectCount = 0;
    status.discoveredChatCount = 0;
    status.importedChatCount = 0;
    status.convertedProjectlessChatCount = 0;
    status.hydratedChatCount = 0;
    status.imports = [];
    status.chatImports = [];
    status.skippedHosts = [];

    try {
      const connections = getConnections();
      status.connectedHostCount = connections.length;

      const remoteProjectState = await fetchFromCodex("get-global-state", { key: "remote-projects" });
      const projectOrderState = await fetchFromCodex("get-global-state", { key: "project-order" });
      const assignmentState = await fetchFromCodex("get-global-state", { key: "thread-project-assignments" });
      const projectlessState = await fetchFromCodex("get-global-state", { key: "projectless-thread-ids" });
      const existing = Array.isArray(remoteProjectState?.value) ? remoteProjectState.value : [];
      const existingOrder = Array.isArray(projectOrderState?.value) ? projectOrderState.value : [];
      const existingAssignments = assignmentState?.value && typeof assignmentState.value === "object"
        ? assignmentState.value
        : {};
      const existingProjectlessThreadIds = Array.isArray(projectlessState?.value)
        ? projectlessState.value
        : [];

      const candidates = [];
      const hostSnapshots = [];
      for (const connection of connections) {
        let remoteState = { projects: [] };
        let threads = [];
        try {
          remoteState = await readRemoteState(connection);
          candidates.push(...remoteState.projects);
        } catch (error) {
          status.skippedHosts.push({
            hostId: connection.hostId,
            stage: "project-state",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        try {
          threads = await listRemoteThreads(connection);
        } catch (error) {
          status.skippedHosts.push({
            hostId: connection.hostId,
            stage: "thread-list",
            error: error instanceof Error ? error.message : String(error),
          });
        }

        const knownProjects = [...existing, ...candidates];
        for (const thread of threads) {
          const cwd = thread?.cwd;
          if (
            typeof cwd !== "string" ||
            cwd.length === 0 ||
            cwd === "~" ||
            findProjectForThread(
              knownProjects,
              connection.hostId,
              cwd,
              isWindowsHost(connection),
            ) != null
          ) continue;

          const candidate = {
            hostId: connection.hostId,
            remotePath: cwd,
            label: pathLabel(cwd),
            windowsHost: isWindowsHost(connection),
          };
          candidates.push(candidate);
          knownProjects.push(candidate);
        }

        hostSnapshots.push({ connection, threads });
      }
      status.discoveredProjectCount = candidates.length;
      status.discoveredChatCount = hostSnapshots.reduce(
        (total, snapshot) => total + snapshot.threads.length,
        0,
      );
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

      const allRemoteProjects = [...imported, ...existing];
      const nextAssignments = { ...existingAssignments };
      const projectlessThreadIdSet = new Set(existingProjectlessThreadIds);
      const convertedProjectlessThreadIds = new Set();
      const chatImports = [];

      for (const { connection, threads } of hostSnapshots) {
        const windowsHost = isWindowsHost(connection);
        for (const thread of threads) {
          if (nextAssignments[thread.id] == null && typeof thread.cwd === "string") {
            const project = findProjectForThread(
              allRemoteProjects,
              connection.hostId,
              thread.cwd,
              windowsHost,
            );
            if (project != null) {
              nextAssignments[thread.id] = {
                projectKind: "remote",
                projectId: project.id,
                path: project.remotePath,
                hostId: connection.hostId,
                pendingCoreUpdate: false,
              };
              chatImports.push({
                threadId: thread.id,
                hostId: connection.hostId,
                projectId: project.id,
              });
            }
          }

          if (
            nextAssignments[thread.id]?.projectKind === "remote" &&
            projectlessThreadIdSet.delete(thread.id)
          ) {
            convertedProjectlessThreadIds.add(thread.id);
          }
        }
      }

      if (chatImports.length > 0) {
        await fetchFromCodex("set-global-state", {
          key: "thread-project-assignments",
          value: nextAssignments,
        });
      }
      if (convertedProjectlessThreadIds.size > 0) {
        await fetchFromCodex("set-global-state", {
          key: "projectless-thread-ids",
          value: [...projectlessThreadIdSet],
        });
      }

      status.importedProjectCount = imported.length;
      status.importedChatCount = new Set([
        ...chatImports.map((chat) => chat.threadId),
        ...convertedProjectlessThreadIds,
      ]).size;
      status.convertedProjectlessChatCount = convertedProjectlessThreadIds.size;
      status.imports = imported.map(({ hostId, label, remotePath }) => ({ hostId, label, remotePath }));
      status.chatImports = chatImports;
      try {
        status.hydratedChatCount = await hydrateRemoteChats(hostSnapshots);
      } catch (error) {
        status.skippedHosts.push({
          hostId: "desktop",
          stage: "chat-cache",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      status.lastRunAt = new Date().toISOString();
      refreshRemoteChatQueries();
      return { ...status, running: false };
    } catch (error) {
      status.lastError = error instanceof Error ? error.message : String(error);
      status.lastRunAt = new Date().toISOString();
      return { ...status, running: false };
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
        console.log(`Installed remote workspace sync in ${target.title || target.url || "Codex"}.`);
      } catch (error) {
        lastError = error;
      }
    }

    if (injectedTargets.size > 0 && await hasInstalledSync(targets)) {
      console.log("Codex remote workspace metadata sync is active.");
      return;
    }
    await delay(250);
  }

  if (injectedTargets.size === 0) {
    throw new Error(`Timed out waiting for Codex renderer debugging on port ${port}: ${lastError?.message ?? "no target"}`);
  }
  throw new Error(lastError?.message ?? "Remote workspace sync did not become active");
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
