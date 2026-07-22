(() => {
  const version = "codex-windows-remote-control-runtime-v1";
  if (globalThis.__codexWindowsRemoteControlRuntime?.version === version) {
    return globalThis.__codexWindowsRemoteControlRuntime.status;
  }

  const moduleApi = process.getBuiltinModule("module");
  const crypto = process.getBuiltinModule("crypto");
  const fs = process.getBuiltinModule("fs");
  const os = process.getBuiltinModule("os");
  const path = process.getBuiltinModule("path");
  const { execFileSync } = process.getBuiltinModule("child_process");
  const originalLoad = moduleApi._load;
  const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  const originalPlatform = process.platform;
  const algorithm = "ecdsa_p256_sha256";
  const protectionClass = "os_protected_nonextractable";
  const storePath = path.join(
    process.env.CODEX_HOME || path.join(os.homedir(), ".codex"),
    "remote-control-device-keys.windows.json",
  );

  function dpapi(protect, base64Input) {
    const command =
      "Add-Type -AssemblyName System.Security; " +
      "$d=[Convert]::FromBase64String([Console]::In.ReadToEnd()); " +
      "[Console]::Out.Write([Convert]::ToBase64String(" +
      "[System.Security.Cryptography.ProtectedData]::" +
      (protect ? "Protect" : "Unprotect") +
      "($d,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)))";

    return execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", command],
      {
        input: base64Input,
        encoding: "utf8",
        windowsHide: true,
        timeout: 15000,
        maxBuffer: 4 * 1024 * 1024,
      },
    ).trim();
  }

  function readStore() {
    try {
      return JSON.parse(fs.readFileSync(storePath, "utf8"));
    } catch {
      return {};
    }
  }

  function writeStore(store) {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, JSON.stringify(store), { mode: 0o600 });
    try {
      fs.chmodSync(storePath, 0o600);
    } catch {}
  }

  function requireEntry(keyId) {
    const entry = readStore()[keyId];
    if (!entry) throw new Error("device key not found");
    return entry;
  }

  function publicView(entry) {
    return {
      algorithm: entry.algorithm,
      keyId: entry.keyId,
      protectionClass: entry.protectionClass,
      publicKeySpkiDerBase64: entry.publicKeySpkiDerBase64,
    };
  }

  const shim = {
    async createDeviceKey() {
      const pair = crypto.generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const keyId = `dk_osn_${crypto.randomBytes(16).toString("hex")}`;
      const entry = {
        algorithm,
        keyId,
        protectionClass,
        publicKeySpkiDerBase64: pair.publicKey
          .export({ type: "spki", format: "der" })
          .toString("base64"),
      };
      const privateKeyBase64 = Buffer.from(
        pair.privateKey.export({ type: "pkcs8", format: "pem" }),
        "utf8",
      ).toString("base64");
      const store = readStore();
      store[keyId] = {
        ...entry,
        encryptedPrivateKeyBase64: dpapi(true, privateKeyBase64),
      };
      writeStore(store);
      return entry;
    },

    async deleteDeviceKey(keyId) {
      const store = readStore();
      delete store[keyId];
      writeStore(store);
    },

    async getDeviceKeyPublic(keyId) {
      return publicView(requireEntry(keyId));
    },

    async signDeviceKey(keyId, payload) {
      const entry = requireEntry(keyId);
      const privateKeyPem = Buffer.from(
        dpapi(false, entry.encryptedPrivateKeyBase64),
        "base64",
      ).toString("utf8");
      return {
        algorithm,
        signatureDerBase64: crypto
          .sign("sha256", payload, privateKeyPem)
          .toString("base64"),
      };
    },
  };

  moduleApi._load = function loadWithRemoteControlShim(request, parent, isMain) {
    if (typeof request === "string" && /(?:^|[\\/])remote-control-device-key\.node$/u.test(request)) {
      return shim;
    }
    return originalLoad.call(this, request, parent, isMain);
  };

  Object.defineProperty(process, "platform", {
    configurable: true,
    enumerable: originalPlatformDescriptor?.enumerable ?? true,
    get() {
      return new Error().stack?.includes(".getAddon") ? "darwin" : originalPlatform;
    },
  });

  const status = {
    installed: true,
    version,
    normalPlatform: process.platform,
    storePath,
  };
  globalThis.__codexWindowsRemoteControlRuntime = {
    originalLoad,
    originalPlatformDescriptor,
    shim,
    status,
    version,
  };
  return status;
})()
