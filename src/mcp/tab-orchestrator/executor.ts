import type { TabOrchestratorEffect } from './types.js';

type EffectOf<Type extends TabOrchestratorEffect['type']> = Extract<
  TabOrchestratorEffect,
  { type: Type }
>;

export type TabOrchestratorEffectAdapter = Readonly<{
  reloadExtensionSelf: (effect: EffectOf<'extension.reloadSelf'>) => unknown | Promise<unknown>;
  serviceWorkerSelfHeal: (effect: EffectOf<'serviceWorker.selfHeal'>) => unknown | Promise<unknown>;
  openBrowser: (effect: EffectOf<'browser.open'>) => unknown | Promise<unknown>;
  reloadTab: (effect: EffectOf<'tab.reload'>) => unknown | Promise<unknown>;
  claimTab: (effect: EffectOf<'tab.claim'>) => unknown | Promise<unknown>;
  waitForRuntimeEpoch: (effect: EffectOf<'runtime.waitForEpoch'>) => unknown | Promise<unknown>;
  recordDiagnostic: (effect: EffectOf<'diagnostic.record'>) => unknown | Promise<unknown>;
}>;

export type TabOrchestratorEffectError = Readonly<{
  name?: string;
  message: string;
  code?: string | number;
}>;

export type TabOrchestratorEffectExecution = Readonly<
  | {
      effect: TabOrchestratorEffect;
      ok: true;
      result: unknown;
    }
  | {
      effect: TabOrchestratorEffect;
      ok: false;
      error: TabOrchestratorEffectError;
    }
>;

export type TabOrchestratorEffectExecutionReport = Readonly<{
  status: 'completed' | 'completed_with_errors';
  executed: TabOrchestratorEffectExecution[];
}>;

const executeEffect = (
  effect: TabOrchestratorEffect,
  adapter: TabOrchestratorEffectAdapter,
): unknown | Promise<unknown> => {
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

  const exhaustive: never = effect;
  return exhaustive;
};

const stringifyThrownObject = (error: object): string => {
  try {
    return JSON.stringify(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
};

const errorCode = (error: Record<string, unknown>): string | number | undefined => {
  const code = error.code;
  return typeof code === 'string' || typeof code === 'number' ? code : undefined;
};

const normalizeExecutionError = (error: unknown): TabOrchestratorEffectError => {
  if (error instanceof Error) {
    const normalized: { name: string; message: string; code?: string | number } = {
      name: error.name || 'Error',
      message: error.message,
    };
    const code = errorCode(error as unknown as Record<string, unknown>);
    if (code !== undefined) normalized.code = code;
    return normalized;
  }

  if (error && typeof error === 'object') {
    const record = error as Record<string, unknown>;
    const message =
      typeof record.message === 'string' && record.message
        ? record.message
        : stringifyThrownObject(error);
    const normalized: { name?: string; message: string; code?: string | number } = {
      message,
    };
    if (typeof record.name === 'string' && record.name) normalized.name = record.name;
    const code = errorCode(record);
    if (code !== undefined) normalized.code = code;
    return normalized;
  }

  return { message: String(error) };
};

export const executeTabOrchestratorEffects = async (
  effects: readonly TabOrchestratorEffect[],
  adapter: TabOrchestratorEffectAdapter,
): Promise<TabOrchestratorEffectExecutionReport> => {
  const executed: TabOrchestratorEffectExecution[] = [];

  for (const effect of effects) {
    try {
      const result = await executeEffect(effect, adapter);
      executed.push({ effect, ok: true, result });
    } catch (error) {
      executed.push({ effect, ok: false, error: normalizeExecutionError(error) });
    }
  }

  return {
    status: executed.every((item) => item.ok) ? 'completed' : 'completed_with_errors',
    executed,
  };
};
