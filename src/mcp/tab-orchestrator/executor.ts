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

export type TabOrchestratorEffectExecution = Readonly<
  | {
      effect: TabOrchestratorEffect;
      ok: true;
      result: unknown;
    }
  | {
      effect: TabOrchestratorEffect;
      ok: false;
      error: unknown;
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
      executed.push({ effect, ok: false, error });
    }
  }

  return {
    status: executed.every((item) => item.ok) ? 'completed' : 'completed_with_errors',
    executed,
  };
};
