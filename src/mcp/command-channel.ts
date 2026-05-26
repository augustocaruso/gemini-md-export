const ENABLED_PATTERN = /^(?:1|true|yes|on|enabled)$/i;
const DISABLED_PATTERN = /^(?:0|false|no|off|disabled)$/i;

export const isCommandSseDeliveryEnabled = (
  env: { GEMINI_MCP_SSE_COMMAND_DELIVERY?: string } = process.env,
): boolean => {
  const rawValue = env.GEMINI_MCP_SSE_COMMAND_DELIVERY;
  if (rawValue === undefined || rawValue === '') return true;
  const value = String(rawValue);
  if (DISABLED_PATTERN.test(value)) return false;
  return ENABLED_PATTERN.test(value);
};

export const shouldAbortPendingSseCommandsOnEventStreamReconnect = ({
  existingEventStreamUsable,
  hasDispatchedSsePendingCommand,
}: Readonly<{
  existingEventStreamUsable: boolean;
  hasDispatchedSsePendingCommand: boolean;
}>): boolean => existingEventStreamUsable === true && hasDispatchedSsePendingCommand === true;

export const shouldAbortDispatchedCommandsOnEventStreamReconnect = ({
  existingEventStreamUsable,
  hasDispatchedPendingCommand,
}: Readonly<{
  existingEventStreamUsable: boolean;
  hasDispatchedPendingCommand: boolean;
}>): boolean => existingEventStreamUsable === true && hasDispatchedPendingCommand === true;
