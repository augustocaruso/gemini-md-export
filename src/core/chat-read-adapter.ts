import type { ChatId, ChatSnapshot, SanitizedEvidence } from './types.js';

export type ChatReadAdapterKind =
  | 'privateApiGeminiWebapi'
  | 'browserBackground'
  | 'dom'
  | 'takeout';

export type ChatReadAdapterPreference = ChatReadAdapterKind | 'privateApi';

export type ChatReadAdapterCapability = Readonly<{
  adapter: ChatReadAdapterKind;
  available: boolean;
  experimental: boolean;
  canReadAssets: boolean;
  reason?: string | null;
  evidence: readonly SanitizedEvidence[];
}>;

export type ChatReadRequest = Readonly<{
  chatId: ChatId | string;
  title?: string | null;
  url?: string | null;
  allowExperimental?: boolean;
  preferredAdapter?: ChatReadAdapterPreference | null;
}>;

export type ChatReadSuccess = Readonly<{
  ok: true;
  adapter: ChatReadAdapterKind;
  experimental: boolean;
  snapshot: ChatSnapshot;
  evidence: readonly SanitizedEvidence[];
  warnings: readonly string[];
  fallbackAdapters: readonly ChatReadAdapterKind[];
}>;

export type ChatReadFailure = Readonly<{
  ok: false;
  code: string;
  message: string;
  adapter: ChatReadAdapterKind;
  experimental: boolean;
  requestedChatId?: string;
  observedChatId?: string;
  evidence: readonly SanitizedEvidence[];
  fallbackAdapters: readonly ChatReadAdapterKind[];
}>;

export type ChatReadResult = ChatReadSuccess | ChatReadFailure;

export type ChatReadAdapter = Readonly<{
  kind: ChatReadAdapterKind;
  experimental: boolean;
  capability(input: ChatReadRequest): ChatReadAdapterCapability;
  read(input: ChatReadRequest): Promise<ChatReadResult> | ChatReadResult;
}>;

export type ChatReadAdapterPlan = Readonly<{
  ok: boolean;
  selectedAdapter: ChatReadAdapterKind | null;
  fallbackAdapters: readonly ChatReadAdapterKind[];
  capabilities: readonly ChatReadAdapterCapability[];
  reason: string;
}>;

export type ChatReadAdapterFallbackWarning = Readonly<{
  adapter: ChatReadAdapterKind;
  code: string;
  message: string;
}>;

export type ChatReadAdapterAttempt = ChatReadAdapterFallbackWarning &
  Readonly<{
    status: 'failed' | 'succeeded';
  }>;

export type ChatReadAdapterFallbackStatus = 'idle' | 'attempting' | 'succeeded' | 'failed';

export type ChatReadAdapterFallbackState = Readonly<{
  status: ChatReadAdapterFallbackStatus;
  plan: ChatReadAdapterPlan;
  currentAdapter?: ChatReadAdapterKind | null;
  warnings: readonly ChatReadAdapterFallbackWarning[];
  attempts: readonly ChatReadAdapterAttempt[];
}>;

export type ChatReadAdapterFallbackEvent =
  | Readonly<{ type: 'start' }>
  | Readonly<{
      type: 'adapter_failed';
      adapter: ChatReadAdapterKind;
      code: string;
      message: string;
    }>
  | Readonly<{
      type: 'adapter_succeeded';
      adapter: ChatReadAdapterKind;
    }>;

export type ChatReadAdapterFallbackEffect =
  | Readonly<{ type: 'read_adapter'; adapter: ChatReadAdapterKind }>
  | Readonly<{ type: 'finish'; ok: boolean }>;

export type ChatReadAdapterFallbackTransition = Readonly<{
  state: ChatReadAdapterFallbackState;
  effects: readonly ChatReadAdapterFallbackEffect[];
}>;

const DEFAULT_ORDER: readonly ChatReadAdapterKind[] = [
  'privateApiGeminiWebapi',
  'browserBackground',
  'dom',
  'takeout',
];

const normalizeAdapterPreference = (
  adapter: ChatReadAdapterPreference | null | undefined,
): ChatReadAdapterKind | null => {
  if (!adapter) return null;
  if (adapter === 'privateApi') return 'privateApiGeminiWebapi';
  return adapter;
};

const capabilityFor = (
  adapter: ChatReadAdapterKind,
  capabilities: readonly ChatReadAdapterCapability[],
): ChatReadAdapterCapability | null =>
  capabilities.find((capability) => capability.adapter === adapter) || null;

export const buildChatReadAdapterPlan = ({
  capabilities,
  preferredAdapter = null,
  allowExperimental = false,
  fallbackOrder = DEFAULT_ORDER,
}: Readonly<{
  capabilities: readonly ChatReadAdapterCapability[];
  preferredAdapter?: ChatReadAdapterPreference | null;
  allowExperimental?: boolean;
  fallbackOrder?: readonly ChatReadAdapterKind[];
}>): ChatReadAdapterPlan => {
  const preferred = normalizeAdapterPreference(preferredAdapter);
  const ordered = [
    ...(preferred ? [preferred] : []),
    ...fallbackOrder.filter((adapter) => adapter !== preferred),
  ];
  const viable = ordered.filter((adapter) => {
    const capability = capabilityFor(adapter, capabilities);
    if (!capability?.available) return false;
    if (capability.experimental && !allowExperimental) return false;
    return true;
  });
  const selectedAdapter = viable[0] || null;
  if (!selectedAdapter) {
    return {
      ok: false,
      selectedAdapter: null,
      fallbackAdapters: [],
      capabilities,
      reason: 'no_chat_read_adapter_available',
    };
  }
  return {
    ok: true,
    selectedAdapter,
    fallbackAdapters: viable.slice(1),
    capabilities,
    reason: 'adapter_selected',
  };
};

export const privateApiGeminiWebapiChatReadCapability = ({
  available,
  reason = null,
  canReadAssets = false,
  evidence = [],
}: Readonly<{
  available: boolean;
  reason?: string | null;
  canReadAssets?: boolean;
  evidence?: readonly SanitizedEvidence[];
}>): ChatReadAdapterCapability => ({
  adapter: 'privateApiGeminiWebapi',
  available,
  experimental: true,
  canReadAssets,
  reason,
  evidence,
});

export const browserBackgroundChatReadCapability = ({
  available,
  reason = null,
  canReadAssets = false,
  evidence = [],
}: Readonly<{
  available: boolean;
  reason?: string | null;
  canReadAssets?: boolean;
  evidence?: readonly SanitizedEvidence[];
}>): ChatReadAdapterCapability => ({
  adapter: 'browserBackground',
  available,
  experimental: true,
  canReadAssets,
  reason,
  evidence,
});

export const privateApiChatReadCapability = browserBackgroundChatReadCapability;

export const domChatReadCapability = ({
  available,
  reason = null,
  canReadAssets = true,
  evidence = [],
}: Readonly<{
  available: boolean;
  reason?: string | null;
  canReadAssets?: boolean;
  evidence?: readonly SanitizedEvidence[];
}>): ChatReadAdapterCapability => ({
  adapter: 'dom',
  available,
  experimental: false,
  canReadAssets,
  reason,
  evidence,
});

export const takeoutChatReadCapability = ({
  available,
  reason = null,
  evidence = [],
}: Readonly<{
  available: boolean;
  reason?: string | null;
  evidence?: readonly SanitizedEvidence[];
}>): ChatReadAdapterCapability => ({
  adapter: 'takeout',
  available,
  experimental: false,
  canReadAssets: false,
  reason,
  evidence,
});

const adapterOrderFromPlan = (plan: ChatReadAdapterPlan): readonly ChatReadAdapterKind[] =>
  plan.selectedAdapter ? [plan.selectedAdapter, ...plan.fallbackAdapters] : [];

const nextUnattemptedAdapter = (
  state: ChatReadAdapterFallbackState,
): ChatReadAdapterKind | null => {
  const attempted = new Set(state.attempts.map((attempt) => attempt.adapter));
  return adapterOrderFromPlan(state.plan).find((adapter) => !attempted.has(adapter)) || null;
};

export const initialChatReadAdapterFallbackState = (
  plan: ChatReadAdapterPlan,
): ChatReadAdapterFallbackState => ({
  status: 'idle',
  plan,
  currentAdapter: null,
  warnings: [],
  attempts: [],
});

export const transitionChatReadAdapterFallback = (
  state: ChatReadAdapterFallbackState,
  event: ChatReadAdapterFallbackEvent,
): ChatReadAdapterFallbackTransition => {
  if (event.type === 'start') {
    const adapter = nextUnattemptedAdapter(state);
    if (!adapter) {
      return {
        state: { ...state, status: 'failed', currentAdapter: null },
        effects: [{ type: 'finish', ok: false }],
      };
    }
    return {
      state: { ...state, status: 'attempting', currentAdapter: adapter },
      effects: [{ type: 'read_adapter', adapter }],
    };
  }

  if (event.type === 'adapter_succeeded') {
    return {
      state: {
        ...state,
        status: 'succeeded',
        currentAdapter: event.adapter,
        attempts: [
          ...state.attempts,
          {
            adapter: event.adapter,
            status: 'succeeded',
            code: 'ok',
            message: 'adapter succeeded',
          },
        ],
      },
      effects: [{ type: 'finish', ok: true }],
    };
  }

  const warning = {
    adapter: event.adapter,
    code: event.code,
    message: event.message,
  };
  const failedState: ChatReadAdapterFallbackState = {
    ...state,
    warnings: [...state.warnings, warning],
    attempts: [...state.attempts, { ...warning, status: 'failed' }],
  };
  const nextAdapter = nextUnattemptedAdapter(failedState);
  if (!nextAdapter) {
    return {
      state: { ...failedState, status: 'failed', currentAdapter: null },
      effects: [{ type: 'finish', ok: false }],
    };
  }
  return {
    state: { ...failedState, status: 'attempting', currentAdapter: nextAdapter },
    effects: [{ type: 'read_adapter', adapter: nextAdapter }],
  };
};
