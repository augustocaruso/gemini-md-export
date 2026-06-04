import { runLocalExtensionCdpReload, } from './local-extension-cdp-reload.js';
import { evaluateLocalExtensionSync, resolveSourceExtensionDir, syncLoadedUnpackedExtension, } from './local-extension-sync.js';
const issueCode = (issue) => {
    if (!issue)
        return '';
    if (typeof issue === 'string')
        return issue;
    if (typeof issue !== 'object')
        return String(issue);
    const record = issue;
    return String(record.code || record.reason || record.type || record.message || '').trim();
};
const shouldRunCdpReloadAfterSync = (result) => ['synced', 'skipped-up-to-date'].includes(String(result.status || '')) &&
    result.shouldReloadExistingTabs !== false &&
    !!result.extensionId;
export const createBridgeLocalExtensionCdpReloadPort = (bridgeUrl, flags, requestJson) => async (args) => {
    try {
        return (await requestJson(bridgeUrl, '/agent/cdp/extension-reload', {
            method: 'POST',
            body: { ...args, allowReload: flags.allowReload === true },
            timeoutMs: 20_000,
            operation: 'local-extension-cdp-extension-reload',
        }));
    }
    catch (err) {
        const issue = err && typeof err === 'object' ? err : {};
        return {
            ok: false,
            attempted: true,
            mode: 'cdp-browser-websocket',
            extensionId: String(args.extensionId || ''),
            targetId: '',
            targetUrl: '',
            devToolsActivePortFile: '',
            code: String(issue.code || 'bridge_cdp_extension_reload_failed'),
            error: String(issue.message || err),
        };
    }
};
const attachCdpReload = async (result, input, ports) => {
    if (input.allowReload !== true || !shouldRunCdpReloadAfterSync(result))
        return result;
    const runReload = ports.runLocalExtensionCdpReload || runLocalExtensionCdpReload;
    const cdpReload = await runReload({
        allowReload: true,
        browser: result.browser || null,
        extensionId: result.extensionId || null,
    });
    return { ...result, cdpReload };
};
export const readyHasExtensionMismatchClients = (ready) => {
    const record = ready && typeof ready === 'object' ? ready : {};
    const extensionReadiness = record.extensionReadiness && typeof record.extensionReadiness === 'object'
        ? record.extensionReadiness
        : {};
    const clients = [
        ...(Array.isArray(record.connectedClients) ? record.connectedClients : []),
        ...(Array.isArray(record.clients) ? record.clients : []),
        ...(Array.isArray(record.diagnosticClients) ? record.diagnosticClients : []),
        ...(Array.isArray(extensionReadiness.connectedClients)
            ? extensionReadiness.connectedClients
            : []),
    ];
    return clients.some((client) => {
        const item = client && typeof client === 'object' ? client : {};
        const lifecycleCode = issueCode(item.lifecycle?.code);
        const healthIssue = issueCode(item.bridgeHealth?.blockingIssue);
        return (lifecycleCode === 'extension_build_mismatch' ||
            lifecycleCode === 'extension_version_mismatch' ||
            healthIssue === 'extension_build_mismatch' ||
            healthIssue === 'extension_version_mismatch');
    });
};
export const runLocalExtensionReloadPreflight = async (input, ports) => {
    const local = ports.buildLocalDoctorReport();
    const loadedExtension = local.loadedExtension?.extension || null;
    const sourceDir = resolveSourceExtensionDir(input.packageRoot);
    const preliminary = evaluateLocalExtensionSync({
        allowReload: input.allowReload === true,
        activeJobCount: 0,
        sourceDir,
        loadedExtension,
    });
    if (preliminary.shouldSync !== true) {
        const result = syncLoadedUnpackedExtension({
            allowReload: input.allowReload === true,
            activeJobCount: 0,
            sourceDir,
            loadedExtension,
        });
        return attachCdpReload({
            ...result,
            browser: local.browser || null,
            profileDirectory: local.profileDirectory || null,
            extensionId: loadedExtension?.id || null,
        }, input, ports);
    }
    const activeJobs = await ports.fetchActiveJobCount();
    if (activeJobs.ok !== true) {
        return {
            ok: false,
            status: 'active-job-probe-failed',
            shouldReloadExistingTabs: true,
            error: activeJobs.error || null,
            activeJobCount: 0,
            sourceDir,
            targetDir: loadedExtension?.path || null,
        };
    }
    const result = syncLoadedUnpackedExtension({
        allowReload: input.allowReload === true,
        activeJobCount: activeJobs.activeJobCount || 0,
        sourceDir,
        loadedExtension,
    });
    return attachCdpReload({
        ...result,
        browser: local.browser || null,
        profileDirectory: local.profileDirectory || null,
        extensionId: loadedExtension?.id || null,
    }, input, ports);
};
export const localExtensionReloadPreflightCliLine = (result) => {
    if (result.status === 'active-job-probe-failed') {
        return `Nao consegui confirmar se ha job ativo; nao vou sincronizar arquivos locais antes do reload. (${result.error || 'erro desconhecido'})`;
    }
    if (result.status === 'synced') {
        return `Extensao unpacked sincronizada antes do reload: ${result.targetDir} (${result.previousBuildStamp || '?'} -> ${result.targetBuildStamp || '?'})`;
    }
    if (result.status === 'blocked-active-job') {
        return 'Job ativo detectado; nao vou sincronizar nem recarregar a extensao agora.';
    }
    return null;
};
