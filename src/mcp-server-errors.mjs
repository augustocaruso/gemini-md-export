export const formatBridgeListenError = (error, { host, port } = {}) => {
  const address = host && port ? `${host}:${port}` : `porta ${port || 'desconhecida'}`;
  if (error?.code === 'EADDRINUSE') {
    return `Bridge HTTP já está em uso em ${address}. Instâncias MCP adicionais devem operar em modo proxy e encaminhar tools para a instância primária.`;
  }
  return `Bridge HTTP falhou ao iniciar em ${address}: ${error?.message || error}`;
};
