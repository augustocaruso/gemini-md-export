const ACTIONABILITY_ORDER = [
  'strict',
  'attached',
  'visible',
  'stable',
  'enabled',
  'receivingEvents',
  'notBusy',
  'routeMatches',
  'postcondition',
];

const CHECK_MESSAGES = {
  strict: 'locator encontrou quantidade inesperada de elementos',
  attached: 'elemento ainda não está anexado ao DOM',
  visible: 'elemento ainda não está visível',
  stable: 'elemento ainda está mudando de posição/tamanho',
  enabled: 'elemento está desabilitado',
  receivingEvents: 'elemento não parece receber eventos',
  notBusy: 'aba já executa outra operação pesada',
  routeMatches: 'rota atual não é a esperada',
  postcondition: 'pós-condição da ação ainda não foi confirmada',
};

const boolOrDefault = (value, fallback = true) =>
  value === undefined || value === null ? fallback : value === true;

export const summarizeStrictLocator = ({ name = 'locator', count = 0 } = {}) => {
  const normalizedCount = Math.max(0, Number(count) || 0);
  return {
    name,
    count: normalizedCount,
    ok: normalizedCount === 1,
    code:
      normalizedCount === 1
        ? null
        : normalizedCount === 0
          ? 'locator_not_found'
          : 'locator_not_strict',
    retryable: normalizedCount === 0,
  };
};

export const describeDomActionability = ({
  name = 'elemento',
  count = 1,
  attached,
  visible,
  stable,
  enabled,
  receivingEvents,
  notBusy,
  routeMatches,
  postcondition = true,
  details = {},
} = {}) => {
  const strict = summarizeStrictLocator({ name, count });
  const checks = {
    strict: strict.ok,
    attached: boolOrDefault(attached, false),
    visible: boolOrDefault(visible, false),
    stable: boolOrDefault(stable),
    enabled: boolOrDefault(enabled),
    receivingEvents: boolOrDefault(receivingEvents),
    notBusy: boolOrDefault(notBusy),
    routeMatches: boolOrDefault(routeMatches),
    postcondition: boolOrDefault(postcondition),
  };
  const failed = ACTIONABILITY_ORDER.find((key) => checks[key] !== true) || null;
  const retryable = failed
    ? ['attached', 'visible', 'stable', 'receivingEvents', 'notBusy', 'routeMatches', 'postcondition'].includes(failed) ||
      strict.retryable
    : false;

  return {
    ok: !failed,
    name,
    code: failed ? (failed === 'strict' ? strict.code : `actionability_${failed}`) : null,
    message: failed ? CHECK_MESSAGES[failed] : 'pronto para ação',
    retryable,
    checks,
    details,
  };
};

export const buildAutoWaitSnapshot = ({
  name = 'ação',
  attempts = 0,
  elapsedMs = 0,
  timeoutMs = null,
  lastActionability = null,
} = {}) => ({
  name,
  attempts: Math.max(0, Number(attempts) || 0),
  elapsedMs: Math.max(0, Math.round(Number(elapsedMs) || 0)),
  timeoutMs: timeoutMs === null || timeoutMs === undefined ? null : Math.max(0, Number(timeoutMs) || 0),
  ok: lastActionability?.ok === true,
  lastCode: lastActionability?.code || null,
  lastMessage: lastActionability?.message || null,
  retryable: lastActionability?.retryable === true,
});

export const actionabilityTimeoutMessage = (snapshot = {}) => {
  const name = snapshot.name || 'ação';
  const timeout = snapshot.timeoutMs !== null && snapshot.timeoutMs !== undefined
    ? ` em ${snapshot.timeoutMs}ms`
    : '';
  const reason = snapshot.lastMessage ? ` Motivo: ${snapshot.lastMessage}.` : '';
  return `Não consegui executar ${name}${timeout}.${reason}`;
};

