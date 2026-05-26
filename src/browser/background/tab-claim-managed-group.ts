const MANAGED_TAB_CLAIM_GROUP_TITLE_RE =
  /^(?:GME(?:\s|$)|Gemini Export$|Export(?:\s|$)|✨ Em uso$|🔎 Conferindo$|📥 Exportando$|🔄 Sincroniza$)/iu;

export const looksLikeManagedClaimGroupTitle = (title: unknown): boolean =>
  MANAGED_TAB_CLAIM_GROUP_TITLE_RE.test(String(title || '').trim());
