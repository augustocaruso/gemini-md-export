import { defaultBrokerIpcPath, requestBrokerIpc } from '../native/local-ipc.js';
import { makeNativeRequest, type NativeBrokerCommand, type NativeBrokerRequest } from '../native/protocol.js';

type NativeBrowserBrokerCommand = Extract<
  NativeBrokerCommand,
  'tabs.list' | 'tabs.status' | 'tabs.claim' | 'tabs.release'
>;

type NativeBrowserBrokerOptions = Readonly<{
  allowFallback?: boolean;
}>;

type NativeBrowserBrokerClientOptions = Readonly<{
  path?: string;
  request?: (request: NativeBrokerRequest) => Promise<unknown>;
}>;

export const shouldUseNativeBrowserBroker = ({
  disabled = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER === 'disabled',
}: { disabled?: boolean } = {}): boolean => disabled !== true;

export const createNativeBrowserBrokerClient = ({
  path = process.env.GEMINI_MD_EXPORT_NATIVE_BROKER_IPC || defaultBrokerIpcPath(),
  request = (nativeRequest: NativeBrokerRequest) => requestBrokerIpc(path, nativeRequest),
}: NativeBrowserBrokerClientOptions = {}) => {
  const call = async (
    command: NativeBrowserBrokerCommand,
    payload: Record<string, unknown> = {},
    options: NativeBrowserBrokerOptions = {},
  ) => {
    try {
      return await request(makeNativeRequest(command, payload));
    } catch (err) {
      return {
        ok: false as const,
        code: 'native_broker_unavailable',
        error: err instanceof Error ? err.message : String(err),
        allowFallback: options.allowFallback === true,
      };
    }
  };

  return {
    listTabs: (options: NativeBrowserBrokerOptions = {}) => call('tabs.list', {}, options),
    status: (options: NativeBrowserBrokerOptions = {}) => call('tabs.status', {}, options),
    claim: (
      payload: Record<string, unknown> = {},
      options: NativeBrowserBrokerOptions = {},
    ) => call('tabs.claim', payload, options),
    release: (
      payload: Record<string, unknown> = {},
      options: NativeBrowserBrokerOptions = {},
    ) => call('tabs.release', payload, options),
  };
};
