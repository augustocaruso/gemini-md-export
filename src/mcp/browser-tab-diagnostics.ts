export type BrowserTabDiagnosisKind =
  | 'google_sorry'
  | 'google_login'
  | 'gemini'
  | 'loading'
  | 'other'
  | 'unknown';

export type BrowserTabUrlDiagnosis = Readonly<{
  kind: BrowserTabDiagnosisKind;
  terminal: boolean;
  url: string | null;
  hostname?: string;
}>;

export type BrowserTabInventoryDiagnosis = BrowserTabUrlDiagnosis &
  Readonly<{
    ok: true;
    activeUrl: string | null;
    urls: string[];
    inventoryComplete: boolean;
  }>;

export const splitBrowserUrlList = (value: unknown): string[] =>
  String(value || '')
    .split(/\r?\n|,\s*(?=https?:|about:|chrome:|edge:|brave:|dia:)/i)
    .map((item) => item.trim())
    .filter(Boolean);

export const classifyManagedBrowserUrl = (value: unknown): BrowserTabUrlDiagnosis => {
  const url = String(value || '').trim();
  if (!url) return { kind: 'unknown', terminal: false, url: null };
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    const pathname = parsed.pathname.toLowerCase();
    const continueUrl = parsed.searchParams.get('continue') || '';
    const lowerContinue = continueUrl.toLowerCase();
    if (
      hostname.endsWith('google.com') &&
      pathname.startsWith('/sorry') &&
      lowerContinue.includes('gemini.google.com')
    ) {
      return { kind: 'google_sorry', terminal: true, url };
    }
    if (hostname === 'accounts.google.com') {
      return { kind: 'google_login', terminal: true, url };
    }
    if (hostname === 'gemini.google.com') {
      return { kind: 'gemini', terminal: false, url };
    }
    if (/^(about:blank|chrome:\/\/newtab|edge:\/\/newtab|brave:\/\/newtab|dia:\/\/)/i.test(url)) {
      return { kind: 'loading', terminal: false, url };
    }
    return { kind: 'other', terminal: true, url, hostname };
  } catch {
    return { kind: 'unknown', terminal: false, url };
  }
};

export const diagnoseManagedBrowserTabs = ({
  activeUrl = null,
  urls = [],
  inventoryComplete = true,
}: {
  activeUrl?: string | null;
  urls?: string[] | string;
  inventoryComplete?: boolean;
} = {}): BrowserTabInventoryDiagnosis => {
  const items = [
    ...splitBrowserUrlList(activeUrl),
    ...(Array.isArray(urls) ? urls : splitBrowserUrlList(urls)),
  ];
  const classified = items.map(classifyManagedBrowserUrl);
  const first = (...kinds: BrowserTabDiagnosisKind[]) =>
    classified.find((item) => kinds.includes(item.kind));
  const relevant =
    first('gemini') || first('google_sorry') || first('google_login') || first('loading') || null;

  if (relevant) {
    return {
      ok: true,
      ...relevant,
      activeUrl: activeUrl || null,
      urls: items,
      inventoryComplete,
    };
  }

  const active = classifyManagedBrowserUrl(activeUrl);
  if (!inventoryComplete && active.kind === 'other') {
    return {
      ok: true,
      kind: 'unknown',
      terminal: false,
      url: active.url,
      activeUrl: activeUrl || null,
      urls: items,
      inventoryComplete,
    };
  }

  return {
    ok: true,
    ...active,
    activeUrl: activeUrl || null,
    urls: items,
    inventoryComplete,
  };
};
