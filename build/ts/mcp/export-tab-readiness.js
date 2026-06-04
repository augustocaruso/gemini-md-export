import { getGeminiClientLifecycle, } from './client-lifecycle.js';
const backgroundEffects = {
    activateTab: false,
    requireActiveTab: false,
    allowInactiveTab: true,
};
const foregroundEffects = {
    activateTab: true,
    requireActiveTab: true,
    allowInactiveTab: false,
};
export const transitionExportTabReadinessFsm = (state, event) => {
    if (state !== 'checking') {
        return {
            state,
            effects: state === 'foreground_required' ? foregroundEffects : backgroundEffects,
        };
    }
    if (event.explicitActivation) {
        return { state: 'foreground_required', effects: foregroundEffects };
    }
    return { state: 'background_allowed', effects: backgroundEffects };
};
export const exportTabReadinessPolicyForArgs = (args = {}) => transitionExportTabReadinessFsm('checking', {
    type: 'client_seen',
    explicitActivation: args.activateTabBeforeExport === true || args.activateTab === true,
});
export const assertExportClientReadyForJob = (client, args = {}, baseOptions, options = {}) => {
    const readinessPolicy = exportTabReadinessPolicyForArgs(args);
    const lifecycle = getGeminiClientLifecycle(client, {
        ...baseOptions,
        requireClaimed: options.requireClaimed === true,
        capability: 'recent-export',
        allowInactiveTab: readinessPolicy.effects.allowInactiveTab,
    });
    if (lifecycle.ok)
        return lifecycle;
    const error = new Error(`${lifecycle.code}: ${lifecycle.message}`);
    Object.assign(error, { code: lifecycle.code, data: { lifecycle } });
    throw error;
};
