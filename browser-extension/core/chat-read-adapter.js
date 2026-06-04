const DEFAULT_ORDER = [
    'privateApiGeminiWebapi',
    'browserBackground',
    'dom',
    'takeout',
];
const normalizeAdapterPreference = (adapter) => {
    if (!adapter)
        return null;
    if (adapter === 'privateApi')
        return 'privateApiGeminiWebapi';
    return adapter;
};
const capabilityFor = (adapter, capabilities) => capabilities.find((capability) => capability.adapter === adapter) || null;
export const buildChatReadAdapterPlan = ({ capabilities, preferredAdapter = null, allowExperimental = false, fallbackOrder = DEFAULT_ORDER, }) => {
    const preferred = normalizeAdapterPreference(preferredAdapter);
    const ordered = [
        ...(preferred ? [preferred] : []),
        ...fallbackOrder.filter((adapter) => adapter !== preferred),
    ];
    const viable = ordered.filter((adapter) => {
        const capability = capabilityFor(adapter, capabilities);
        if (!capability?.available)
            return false;
        if (capability.experimental && !allowExperimental)
            return false;
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
export const privateApiGeminiWebapiChatReadCapability = ({ available, reason = null, canReadAssets = false, evidence = [], }) => ({
    adapter: 'privateApiGeminiWebapi',
    available,
    experimental: true,
    canReadAssets,
    reason,
    evidence,
});
export const browserBackgroundChatReadCapability = ({ available, reason = null, canReadAssets = false, evidence = [], }) => ({
    adapter: 'browserBackground',
    available,
    experimental: true,
    canReadAssets,
    reason,
    evidence,
});
export const privateApiChatReadCapability = browserBackgroundChatReadCapability;
export const domChatReadCapability = ({ available, reason = null, canReadAssets = true, evidence = [], }) => ({
    adapter: 'dom',
    available,
    experimental: false,
    canReadAssets,
    reason,
    evidence,
});
export const takeoutChatReadCapability = ({ available, reason = null, evidence = [], }) => ({
    adapter: 'takeout',
    available,
    experimental: false,
    canReadAssets: false,
    reason,
    evidence,
});
const adapterOrderFromPlan = (plan) => plan.selectedAdapter ? [plan.selectedAdapter, ...plan.fallbackAdapters] : [];
const nextUnattemptedAdapter = (state) => {
    const attempted = new Set(state.attempts.map((attempt) => attempt.adapter));
    return adapterOrderFromPlan(state.plan).find((adapter) => !attempted.has(adapter)) || null;
};
export const initialChatReadAdapterFallbackState = (plan) => ({
    status: 'idle',
    plan,
    currentAdapter: null,
    warnings: [],
    attempts: [],
});
export const transitionChatReadAdapterFallback = (state, event) => {
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
    const failedState = {
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
