#!/usr/bin/env node

const port = Number.parseInt(process.argv[2] ?? "9322", 10);
const deadline = Date.now() + Number.parseInt(process.argv[3] ?? "30000", 10);
const endpoint = `http://127.0.0.1:${port}/json/list`;

const overrideSource = String.raw`
(() => {
  const version = "codex-windows-remote-control-ui-v1";
  const gateName = "782640499";

  function getStatsigClients() {
    const statsig = globalThis.__STATSIG__;
    if (!statsig) return [];

    const clients = [];
    if (statsig.firstInstance) clients.push(statsig.firstInstance);
    if (statsig.instance) clients.push(statsig.instance);
    for (const instance of Object.values(statsig.instances ?? {})) {
      clients.push(instance);
    }

    return [...new Set(clients)].filter((client) => (
      client && (
        typeof client.checkGate === "function" ||
        typeof client.getFeatureGate === "function"
      )
    ));
  }

  function installOverride(client) {
    if (!client || client.__codexRemoteControlUiOverrideVersion === version) return false;

    const previous = client.overrideAdapter;
    const originalCheckGate = client.checkGate?.bind(client);
    const originalGetFeatureGate = client.getFeatureGate?.bind(client);

    client.overrideAdapter = {
      getGateOverride(gate, user, options) {
        if (gate?.name === gateName) {
          return {
            ...gate,
            value: false,
            ruleID: "local-control-other-devices-override",
          };
        }
        return previous?.getGateOverride?.(gate, user, options) ?? null;
      },
      getDynamicConfigOverride: previous?.getDynamicConfigOverride?.bind(previous),
      getExperimentOverride: previous?.getExperimentOverride?.bind(previous),
      getLayerOverride: previous?.getLayerOverride?.bind(previous),
      getParamStoreOverride: previous?.getParamStoreOverride?.bind(previous),
    };

    if (originalCheckGate) {
      client.checkGate = function checkGate(name, options) {
        if (name === gateName) return false;
        return originalCheckGate(name, options);
      };
    }

    if (originalGetFeatureGate) {
      client.getFeatureGate = function getFeatureGate(name, options) {
        const result = originalGetFeatureGate(name, options);
        if (name !== gateName) return result;
        return {
          ...result,
          name,
          value: false,
          ruleID: result?.ruleID ?? "local-control-other-devices-override",
        };
      };
    }

    client.__codexRemoteControlUiOverrideVersion = version;
    try {
      client.updateUserSync(client.getContext().user, { disableBackgroundCacheRefresh: true });
    } catch {}
    try {
      client.$emt?.({ name: "values_updated" });
    } catch {}
    return true;
  }

  function installAllOverrides() {
    return getStatsigClients().filter(installOverride).length;
  }

  if (!installAllOverrides()) {
    const interval = setInterval(() => {
      if (installAllOverrides()) clearInterval(interval);
    }, 250);
    setTimeout(() => clearInterval(interval), 30000);
  }

  globalThis.__codexRemoteControlUiOverrideProbe = () => {
    const clients = getStatsigClients();
    return {
      installed: clients.length > 0 && clients.every((client) => (
        client.__codexRemoteControlUiOverrideVersion === version
      )),
      values: clients.map((client) => (
        client.checkGate?.(gateName, { disableExposureLog: true })
      )),
    };
  };

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
      await injectTarget(target);
      injectedTargets.add(targetKey);
      console.log(`Injected Codex remote-control UI override into ${target.title || target.url || "Codex"}.`);
    }

    if (injectedTargets.size > 0 && await hasInstalledOverride(targets)) {
      console.log("Codex remote-control Statsig override is active.");
      return;
    }
    await delay(250);
  }

  if (injectedTargets.size === 0) {
    throw new Error(`Timed out waiting for Codex renderer debugging on port ${port}: ${lastError?.message ?? "no target"}`);
  }
}

async function hasInstalledOverride(targets) {
  for (const target of targets) {
    try {
      const result = await sendDevtoolsCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
        expression: "globalThis.__codexRemoteControlUiOverrideProbe?.() ?? null",
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
    source: overrideSource,
  });
  await sendDevtoolsCommand(target.webSocketDebuggerUrl, "Runtime.evaluate", {
    expression: overrideSource,
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
