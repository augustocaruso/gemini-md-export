import type { GeminiNativeStyleProfile } from './native-style-profile.js';

export type NativeStyleStateName = 'base' | 'hover' | 'focus' | 'pressed' | 'checked' | 'disabled';

export type NativeStyleToken = {
  cssVar: string;
  property: string;
  value: string;
};

export type NativeStyleState = {
  tokens: NativeStyleToken[];
};

export type NativeElementTarget = {
  id: string;
  selector: string;
  matchedBy: string;
  states: Partial<Record<NativeStyleStateName, NativeStyleState>>;
};

export type NativeStyleCaptureManifest = {
  schemaVersion: 1;
  profileName: string;
  profileVersion: number;
  source: {
    method: string;
    capturedAt: string;
    host: string;
    routeKind: string;
    browser: string;
    fixture?: string;
  };
  targets: NativeElementTarget[];
};

export type NativeStyleValidationResult = {
  ok: boolean;
  errors: string[];
  missingTargets: string[];
  tokenCount: number;
};

export const REQUIRED_NATIVE_STYLE_TARGETS = [
  'topbar.iconButton',
  'topbar.tooltip',
  'menu.panel',
  'menu.item',
  'menu.itemChecked',
  'modal.panel',
  'modal.list',
  'modal.checkbox',
] as const;

const FORBIDDEN_FIELDS = new Set([
  'outerHTML',
  'innerHTML',
  'textContent',
  'innerText',
  'href',
  'url',
  'sampleText',
]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const cloneJson = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const collectForbiddenFieldErrors = (
  value: unknown,
  path = '',
  errors: string[] = [],
): string[] => {
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      collectForbiddenFieldErrors(item, path ? `${path}.${index}` : String(index), errors);
    });
    return errors;
  }
  if (!isRecord(value)) return errors;
  Object.entries(value).forEach(([key, item]) => {
    const nextPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_FIELDS.has(key)) {
      errors.push(`forbidden field: ${nextPath}`);
      return;
    }
    collectForbiddenFieldErrors(item, nextPath, errors);
  });
  return errors;
};

const stripForbiddenFields = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(stripForbiddenFields);
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = {};
  Object.entries(value).forEach(([key, item]) => {
    if (FORBIDDEN_FIELDS.has(key)) return;
    next[key] = stripForbiddenFields(item);
  });
  return next;
};

const stateEntries = (target: NativeElementTarget): Array<[string, NativeStyleState]> =>
  Object.entries(target.states || {}).filter((entry): entry is [string, NativeStyleState] =>
    Array.isArray(entry[1]?.tokens),
  );

export const sanitizeNativeStyleCaptureManifest = (
  manifest: NativeStyleCaptureManifest,
): NativeStyleCaptureManifest => stripForbiddenFields(cloneJson(manifest)) as NativeStyleCaptureManifest;

export const validateNativeStyleCaptureManifest = (
  manifest: unknown,
): NativeStyleValidationResult => {
  const errors: string[] = collectForbiddenFieldErrors(manifest);
  let tokenCount = 0;

  if (!isRecord(manifest)) {
    return {
      ok: false,
      errors: ['manifest must be an object'],
      missingTargets: [...REQUIRED_NATIVE_STYLE_TARGETS],
      tokenCount,
    };
  }

  if (manifest.schemaVersion !== 1) errors.push('schemaVersion must be 1');
  if (typeof manifest.profileName !== 'string' || !manifest.profileName) {
    errors.push('profileName is required');
  }
  if (!Number.isInteger(manifest.profileVersion)) errors.push('profileVersion must be an integer');
  if (!isRecord(manifest.source)) errors.push('source is required');
  if (!Array.isArray(manifest.targets)) errors.push('targets must be an array');

  const targets = Array.isArray(manifest.targets)
    ? (manifest.targets as NativeElementTarget[])
    : [];
  const targetIds = new Set(targets.map((target) => target?.id).filter(Boolean));
  const missingTargets = REQUIRED_NATIVE_STYLE_TARGETS.filter((id) => !targetIds.has(id));
  missingTargets.forEach((id) => errors.push(`missing target: ${id}`));

  targets.forEach((target, targetIndex) => {
    if (!target || typeof target !== 'object') {
      errors.push(`targets.${targetIndex} must be an object`);
      return;
    }
    if (typeof target.id !== 'string' || !target.id) {
      errors.push(`targets.${targetIndex}.id is required`);
    }
    if (typeof target.selector !== 'string' || !target.selector) {
      errors.push(`targets.${targetIndex}.selector is required`);
    }
    if (typeof target.matchedBy !== 'string' || !target.matchedBy) {
      errors.push(`targets.${targetIndex}.matchedBy is required`);
    }
    if (!isRecord(target.states)) {
      errors.push(`targets.${targetIndex}.states is required`);
      return;
    }
    stateEntries(target).forEach(([stateName, state]) => {
      state.tokens.forEach((token, tokenIndex) => {
        tokenCount += 1;
        const tokenPath = `targets.${targetIndex}.states.${stateName}.tokens.${tokenIndex}`;
        if (!token.cssVar) errors.push(`${tokenPath}.missing cssVar`);
        if (token.cssVar && !String(token.cssVar).startsWith('--gmn-')) {
          errors.push(`${tokenPath}.cssVar must start with --gmn-`);
        }
        if (typeof token.property !== 'string' || !token.property) {
          errors.push(`${tokenPath}.property is required`);
        }
        if (typeof token.value !== 'string' || !token.value) {
          errors.push(`${tokenPath}.value is required`);
        }
      });
    });
  });

  return {
    ok: errors.length === 0,
    errors,
    missingTargets,
    tokenCount,
  };
};

export const nativeStyleProfileFromCapture = (
  manifest: NativeStyleCaptureManifest,
): GeminiNativeStyleProfile => {
  const validation = validateNativeStyleCaptureManifest(manifest);
  if (!validation.ok) {
    throw new Error(`Invalid native style capture:\n${validation.errors.join('\n')}`);
  }

  const cssVars: Record<string, string> = {};
  manifest.targets.forEach((target) => {
    stateEntries(target).forEach(([, state]) => {
      state.tokens.forEach((token) => {
        cssVars[token.cssVar] = token.value;
      });
    });
  });

  return {
    name: manifest.profileName,
    version: manifest.profileVersion,
    source: `native-style-capture:${manifest.source.method}:${manifest.source.capturedAt}`,
    cssVars,
  };
};
