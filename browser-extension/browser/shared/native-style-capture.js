export const REQUIRED_NATIVE_STYLE_TARGETS = [
    'topbar.iconButton',
    'topbar.tooltip',
    'menu.panel',
    'menu.item',
    'menu.itemChecked',
    'modal.panel',
    'modal.list',
    'modal.checkbox',
];
const FORBIDDEN_FIELDS = new Set([
    'outerHTML',
    'innerHTML',
    'textContent',
    'innerText',
    'href',
    'url',
    'sampleText',
]);
const isRecord = (value) => !!value && typeof value === 'object' && !Array.isArray(value);
const cloneJson = (value) => JSON.parse(JSON.stringify(value));
const collectForbiddenFieldErrors = (value, path = '', errors = []) => {
    if (Array.isArray(value)) {
        value.forEach((item, index) => {
            collectForbiddenFieldErrors(item, path ? `${path}.${index}` : String(index), errors);
        });
        return errors;
    }
    if (!isRecord(value))
        return errors;
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
const stripForbiddenFields = (value) => {
    if (Array.isArray(value))
        return value.map(stripForbiddenFields);
    if (!isRecord(value))
        return value;
    const next = {};
    Object.entries(value).forEach(([key, item]) => {
        if (FORBIDDEN_FIELDS.has(key))
            return;
        next[key] = stripForbiddenFields(item);
    });
    return next;
};
const stateEntries = (target) => Object.entries(target.states || {}).filter((entry) => Array.isArray(entry[1]?.tokens));
export const sanitizeNativeStyleCaptureManifest = (manifest) => stripForbiddenFields(cloneJson(manifest));
export const validateNativeStyleCaptureManifest = (manifest) => {
    const errors = collectForbiddenFieldErrors(manifest);
    let tokenCount = 0;
    if (!isRecord(manifest)) {
        return {
            ok: false,
            errors: ['manifest must be an object'],
            missingTargets: [...REQUIRED_NATIVE_STYLE_TARGETS],
            tokenCount,
        };
    }
    if (manifest.schemaVersion !== 1)
        errors.push('schemaVersion must be 1');
    if (typeof manifest.profileName !== 'string' || !manifest.profileName) {
        errors.push('profileName is required');
    }
    if (!Number.isInteger(manifest.profileVersion))
        errors.push('profileVersion must be an integer');
    if (!isRecord(manifest.source))
        errors.push('source is required');
    if (!Array.isArray(manifest.targets))
        errors.push('targets must be an array');
    const targets = Array.isArray(manifest.targets)
        ? manifest.targets
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
                if (!token.cssVar)
                    errors.push(`${tokenPath}.missing cssVar`);
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
export const nativeStyleProfileFromCapture = (manifest) => {
    const validation = validateNativeStyleCaptureManifest(manifest);
    if (!validation.ok) {
        throw new Error(`Invalid native style capture:\n${validation.errors.join('\n')}`);
    }
    const cssVars = {};
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
