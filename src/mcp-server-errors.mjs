export const formatBridgeListenError = (error, { host, port } = {}) => {
  const address = host && port ? `${host}:${port}` : `porta ${port || 'desconhecida'}`;
  if (error?.code === 'EADDRINUSE') {
    return `Bridge HTTP não conseguiu escutar em ${address}: a porta já está em uso. Isso costuma indicar uma instância antiga do MCP ainda viva.`;
  }
  return `Bridge HTTP falhou ao iniciar em ${address}: ${error?.message || error}`;
};
