export type ExportAdapterKind =
  | 'private_api'
  | 'extension_private_api'
  | 'python_sidecar'
  | 'private_inventory'
  | 'browser_inventory'
  | 'dom_legacy';

export type ExportAdapterPolicyInput = Readonly<{
  operationKind: string;
  knownChatIds?: readonly string[];
  privateApiAvailable?: boolean;
  privateInventoryAvailable?: boolean;
  extensionPrivateApiAvailable?: boolean;
  pythonSidecarAvailable?: boolean;
  browserFallbackAllowed?: boolean;
}>;

export type ExportAdapterPlan = Readonly<{
  adapters: readonly Readonly<{ kind: ExportAdapterKind; browserLeaseRequired: boolean }>[];
  requiresBrowserLease: boolean;
  blocker?: Readonly<{ code: string; message: string }> | null;
}>;

const adapter = (kind: ExportAdapterKind, browserLeaseRequired = false) => ({
  kind,
  browserLeaseRequired,
});

export const planExportAdapters = (input: ExportAdapterPolicyInput): ExportAdapterPlan => {
  const knownChatIds = input.knownChatIds || [];
  const adapters: ReturnType<typeof adapter>[] = [];

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
