export function buildNotebookReturnPlan(options = {}) {
  const preserveContext = options.preserveContext !== false;
  const preferDirect = options.preferDirect === true;

  if (preserveContext) {
    return {
      preserveContext: true,
      tryDirectFirst: false,
      allowSoftDirectFallback: true,
      allowHardDirectFallback: false,
      mode: 'history-then-spa-link',
    };
  }

  return {
    preserveContext: false,
    tryDirectFirst: preferDirect,
    allowSoftDirectFallback: true,
    allowHardDirectFallback: true,
    mode: preferDirect ? 'direct-first' : 'history-first',
  };
}

export function buildNotebookConversationPlan(options = {}) {
  const preserveContext = options.preserveContext !== false;
  const hasVisibleRow = options.hasVisibleRow !== false;
  const hasKnownChatUrl = options.hasKnownChatUrl === true;

  if (preserveContext) {
    return {
      preserveContext: true,
      tryVisibleRowFirst: hasVisibleRow,
      allowDirectUrlFallback: false,
      mode: hasVisibleRow ? 'row-only' : 'context-preserved-no-direct',
    };
  }

  return {
    preserveContext: false,
    tryVisibleRowFirst: hasVisibleRow,
    allowDirectUrlFallback: hasKnownChatUrl,
    mode: hasVisibleRow
      ? hasKnownChatUrl
        ? 'row-first-direct-fallback'
        : 'row-only'
      : hasKnownChatUrl
        ? 'direct-only'
        : 'unreachable',
  };
}
