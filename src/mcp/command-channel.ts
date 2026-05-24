const ENABLED_PATTERN = /^(?:1|true|yes|on|enabled)$/i;

export const isCommandSseDeliveryEnabled = (
  env: { GEMINI_MCP_SSE_COMMAND_DELIVERY?: string } = process.env,
): boolean => ENABLED_PATTERN.test(String(env.GEMINI_MCP_SSE_COMMAND_DELIVERY || ''));
