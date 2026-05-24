import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  nativeStyleProfileFromCapture,
  sanitizeNativeStyleCaptureManifest,
  validateNativeStyleCaptureManifest,
  type NativeStyleCaptureManifest,
  type NativeStyleStateName,
} from '../browser/shared/native-style-capture.js';

type CaptureArgs = {
  fixture: string | null;
  out: string | null;
  url: string;
  check: boolean;
  json: boolean;
};

type CaptureTokenSpec = readonly [NativeStyleStateName, string, string];

type CaptureTargetSpec = {
  id: string;
  selectors: string[];
  matchedBy: string;
  tokens: CaptureTokenSpec[];
};

type CaptureResult =
  | {
      ok: true;
      mode: 'check' | 'capture';
      profileName: string;
      tokenCount: number;
      outputPath: string | null;
    }
  | {
      ok: false;
      error: string;
    };

type MinimalLocator = {
  first(): MinimalLocator;
  count(): Promise<number>;
  isVisible(): Promise<boolean>;
  hover(options?: { trial?: boolean }): Promise<void>;
  focus(): Promise<void>;
  page(): MinimalPage;
  evaluate<TArg, TResult>(
    callback: (element: Element, arg: TArg) => TResult,
    arg: TArg,
  ): Promise<TResult>;
};

type MinimalPage = {
  goto(url: string, options: { waitUntil: 'domcontentloaded' }): Promise<void>;
  locator(selector: string): MinimalLocator;
  mouse: {
    down(): Promise<void>;
    up(): Promise<void>;
  };
};

type MinimalBrowser = {
  newPage(): Promise<MinimalPage>;
  close(): Promise<void>;
};

type MinimalPlaywright = {
  chromium: {
    launch(options: { headless: boolean }): Promise<MinimalBrowser>;
  };
};

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

const DEFAULT_CAPTURE_URL = 'https://gemini.google.com/app';

const TARGET_SPECS: CaptureTargetSpec[] = [
  {
    id: 'topbar.iconButton',
    selectors: [
      'top-bar-actions .right-section button.mat-mdc-icon-button',
      'top-bar-actions .right-section button[mat-icon-button]',
      'top-bar-actions .right-section button',
    ],
    matchedBy: 'Gemini right-section icon button',
    tokens: [
      ['base', '--gmn-topbar-slot-size', 'width'],
      ['base', '--gmn-topbar-button-size', 'height'],
      ['base', '--gmn-topbar-button-padding', 'padding'],
      ['base', '--gmn-topbar-icon-size', 'font-size'],
      ['base', '--gmn-topbar-radius', 'border-radius'],
      ['hover', '--gmn-topbar-state-hover', 'background-color'],
      ['focus', '--gmn-topbar-state-focus', 'background-color'],
      ['pressed', '--gmn-topbar-state-pressed', 'background-color'],
    ],
  },
  {
    id: 'topbar.tooltip',
    selectors: [
      '.native-tooltip-reference',
      '[role="tooltip"]',
      '.mat-mdc-tooltip',
      '.cdk-overlay-pane [role="tooltip"]',
    ],
    matchedBy: 'Gemini tooltip surface',
    tokens: [
      ['base', '--gmn-tooltip-bg', 'background-color'],
      ['base', '--gmn-tooltip-text', 'color'],
      ['base', '--gmn-tooltip-radius', 'border-radius'],
      ['base', '--gmn-tooltip-padding', 'padding'],
      ['base', '--gmn-tooltip-min-height', 'min-height'],
      ['base', '--gmn-tooltip-font-size', 'font-size'],
      ['base', '--gmn-tooltip-line-height', 'line-height'],
      ['base', '--gmn-tooltip-font-weight', 'font-weight'],
      ['base', '--gmn-tooltip-arrow-size', 'width'],
      ['base', '--gmn-tooltip-arrow-radius', 'border-radius'],
    ],
  },
  {
    id: 'menu.panel',
    selectors: ['.mat-mdc-menu-panel', '.mdc-menu-surface'],
    matchedBy: 'Gemini Material menu panel',
    tokens: [
      ['base', '--gmn-menu-width', 'width'],
      ['base', '--gmn-menu-radius', 'border-radius'],
      ['base', '--gmn-menu-shadow', 'box-shadow'],
    ],
  },
  {
    id: 'menu.item',
    selectors: ['.mat-mdc-menu-item', '[role="menuitem"]'],
    matchedBy: 'Gemini Material menu item',
    tokens: [
      ['base', '--gmn-menu-item-min-height', 'min-height'],
      ['base', '--gmn-menu-item-padding', 'padding'],
      ['base', '--gmn-menu-item-radius', 'border-radius'],
      ['base', '--gmn-menu-font-size', 'font-size'],
      ['base', '--gmn-menu-line-height', 'line-height'],
      ['base', '--gmn-menu-font-weight', 'font-weight'],
      ['base', '--gmn-menu-leading-slot-size', 'width'],
      ['base', '--gmn-menu-leading-gap', 'gap'],
      ['base', '--gmn-menu-divider-margin', 'margin'],
    ],
  },
  {
    id: 'menu.itemChecked',
    selectors: ['.mat-mdc-menu-item[role="menuitemcheckbox"]', '[role="menuitemcheckbox"]'],
    matchedBy: 'Gemini checked menu item',
    tokens: [['checked', '--gmn-menu-checkbox-item-min-height', 'min-height']],
  },
  {
    id: 'modal.panel',
    selectors: [
      '.native-dialog-panel-reference',
      '.gm-modal-panel',
      '[role="dialog"]',
      '.mat-mdc-dialog-container',
    ],
    matchedBy: 'Gemini dialog surface',
    tokens: [
      ['base', '--gmn-modal-panel-width', 'width'],
      ['base', '--gmn-modal-panel-height', 'height'],
      ['base', '--gmn-modal-panel-max-height', 'max-height'],
      ['base', '--gmn-modal-panel-radius', 'border-radius'],
      ['base', '--gmn-modal-panel-padding', 'padding'],
      ['base', '--gmn-modal-panel-gap', 'gap'],
      ['base', '--gmn-modal-font-size', 'font-size'],
      ['base', '--gmn-modal-line-height', 'line-height'],
      ['base', '--gmn-modal-title-font-size', 'font-size'],
      ['base', '--gmn-modal-title-line-height', 'line-height'],
      ['base', '--gmn-modal-button-height', 'height'],
      ['base', '--gmn-modal-button-radius', 'border-radius'],
      ['base', '--gmn-modal-button-font-size', 'font-size'],
      ['base', '--gmn-modal-button-font-weight', 'font-weight'],
      ['base', '--gmn-modal-input-height', 'height'],
      ['base', '--gmn-modal-input-radius', 'border-radius'],
      ['base', '--gmn-modal-destination-radius', 'border-radius'],
      ['base', '--gmn-modal-destination-icon-size', 'width'],
      ['base', '--gmn-modal-destination-icon-glyph-size', 'font-size'],
    ],
  },
  {
    id: 'modal.list',
    selectors: [
      '.native-scroll-list-reference',
      '.gm-list',
      '[role="listbox"]',
      '.mat-mdc-selection-list',
    ],
    matchedBy: 'Gemini scrollable list',
    tokens: [
      ['base', '--gmn-modal-list-flex', 'flex'],
      ['base', '--gmn-modal-list-min-height', 'min-height'],
      ['base', '--gmn-modal-list-gap', 'gap'],
      ['base', '--gmn-modal-list-scrollbar-width', 'scrollbar-width'],
      ['base', '--gmn-modal-list-row-min-height', 'min-height'],
      ['base', '--gmn-modal-list-row-radius', 'border-radius'],
      ['base', '--gmn-modal-list-row-padding', 'padding'],
      ['base', '--gmn-modal-list-row-gap', 'gap'],
    ],
  },
  {
    id: 'modal.checkbox',
    selectors: ['.native-checkbox-reference', 'input[type="checkbox"]', '.mdc-checkbox'],
    matchedBy: 'Gemini checkbox control',
    tokens: [['base', '--gmn-modal-checkbox-size', 'width']],
  },
];

const usage = (): string => `Usage:
  node build/ts/cli/capture-native-style.js --fixture <path> --check [--json]
  node build/ts/cli/capture-native-style.js --out <path> [--url https://gemini.google.com/app] [--json]

Check mode validates a sanitized, versioned native-style fixture without opening a browser.
Live capture requires Playwright and a prepared Gemini page with the reference menu,
tooltip, dialog/list, and checkbox elements visible.`;

const parseArgs = (argv: string[]): CaptureArgs => {
  const args: CaptureArgs = {
    fixture: null,
    out: null,
    url: DEFAULT_CAPTURE_URL,
    check: false,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--fixture') args.fixture = argv[++i] || null;
    else if (arg === '--out') args.out = argv[++i] || null;
    else if (arg === '--url') args.url = argv[++i] || DEFAULT_CAPTURE_URL;
    else if (arg === '--check') args.check = true;
    else if (arg === '--json') args.json = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
};

const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(path, 'utf8'));

const writeResult = (payload: CaptureResult, { json }: Pick<CaptureArgs, 'json'>): void => {
  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }
  if (payload.ok) {
    console.log(
      `OK ${payload.mode}: ${payload.profileName} (${payload.tokenCount} tokens)${
        payload.outputPath ? ` -> ${payload.outputPath}` : ''
      }`,
    );
    return;
  }
  console.error(payload.error);
};

const checkFixture = async (fixturePath: string): Promise<CaptureResult> => {
  const manifest = sanitizeNativeStyleCaptureManifest(
    (await readJson(fixturePath)) as NativeStyleCaptureManifest,
  );
  const validation = validateNativeStyleCaptureManifest(manifest);
  if (!validation.ok) {
    throw new Error(validation.errors.join('\n'));
  }
  const profile = nativeStyleProfileFromCapture(manifest);
  return {
    ok: true,
    mode: 'check',
    profileName: profile.name,
    tokenCount: validation.tokenCount,
    outputPath: null,
  };
};

const visibleElementForSelectors = async (
  page: MinimalPage,
  selectors: string[],
  targetId: string,
): Promise<{ locator: MinimalLocator; selector: string }> => {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    const count = await page.locator(selector).count().catch(() => 0);
    if (count <= 0) continue;
    const visible = await locator.isVisible().catch(() => false);
    if (visible) return { locator, selector };
  }
  throw new Error(`No visible native element found for ${targetId}`);
};

const applyState = async (locator: MinimalLocator, state: NativeStyleStateName): Promise<void> => {
  if (state === 'hover') await locator.hover({ trial: false });
  if (state === 'focus') await locator.focus();
  if (state === 'pressed') {
    await locator.hover({ trial: false });
    await locator.page().mouse.down();
  }
};

const releaseState = async (
  locator: MinimalLocator,
  state: NativeStyleStateName,
): Promise<void> => {
  if (state === 'pressed') await locator.page().mouse.up().catch(() => {});
};

const computedToken = async (
  locator: MinimalLocator,
  cssVar: string,
  property: string,
): Promise<{ cssVar: string; property: string; value: string }> => {
  const value = await locator.evaluate((element, prop) => {
    const style = getComputedStyle(element);
    return style.getPropertyValue(prop).trim();
  }, property);
  return { cssVar, property, value };
};

const importPlaywright = async (): Promise<MinimalPlaywright> => {
  try {
    const dynamicImport = new Function('specifier', 'return import(specifier)') as (
      specifier: string,
    ) => Promise<MinimalPlaywright>;
    return await dynamicImport('playwright');
  } catch {
    throw new Error('Playwright is required for live capture. Use --fixture <path> --check without Playwright.');
  }
};

const captureLive = async ({ url, out }: Pick<CaptureArgs, 'url' | 'out'>): Promise<CaptureResult> => {
  if (!out) throw new Error('--out is required for live capture');
  const playwright = await importPlaywright();

  const browser = await playwright.chromium.launch({ headless: false });
  const page = await browser.newPage();
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const targets: NativeStyleCaptureManifest['targets'] = [];
  try {
    for (const spec of TARGET_SPECS) {
      const { locator, selector } = await visibleElementForSelectors(page, spec.selectors, spec.id);
      const states: NativeStyleCaptureManifest['targets'][number]['states'] = {};
      for (const [stateName, cssVar, property] of spec.tokens) {
        states[stateName] = states[stateName] || { tokens: [] };
        await applyState(locator, stateName);
        states[stateName]?.tokens.push(await computedToken(locator, cssVar, property));
        await releaseState(locator, stateName);
      }
      targets.push({
        id: spec.id,
        selector,
        matchedBy: spec.matchedBy,
        states,
      });
    }
  } finally {
    await browser.close();
  }

  const manifest = sanitizeNativeStyleCaptureManifest({
    schemaVersion: 1,
    profileName: 'gemini-lr26-dia-native',
    profileVersion: 1,
    source: {
      method: 'playwright-computed-style',
      capturedAt: new Date().toISOString(),
      host: new URL(url).host,
      routeKind: 'app',
      browser: 'chromium',
    },
    targets,
  });
  const validation = validateNativeStyleCaptureManifest(manifest);
  if (!validation.ok) throw new Error(validation.errors.join('\n'));

  const outputPath = resolve(ROOT, out);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return {
    ok: true,
    mode: 'capture',
    profileName: manifest.profileName,
    tokenCount: validation.tokenCount,
    outputPath,
  };
};

const main = async (): Promise<CaptureResult> => {
  const args = parseArgs(process.argv.slice(2));
  if (args.check) {
    if (!args.fixture) throw new Error('--fixture is required with --check');
    return checkFixture(resolve(ROOT, args.fixture));
  }
  return captureLive({ url: args.url, out: args.out });
};

main()
  .then((payload) => {
    writeResult(payload, parseArgs(process.argv.slice(2)));
  })
  .catch((err: unknown) => {
    const args = parseArgs(process.argv.slice(2));
    writeResult({ ok: false, error: err instanceof Error ? err.message : String(err) }, args);
    process.exitCode = 1;
  });
