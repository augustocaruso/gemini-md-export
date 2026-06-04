const asRecord = (value) => value && typeof value === 'object' ? value : {};
export const connectedClientCountFromReady = (ready = {}) => {
    const record = asRecord(ready);
    return (Number(record.connectedClientCount ?? record.connectedClients?.length ?? record.clients?.length ?? 0) || 0);
};
export const readinessIssueCode = (issue) => {
    if (!issue)
        return '';
    if (typeof issue === 'string')
        return issue;
    if (typeof issue === 'object') {
        const record = issue;
        return String(record.code || record.reason || record.type || record.message || '').trim();
    }
    return String(issue).trim();
};
export const readinessIssueMessage = (issue) => {
    if (!issue)
        return '';
    if (typeof issue === 'string')
        return issue;
    if (typeof issue === 'object') {
        const record = issue;
        return String(record.message || record.code || record.reason || record.type || '').trim();
    }
    return String(issue).trim();
};
export const readinessIssueDisplay = (issue, fallback = 'desconhecido') => readinessIssueCode(issue) || readinessIssueMessage(issue) || fallback;
export const browserDiagnosticMessage = (diagnosis = {}) => {
    if (diagnosis.kind === 'google_sorry') {
        return 'O Google abriu uma tela de verificação antes do Gemini. Resolva essa tela no navegador e rode o comando de novo.';
    }
    if (diagnosis.kind === 'google_login') {
        return 'O navegador está no login do Google. Conclua o login e rode o comando de novo.';
    }
    if (diagnosis.kind === 'other') {
        return `O navegador abriu, mas não chegou ao Gemini Web${diagnosis.url ? ` (${diagnosis.url})` : ''}.`;
    }
    if (diagnosis.kind === 'gemini') {
        return 'Gemini Web abriu, mas a extensão ainda não conectou. Recarregue a aba ou a extensão do navegador.';
    }
    return null;
};
export const browserDiagnosticBlockingIssue = (diagnosis = {}) => {
    if (diagnosis.kind === 'google_sorry')
        return 'google_verification_required';
    if (diagnosis.kind === 'google_login')
        return 'google_login_required';
    if (diagnosis.kind === 'other')
        return 'browser_not_on_gemini';
    if (diagnosis.kind === 'gemini')
        return 'extension_not_connected';
    return null;
};
export const attachBrowserDiagnosticToReady = (ready = {}, browserTabs = {}, { forceGemini = false } = {}) => {
    const diagnosis = browserTabs?.diagnosis || {};
    const blockingIssue = browserDiagnosticBlockingIssue(diagnosis);
    if (!blockingIssue && !forceGemini)
        return ready;
    const effectiveDiagnosis = forceGemini && diagnosis.kind === 'gemini' ? { ...diagnosis, terminal: true } : diagnosis;
    const message = browserDiagnosticMessage(effectiveDiagnosis);
    return {
        ...ready,
        blockingIssue: blockingIssue || ready.blockingIssue,
        browserDiagnostic: {
            ...browserTabs,
            diagnosis: effectiveDiagnosis,
            message,
        },
        extensionReadiness: {
            ...(ready.extensionReadiness || {}),
            nextAction: {
                ...(ready.extensionReadiness?.nextAction || {}),
                message: message || ready.extensionReadiness?.nextAction?.message || null,
            },
        },
    };
};
