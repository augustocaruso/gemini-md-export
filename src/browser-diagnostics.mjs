import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { isAbsolute, resolve } from 'node:path';

export const NATIVE_HOST_NAME = 'com.augustocaruso.gemini_md_export';
export const EXTENSION_DISPLAY_NAME = 'Gemini Chat -> Markdown Export';

export const normalizeBrowserKey = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return 'chrome';
  if (/^(google[-_\s]*)?chrome$|chrome\.exe$/.test(text)) return 'chrome';
  if (/^edge$|microsoft[-_\s]*edge|msedge(\.exe)?$/.test(text)) return 'edge';
  if (/^brave$|brave[-_\s]*browser|brave(\.exe)?$/.test(text)) return 'brave';
  if (/^dia$|dia(\.exe)?$/.test(text)) return 'dia';
  return text;
};

const readJsonSafe = (filePath) => {
  try {
    return { ok: true, value: JSON.parse(readFileSync(filePath, 'utf-8')) };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
};

const cleanPath = (value) => String(value || '').replace(/\/+$/, '');

const samePath = (a, b) => {
  const left = cleanPath(a);
  const right = cleanPath(b);
  return !!left && !!right && left === right;
};

export const browserProfileRoot = ({
  browser = 'chrome',
  platform = osPlatform(),
  home = homedir(),
  env = process.env,
} = {}) => {
  const key = normalizeBrowserKey(browser);
  if (platform === 'darwin') {
    const base = resolve(home, 'Library', 'Application Support');
    if (key === 'edge') return resolve(base, 'Microsoft Edge');
    if (key === 'brave') return resolve(base, 'BraveSoftware', 'Brave-Browser');
    if (key === 'dia') return resolve(base, 'Dia', 'User Data');
    return resolve(base, 'Google', 'Chrome');
  }
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || resolve(home, 'AppData', 'Local');
    if (key === 'edge') return resolve(localAppData, 'Microsoft', 'Edge', 'User Data');
    if (key === 'brave') {
      return resolve(localAppData, 'BraveSoftware', 'Brave-Browser', 'User Data');
    }
    if (key === 'dia') return resolve(localAppData, 'Dia', 'User Data');
    return resolve(localAppData, 'Google', 'Chrome', 'User Data');
  }
  const configHome = env.XDG_CONFIG_HOME || resolve(home, '.config');
  if (key === 'edge') return resolve(configHome, 'microsoft-edge');
  if (key === 'brave') return resolve(configHome, 'BraveSoftware', 'Brave-Browser');
  if (key === 'dia') return resolve(configHome, 'Dia');
  return resolve(configHome, 'google-chrome');
};

export const nativeHostManifestDirectory = ({
  browser = 'chrome',
  platform = osPlatform(),
  home = homedir(),
  env = process.env,
} = {}) => {
  const key = normalizeBrowserKey(browser);
  if (platform === 'darwin') {
    const base = resolve(home, 'Library', 'Application Support');
    if (key === 'edge') return resolve(base, 'Microsoft Edge', 'NativeMessagingHosts');
    if (key === 'brave') {
      return resolve(base, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts');
    }
    if (key === 'dia') return resolve(base, 'Dia', 'NativeMessagingHosts');
    return resolve(base, 'Google', 'Chrome', 'NativeMessagingHosts');
  }
  if (platform === 'win32') {
    return resolve(
      env.LOCALAPPDATA || resolve(home, 'AppData', 'Local'),
      'gemini-md-export',
      'NativeMessagingHosts',
    );
  }
  const configHome = env.XDG_CONFIG_HOME || resolve(home, '.config');
  if (key === 'edge') return resolve(configHome, 'microsoft-edge', 'NativeMessagingHosts');
  if (key === 'brave') {
    return resolve(configHome, 'BraveSoftware', 'Brave-Browser', 'NativeMessagingHosts');
  }
  if (key === 'dia') return resolve(configHome, 'Dia', 'NativeMessagingHosts');
  return resolve(configHome, 'google-chrome', 'NativeMessagingHosts');
};

export const nativeHostRegistryKey = ({ browser = 'chrome' } = {}) => {
  const key = normalizeBrowserKey(browser);
  if (key === 'edge') return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  if (key === 'brave') {
    return `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  }
  if (key === 'dia') return `HKCU\\Software\\Dia\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
  return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
};

export const nativeHostManifestPath = (options = {}) =>
  resolve(nativeHostManifestDirectory(options), `${NATIVE_HOST_NAME}.json`);

export const securePreferencesPath = ({
  browser = 'chrome',
  profileDirectory = 'Default',
  platform = osPlatform(),
  home = homedir(),
  env = process.env,
} = {}) => {
  const root = browserProfileRoot({ browser, platform, home, env });
  return resolve(root, profileDirectory || 'Default', 'Secure Preferences');
};

const resolveExtensionPathFromPrefs = (profileRoot, storedPath) => {
  if (!storedPath) return null;
  if (isAbsolute(storedPath)) return storedPath;
  return resolve(profileRoot, 'Extensions', storedPath);
};

const expectedBrowserExtensionDir = (root) =>
  [
    resolve(root, 'browser-extension'),
    resolve(root, 'dist', 'extension'),
  ].find((candidate) => existsSync(candidate)) || resolve(root, 'browser-extension');

export const discoverLoadedExtension = ({
  browser = 'chrome',
  profileDirectory = 'Default',
  packageRoot,
  extensionId = '',
  platform = osPlatform(),
  home = homedir(),
  env = process.env,
} = {}) => {
  const key = normalizeBrowserKey(browser);
  const root = browserProfileRoot({ browser: key, platform, home, env });
  const securePrefsPath = securePreferencesPath({
    browser: key,
    profileDirectory,
    platform,
    home,
    env,
  });
  const expectedPath = expectedBrowserExtensionDir(packageRoot);
  if (!existsSync(securePrefsPath)) {
    return {
      ok: false,
      status: 'secure-preferences-missing',
      browser: key,
      profileDirectory,
      securePreferencesPath: securePrefsPath,
      expectedExtensionPath: expectedPath,
      extension: null,
    };
  }

  const prefs = readJsonSafe(securePrefsPath);
  if (!prefs.ok) {
    return {
      ok: false,
      status: 'secure-preferences-invalid',
      browser: key,
      profileDirectory,
      securePreferencesPath: securePrefsPath,
      expectedExtensionPath: expectedPath,
      error: prefs.error,
      extension: null,
    };
  }

  const settings = prefs.value?.extensions?.settings || {};
  const candidates = Object.entries(settings).map(([id, setting]) => {
    const resolvedPath = resolveExtensionPathFromPrefs(root, setting.path);
    const manifestPath = resolvedPath ? resolve(resolvedPath, 'manifest.json') : null;
    const manifest = manifestPath && existsSync(manifestPath) ? readJsonSafe(manifestPath) : null;
    const manifestValue = manifest?.ok ? manifest.value : null;
    let score = 0;
    if (extensionId && id === extensionId) score += 100;
    if (samePath(resolvedPath, expectedPath)) score += 80;
    if (String(resolvedPath || '').includes('gemini-md-export')) score += 40;
    if (manifestValue?.name === EXTENSION_DISPLAY_NAME) score += 40;
    if (manifestValue?.version) score += 1;
    return {
      id,
      score,
      location: setting.location ?? null,
      state: setting.state ?? null,
      fromWebstore: setting.from_webstore === true,
      securePrefsPath: setting.path || null,
      path: resolvedPath,
      manifestPath,
      manifestVersion: manifestValue?.manifest_version ?? null,
      version: manifestValue?.version ?? null,
      name: manifestValue?.name || null,
      manifestReadError: manifest && !manifest.ok ? manifest.error : null,
    };
  });

  const selected = candidates
    .filter((candidate) => candidate.score > 0)
    .sort((a, b) => b.score - a.score)[0] || null;
  if (!selected) {
    return {
      ok: false,
      status: 'extension-not-found',
      browser: key,
      profileDirectory,
      securePreferencesPath: securePrefsPath,
      expectedExtensionPath: expectedPath,
      extension: null,
    };
  }

  return {
    ok: true,
    status: 'found',
    browser: key,
    profileDirectory,
    securePreferencesPath: securePrefsPath,
    expectedExtensionPath: expectedPath,
    extension: {
      ...selected,
      locationKind:
        selected.location === 1
          ? 'webstore'
          : selected.location === 4
            ? 'unpacked'
            : selected.location === null
              ? null
              : 'other',
      pathMatchesExpected: samePath(selected.path, expectedPath),
    },
  };
};

export const diagnoseNativeHost = ({
  browser = 'chrome',
  extensionId = '',
  packageRoot,
  platform = osPlatform(),
  home = homedir(),
  env = process.env,
} = {}) => {
  const key = normalizeBrowserKey(browser);
  const manifestPath = nativeHostManifestPath({ browser: key, platform, home, env });
  const expectedHostPath = resolve(packageRoot, 'bin', 'gemini-md-export-native-host.mjs');
  const registryKey = platform === 'win32' ? nativeHostRegistryKey({ browser: key }) : null;
  if (!existsSync(manifestPath)) {
    return {
      ok: false,
      status: 'missing',
      browser: key,
      manifestPath,
      registryKey,
      expectedHostPath,
      extensionId: extensionId || null,
      nextAction: `Instale o Native Messaging host para ${key}.`,
    };
  }

  const manifest = readJsonSafe(manifestPath);
  if (!manifest.ok) {
    return {
      ok: false,
      status: 'invalid-json',
      browser: key,
      manifestPath,
      registryKey,
      expectedHostPath,
      extensionId: extensionId || null,
      error: manifest.error,
      nextAction: 'Recrie o manifesto Native Messaging.',
    };
  }

  const allowedOrigins = Array.isArray(manifest.value.allowed_origins)
    ? manifest.value.allowed_origins
    : [];
  const expectedOrigin = extensionId ? `chrome-extension://${extensionId}/` : null;
  const originMatches = expectedOrigin ? allowedOrigins.includes(expectedOrigin) : null;
  const pathMatches = samePath(manifest.value.path, expectedHostPath);
  const hostExecutableExists = !!manifest.value.path && existsSync(manifest.value.path);
  const ok =
    manifest.value.name === NATIVE_HOST_NAME &&
    pathMatches &&
    hostExecutableExists &&
    (originMatches === true || originMatches === null);
  return {
    ok,
    status: ok ? 'ready' : 'mismatch',
    browser: key,
    manifestPath,
    registryKey,
    extensionId: extensionId || null,
    expectedOrigin,
    allowedOrigins,
    expectedHostPath,
    actualHostPath: manifest.value.path || null,
    pathMatches,
    hostExecutableExists,
    originMatches,
    nextAction: ok
      ? 'Native host registrado.'
      : 'Repare o manifesto Native Messaging para este navegador/perfil.',
  };
};

export const buildLocalDoctorReport = ({
  browser,
  profileDirectory = 'Default',
  extensionId = '',
  packageRoot,
  version,
  platform = osPlatform(),
  home = homedir(),
  env = process.env,
} = {}) => {
  const key = normalizeBrowserKey(browser || env.GEMINI_MCP_BROWSER || env.GME_BROWSER || 'chrome');
  const loaded = discoverLoadedExtension({
    browser: key,
    profileDirectory,
    packageRoot,
    extensionId,
    platform,
    home,
    env,
  });
  const id = extensionId || loaded.extension?.id || '';
  const nativeHost = diagnoseNativeHost({
    browser: key,
    extensionId: id,
    packageRoot,
    platform,
    home,
    env,
  });
  const sourceManifestPath = resolve(expectedBrowserExtensionDir(packageRoot), 'manifest.json');
  const sourceManifest = existsSync(sourceManifestPath) ? readJsonSafe(sourceManifestPath) : null;
  const sourceVersion = sourceManifest?.ok ? sourceManifest.value.version : version || null;
  const runtimeVersion = loaded.extension?.version || null;
  const versionMatches =
    !!runtimeVersion && !!sourceVersion && String(runtimeVersion) === String(sourceVersion);
  const warnings = [];
  if (!loaded.ok) warnings.push('extensao_nao_encontrada_no_perfil');
  if (loaded.ok && !versionMatches) warnings.push('runtime_versao_diferente_dos_arquivos');
  if (!nativeHost.ok) warnings.push(`native_host_${nativeHost.status}`);
  const nextAction = (() => {
    if (!loaded.ok) return 'Carregue a extensão unpacked correta neste navegador/perfil.';
    if (!versionMatches) return 'Recarregue o card da extensão e a aba Gemini.';
    if (!nativeHost.ok) return nativeHost.nextAction;
    return 'Diagnóstico local ok.';
  })();
  return {
    ok: loaded.ok && versionMatches && nativeHost.ok,
    browser: key,
    profileDirectory,
    packageRoot,
    sourceVersion,
    sourceManifestPath,
    loadedExtension: loaded,
    nativeHost,
    warnings,
    nextAction,
  };
};
