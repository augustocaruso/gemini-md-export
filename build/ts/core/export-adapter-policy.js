const adapter = (kind, browserLeaseRequired = false) => ({
    kind,
    browserLeaseRequired,
});
export const planExportAdapters = (input) => {
    const knownChatIds = input.knownChatIds || [];
    const adapters = [];
    if (knownChatIds.length > 0 && input.privateApiAvailable === true) {
        adapters.push(adapter('private_api'));
        return { adapters, requiresBrowserLease: false, blocker: null };
    }
    if (knownChatIds.length > 0 && input.extensionPrivateApiAvailable === true) {
        adapters.push(adapter('extension_private_api'));
    }
    if (knownChatIds.length > 0 && input.pythonSidecarAvailable === true) {
        adapters.push(adapter('python_sidecar'));
    }
    if (adapters.length > 0) {
        return { adapters, requiresBrowserLease: false, blocker: null };
    }
    if (input.privateInventoryAvailable === true) {
        adapters.push(adapter('private_inventory'));
        return { adapters, requiresBrowserLease: false, blocker: null };
    }
    if (input.browserFallbackAllowed !== true) {
        return {
            adapters: [],
            requiresBrowserLease: false,
            blocker: {
                code: 'private_inventory_unavailable',
                message: 'Inventario privado indisponivel e fallback de navegador desativado.',
            },
        };
    }
    adapters.push(adapter('browser_inventory', true), adapter('dom_legacy', true));
    return { adapters, requiresBrowserLease: true, blocker: null };
};
