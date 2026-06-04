const executeEffect = (effect, adapter) => {
    switch (effect.type) {
        case 'extension.reloadSelf':
            return adapter.reloadExtensionSelf(effect);
        case 'serviceWorker.selfHeal':
            return adapter.serviceWorkerSelfHeal(effect);
        case 'browser.open':
            return adapter.openBrowser(effect);
        case 'tab.reload':
            return adapter.reloadTab(effect);
        case 'tab.claim':
            return adapter.claimTab(effect);
        case 'runtime.waitForEpoch':
            return adapter.waitForRuntimeEpoch(effect);
        case 'diagnostic.record':
            return adapter.recordDiagnostic(effect);
    }
    const exhaustive = effect;
    return exhaustive;
};
const stringifyThrownObject = (error) => {
    try {
        return JSON.stringify(error);
    }
    catch {
        return Object.prototype.toString.call(error);
    }
};
const errorCode = (error) => {
    const code = error.code;
    return typeof code === 'string' || typeof code === 'number' ? code : undefined;
};
const normalizeExecutionError = (error) => {
    if (error instanceof Error) {
        const normalized = {
            name: error.name || 'Error',
            message: error.message,
        };
        const code = errorCode(error);
        if (code !== undefined)
            normalized.code = code;
        return normalized;
    }
    if (error && typeof error === 'object') {
        const record = error;
        const message = typeof record.message === 'string' && record.message
            ? record.message
            : stringifyThrownObject(error);
        const normalized = {
            message,
        };
        if (typeof record.name === 'string' && record.name)
            normalized.name = record.name;
        const code = errorCode(record);
        if (code !== undefined)
            normalized.code = code;
        return normalized;
    }
    return { message: String(error) };
};
export const executeTabOrchestratorEffects = async (effects, adapter) => {
    const executed = [];
    for (const effect of effects) {
        try {
            const result = await executeEffect(effect, adapter);
            executed.push({ effect, ok: true, result });
        }
        catch (error) {
            executed.push({ effect, ok: false, error: normalizeExecutionError(error) });
        }
    }
    return {
        status: executed.every((item) => item.ok) ? 'completed' : 'completed_with_errors',
        executed,
    };
};
