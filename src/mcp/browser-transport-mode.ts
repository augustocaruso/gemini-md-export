export type BrowserContentScriptTransport =
  | 'http'
  | 'native-proxy-http'
  | 'native-broker'
  | 'unknown';

export type BrowserTransportControlPlane = 'http' | 'native-broker' | 'none';

export type BrowserTransportModeName =
  | 'native_broker'
  | 'hybrid_native_proxy_http'
  | 'http_bridge'
  | 'offline';

export type BrowserTransportModeInput = Readonly<{
  bridgeHttpEnabled: boolean;
  nativeMessagingConfigured?: boolean;
  nativeBrokerAvailable?: boolean | null;
  contentScriptTransport?: BrowserContentScriptTransport;
}>;

export type BrowserTransportMode = Readonly<{
  mode: BrowserTransportModeName;
  nativeFirst: boolean;
  httpDependency: boolean;
  controlPlane: BrowserTransportControlPlane;
  bridgeHttpEnabled: boolean;
  nativeMessagingConfigured: boolean;
  nativeBrokerAvailable: boolean | null;
  contentScriptTransport: BrowserContentScriptTransport;
}>;

export const browserTransportMode = ({
  bridgeHttpEnabled,
  nativeMessagingConfigured = false,
  nativeBrokerAvailable = null,
  contentScriptTransport = 'unknown',
}: BrowserTransportModeInput): BrowserTransportMode => {
  if (
    bridgeHttpEnabled === false &&
    nativeMessagingConfigured === true &&
    nativeBrokerAvailable === true &&
    contentScriptTransport === 'native-broker'
  ) {
    return {
      mode: 'native_broker',
      nativeFirst: true,
      httpDependency: false,
      controlPlane: 'native-broker',
      bridgeHttpEnabled,
      nativeMessagingConfigured,
      nativeBrokerAvailable,
      contentScriptTransport,
    };
  }

  if (
    bridgeHttpEnabled === true &&
    nativeMessagingConfigured === true &&
    contentScriptTransport === 'native-proxy-http'
  ) {
    return {
      mode: 'hybrid_native_proxy_http',
      nativeFirst: false,
      httpDependency: true,
      controlPlane: 'http',
      bridgeHttpEnabled,
      nativeMessagingConfigured,
      nativeBrokerAvailable,
      contentScriptTransport,
    };
  }

  if (bridgeHttpEnabled === true) {
    return {
      mode: 'http_bridge',
      nativeFirst: false,
      httpDependency: true,
      controlPlane: 'http',
      bridgeHttpEnabled,
      nativeMessagingConfigured,
      nativeBrokerAvailable,
      contentScriptTransport,
    };
  }

  return {
    mode: 'offline',
    nativeFirst: false,
    httpDependency: false,
    controlPlane: 'none',
    bridgeHttpEnabled,
    nativeMessagingConfigured,
    nativeBrokerAvailable,
    contentScriptTransport,
  };
};

export const formatBrowserTransportMode = (status: BrowserTransportMode): string => {
  if (status.mode === 'native_broker') {
    return 'Native browser broker ativo; sem dependencia do HTTP bridge para controle de abas.';
  }
  if (status.mode === 'hybrid_native_proxy_http') {
    return 'Native Messaging proxy ativo, mas ainda encaminhando para o HTTP bridge local.';
  }
  if (status.mode === 'http_bridge') {
    return 'HTTP bridge local ativo como plano de controle do navegador.';
  }
  return 'Nenhum plano de controle do navegador esta ativo.';
};
