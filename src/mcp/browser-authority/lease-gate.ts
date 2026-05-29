import type {
  BrowserAuthorityEffect,
  BrowserLease,
  LeasedBrowserAuthorityEffect,
} from './types.js';

export type BrowserAuthorityLeaseToken = Readonly<{
  leaseId: string;
  operationId: string;
  deadlineAtMs: number;
}>;

export const browserAuthorityLeaseToken = (lease: BrowserLease): BrowserAuthorityLeaseToken => ({
  leaseId: lease.leaseId,
  operationId: lease.operationId,
  deadlineAtMs: lease.budget.deadlineAtMs,
});

export const assertLeasedBrowserEffect = ({
  effect,
  token,
  nowMs = Date.now(),
}: Readonly<{
  effect: BrowserAuthorityEffect;
  token?: BrowserAuthorityLeaseToken | null;
  nowMs?: number;
}>): LeasedBrowserAuthorityEffect => {
  if (!token) {
    throw Object.assign(new Error('Controle do navegador exige autorizacao de navegador valida.'), {
      code: 'browser_authority_lease_missing',
    });
  }

  if (!effect.leaseId || effect.leaseId !== token.leaseId) {
    throw Object.assign(
      new Error('Este comando de navegador nao pertence a autorizacao desta operacao.'),
      { code: 'browser_authority_lease_mismatch' },
    );
  }

  if (token.deadlineAtMs <= nowMs) {
    throw Object.assign(new Error('A autorizacao de navegador desta operacao expirou.'), {
      code: 'browser_authority_lease_expired',
    });
  }

  return { ...effect, leaseId: token.leaseId };
};
