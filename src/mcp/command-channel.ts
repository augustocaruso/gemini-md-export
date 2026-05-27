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

export type EventStreamReconnectCommandInput = Readonly<{
  existingEventStreamUsable: boolean;
  hasDispatchedPendingCommand?: boolean;
  hasDispatchedSsePendingCommand?: boolean;
}>;

export type EventStreamReconnectCommandDecision = Readonly<{
  state:
    | 'no_previous_stream'
    | 'transport_reconnected_without_command'
    | 'transport_reconnected_with_dispatched_command';
  action: 'replace_stream' | 'preserve_dispatched_command' | 'abort_dispatched_command';
  reason:
    | 'no-existing-event-stream'
    | 'no-dispatched-command'
    | 'same-client-event-stream-reconnect-is-transport-only';
}>;

export const evaluateEventStreamReconnectCommandFsm = ({
  existingEventStreamUsable,
  hasDispatchedPendingCommand = false,
  hasDispatchedSsePendingCommand = false,
}: EventStreamReconnectCommandInput): EventStreamReconnectCommandDecision => {
  if (existingEventStreamUsable !== true) {
    return {
      state: 'no_previous_stream',
      action: 'replace_stream',
      reason: 'no-existing-event-stream',
    };
  }

  if (hasDispatchedPendingCommand === true || hasDispatchedSsePendingCommand === true) {
    return {
      state: 'transport_reconnected_with_dispatched_command',
      action: 'preserve_dispatched_command',
      reason: 'same-client-event-stream-reconnect-is-transport-only',
    };
  }

  return {
    state: 'transport_reconnected_without_command',
    action: 'replace_stream',
    reason: 'no-dispatched-command',
  };
};

export const shouldAbortPendingSseCommandsOnEventStreamReconnect = ({
  existingEventStreamUsable,
  hasDispatchedSsePendingCommand,
}: Readonly<{
  existingEventStreamUsable: boolean;
  hasDispatchedSsePendingCommand: boolean;
}>): boolean =>
  evaluateEventStreamReconnectCommandFsm({
    existingEventStreamUsable,
    hasDispatchedSsePendingCommand,
  }).action === 'abort_dispatched_command';

export const shouldAbortDispatchedCommandsOnEventStreamReconnect = ({
  existingEventStreamUsable,
  hasDispatchedPendingCommand,
}: Readonly<{
  existingEventStreamUsable: boolean;
  hasDispatchedPendingCommand: boolean;
}>): boolean =>
  evaluateEventStreamReconnectCommandFsm({
    existingEventStreamUsable,
    hasDispatchedPendingCommand,
  }).action === 'abort_dispatched_command';
