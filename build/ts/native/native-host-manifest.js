import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, platform as osPlatform } from 'node:os';
import { dirname, resolve } from 'node:path';
export const NATIVE_HOST_NAME = 'com.augustocaruso.gemini_md_export';
const argValue = (args, name, fallback = '') => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] || fallback : fallback;
};
const hasFlag = (args, name) => args.includes(name);
export const nativeHostManifestUsage = () => [
    'native-host-manifest',
    '',
    'Uso:',
    '  node scripts/native-host-manifest.mjs --extension-id <id> [--browser chrome|edge|brave|dia] [--install|--print]',
    '',
    'Gera o manifesto Native Messaging para o host com.augustocaruso.gemini_md_export.',
].join('\n');
const templatePathForRoot = (root) => resolve(root, 'native-messaging', 'com.augustocaruso.gemini_md_export.template.json');
const installedRootForHome = (homeDir) => resolve(homeDir, '.gemini', 'extensions', 'gemini-md-export');
const shellDoubleQuote = (value) => `"${String(value).replace(/["\\$`]/g, '\\$&')}"`;
const csharpStringLiteral = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const powershellSingleQuote = (value) => `'${String(value).replace(/'/g, "''")}'`;
const windowsLauncherSource = ({ nodePath, runtimePath, }) => `
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;

public static class Program {
  private const int STD_INPUT_HANDLE = -10;
  private const int STD_OUTPUT_HANDLE = -11;
  private const int STD_ERROR_HANDLE = -12;
  private const int STARTF_USESTDHANDLES = 0x00000100;
  private const uint INFINITE = 0xFFFFFFFF;

  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  private struct STARTUPINFO {
    public int cb; public string lpReserved; public string lpDesktop; public string lpTitle;
    public int dwX; public int dwY; public int dwXSize; public int dwYSize;
    public int dwXCountChars; public int dwYCountChars; public int dwFillAttribute;
    public int dwFlags; public short wShowWindow; public short cbReserved2;
    public IntPtr lpReserved2; public IntPtr hStdInput; public IntPtr hStdOutput; public IntPtr hStdError;
  }

  [StructLayout(LayoutKind.Sequential)]
  private struct PROCESS_INFORMATION {
    public IntPtr hProcess; public IntPtr hThread; public int dwProcessId; public int dwThreadId;
  }

  [DllImport("kernel32.dll", SetLastError = true)] private static extern IntPtr GetStdHandle(int nStdHandle);
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] private static extern bool CreateProcessW(string lpApplicationName, StringBuilder lpCommandLine, IntPtr lpProcessAttributes, IntPtr lpThreadAttributes, bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment, string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo, out PROCESS_INFORMATION lpProcessInformation);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern uint WaitForSingleObject(IntPtr hHandle, uint dwMilliseconds);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool GetExitCodeProcess(IntPtr hProcess, out uint lpExitCode);
  [DllImport("kernel32.dll", SetLastError = true)] private static extern bool CloseHandle(IntPtr hObject);

  private static string Quote(string value) { return "\\\"" + value.Replace("\\\"", "\\\\\\\"") + "\\\""; }

  public static int Main(string[] args) {
    string nodePath = ${csharpStringLiteral(nodePath)};
    string runtimePath = ${csharpStringLiteral(runtimePath)};
    var si = new STARTUPINFO();
    si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);
    var commandLine = new StringBuilder(Quote(nodePath) + " " + Quote(runtimePath));
    PROCESS_INFORMATION pi;
    bool ok = CreateProcessW(null, commandLine, IntPtr.Zero, IntPtr.Zero, true, 0, IntPtr.Zero, null, ref si, out pi);
    if (!ok) return new Win32Exception(Marshal.GetLastWin32Error()).NativeErrorCode;
    WaitForSingleObject(pi.hProcess, INFINITE);
    uint exitCode; if (!GetExitCodeProcess(pi.hProcess, out exitCode)) exitCode = 1;
    CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
    return unchecked((int)exitCode);
  }
}
`.trim();
export const macNativeHostDir = (homeDir, browser) => {
    const appName = browser === 'edge'
        ? 'Microsoft Edge'
        : browser === 'brave'
            ? 'BraveSoftware/Brave-Browser'
            : browser === 'dia'
                ? 'Dia'
                : 'Google/Chrome';
    return resolve(homeDir, 'Library', 'Application Support', appName, 'NativeMessagingHosts');
};
export const windowsRegistryKey = (browser) => {
    if (browser === 'edge')
        return `HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
    if (browser === 'brave') {
        return `HKCU\\Software\\BraveSoftware\\Brave-Browser\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
    }
    if (browser === 'dia')
        return `HKCU\\Software\\Dia\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
    return `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${NATIVE_HOST_NAME}`;
};
const resolveNativeHostPaths = ({ root, homeDir, env, currentPlatform, execPath, }) => {
    const installedRoot = installedRootForHome(homeDir);
    const defaultRoot = !env.GEMINI_MD_EXPORT_NATIVE_HOST_PATH &&
        existsSync(resolve(installedRoot, 'src', 'native-host.mjs'))
        ? installedRoot
        : root;
    const runtimePath = env.GEMINI_MD_EXPORT_NATIVE_HOST_PATH ||
        resolve(defaultRoot, 'bin', 'gemini-md-export-native-host.mjs');
    const windowsLauncherPath = env.GEMINI_MD_EXPORT_NATIVE_HOST_LAUNCHER_PATH ||
        resolve(defaultRoot, 'bin', 'gemini-md-export-native-host.exe');
    return {
        runtimePath,
        nativeRuntimePath: resolve(defaultRoot, 'src', 'native-host.mjs'),
        windowsLauncherPath,
        nodePath: env.GEMINI_MD_EXPORT_NODE_PATH || execPath,
        nativeHostPath: currentPlatform === 'win32' && !env.GEMINI_MD_EXPORT_NATIVE_HOST_PATH
            ? windowsLauncherPath
            : runtimePath,
    };
};
const renderMacLauncher = (nodePath, runtimePath) => [
    '#!/bin/sh',
    `exec ${shellDoubleQuote(nodePath)} ${shellDoubleQuote(runtimePath)} "$@"`,
    '',
].join('\n');
const writeMacLauncherIfNeeded = ({ launcherPath, nodePath, runtimePath, }) => {
    mkdirSync(dirname(launcherPath), { recursive: true });
    writeFileSync(launcherPath, renderMacLauncher(nodePath, runtimePath), 'utf-8');
    chmodSync(launcherPath, 0o755);
};
const writeWindowsLauncher = ({ launcherPath, nodePath, runtimePath, }) => {
    mkdirSync(dirname(launcherPath), { recursive: true });
    rmSync(launcherPath, { force: true });
    const source = windowsLauncherSource({ nodePath, runtimePath });
    const command = [
        '$ErrorActionPreference = "Stop"',
        `$source = @'\n${source}\n'@`,
        `Add-Type -TypeDefinition $source -Language CSharp -OutputAssembly ${powershellSingleQuote(launcherPath)} -OutputType ConsoleApplication`,
    ].join('\n');
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], { stdio: 'inherit' });
    if (result.status !== 0) {
        throw new Error(`windows_native_host_launcher_compile_failed:${result.status ?? 'unknown'}`);
    }
};
const buildManifest = ({ root, extensionId, nativeHostPath, }) => {
    const manifestTemplate = JSON.parse(readFileSync(templatePathForRoot(root), 'utf-8'));
    return {
        ...manifestTemplate,
        path: nativeHostPath,
        allowed_origins: (manifestTemplate.allowed_origins || []).map((origin) => String(origin).replace(/__EXTENSION_ID__/g, extensionId)),
    };
};
const print = (stdout, value) => {
    stdout.write(`${value}\n`);
};
export const runNativeHostManifestCli = ({ argv, root, homeDir = homedir(), platform = osPlatform(), env = process.env, execPath = process.execPath, stdout = process.stdout, }) => {
    const browser = String(argValue(argv, '--browser', 'chrome')).toLowerCase();
    const extensionId = String(argValue(argv, '--extension-id', '')).trim();
    if (hasFlag(argv, '--help') || !extensionId) {
        print(stdout, nativeHostManifestUsage());
        return extensionId ? 0 : 64;
    }
    const paths = resolveNativeHostPaths({ root, homeDir, env, currentPlatform: platform, execPath });
    const manifest = buildManifest({ root, extensionId, nativeHostPath: paths.nativeHostPath });
    if (!hasFlag(argv, '--install')) {
        print(stdout, JSON.stringify(manifest, null, 2));
        return 0;
    }
    if (platform === 'darwin') {
        const launcherPath = resolve(dirname(paths.runtimePath), 'gemini-md-export-native-host-launcher.sh');
        writeMacLauncherIfNeeded({
            launcherPath,
            nodePath: paths.nodePath,
            runtimePath: paths.runtimePath,
        });
        const installManifest = buildManifest({ root, extensionId, nativeHostPath: launcherPath });
        const dir = macNativeHostDir(homeDir, browser);
        mkdirSync(dir, { recursive: true });
        const target = resolve(dir, `${NATIVE_HOST_NAME}.json`);
        writeFileSync(target, `${JSON.stringify(installManifest, null, 2)}\n`, 'utf-8');
        print(stdout, target);
        return 0;
    }
    if (platform === 'win32') {
        if (!env.GEMINI_MD_EXPORT_NATIVE_HOST_PATH) {
            writeWindowsLauncher({
                launcherPath: paths.windowsLauncherPath,
                nodePath: paths.nodePath,
                runtimePath: paths.nativeRuntimePath,
            });
        }
        const dir = resolve(env.LOCALAPPDATA || homeDir, 'gemini-md-export', 'NativeMessagingHosts');
        mkdirSync(dir, { recursive: true });
        const target = resolve(dir, `${NATIVE_HOST_NAME}.json`);
        writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, 'utf-8');
        const result = spawnSync('reg.exe', ['add', windowsRegistryKey(browser), '/ve', '/t', 'REG_SZ', '/d', target, '/f'], {
            stdio: 'inherit',
        });
        if (result.status !== 0)
            return result.status || 1;
        print(stdout, target);
        return 0;
    }
    print(stdout, JSON.stringify(manifest, null, 2));
    return 0;
};
