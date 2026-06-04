const normalizeText = (value) => String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
const detection = (code, kind, message, nextAction, input) => ({
    code,
    kind,
    terminal: true,
    message,
    nextAction,
    url: input.url || null,
    title: input.title || null,
});
const isGoogleHost = (hostname) => hostname === 'google.com' || hostname.endsWith('.google.com');
const isNormalExporterSurface = (hostname) => hostname === 'gemini.google.com' || hostname === 'myactivity.google.com';
export const detectGooglePageBlocker = (input = {}) => {
    const url = String(input.url || '').trim();
    let hostname = '';
    let pathname = '';
    let continueUrl = '';
    try {
        const parsed = new URL(url);
        hostname = parsed.hostname.toLowerCase();
        pathname = parsed.pathname.toLowerCase();
        continueUrl = String(parsed.searchParams.get('continue') || '').toLowerCase();
    }
    catch {
        // URL ausente ou parcial: cai para heurística por texto visível.
    }
    if (hostname.endsWith('google.com') &&
        pathname.startsWith('/sorry') &&
        (!continueUrl || continueUrl.includes('gemini.google.com'))) {
        return detection('google_verification_required', 'google_sorry', 'O Google abriu uma tela de verificacao antes do Gemini.', 'Resolva a verificacao no navegador e tente novamente.', input);
    }
    if (hostname === 'accounts.google.com') {
        return detection('google_login_required', 'google_login', 'O navegador esta no login do Google.', 'Conclua o login no navegador e tente novamente.', input);
    }
    const shouldUseVisibleTextHeuristics = !hostname || (isGoogleHost(hostname) && !isNormalExporterSurface(hostname));
    const text = normalizeText(`${input.title || ''}\n${input.bodyText || ''}`);
    const looksLikeGoogleVerification = shouldUseVisibleTextHeuristics &&
        (/\bunusual traffic\b/.test(text) ||
            /\bdetected unusual\b/.test(text) ||
            /\batividade suspeita\b/.test(text) ||
            /\btrafego incomum\b/.test(text) ||
            /\bverifique se voce nao e um robo\b/.test(text) ||
            /\bnao e um robo\b/.test(text) ||
            /\bto continue, please type\b/.test(text) ||
            /\bgoogle sorry\b/.test(text));
    if (looksLikeGoogleVerification) {
        return detection('google_verification_required', 'google_verification_text', 'O Google pediu verificacao antes de liberar o Gemini.', 'Resolva a verificacao no navegador e tente novamente.', input);
    }
    const looksBlocked = shouldUseVisibleTextHeuristics &&
        (/\baccess blocked\b/.test(text) ||
            /\bacesso bloqueado\b/.test(text) ||
            /\bthis browser or app may not be secure\b/.test(text) ||
            /\beste navegador ou app talvez nao seja seguro\b/.test(text));
    if (looksBlocked) {
        return detection('google_page_blocked', 'google_blocked_text', 'O Google bloqueou a pagina antes de liberar o Gemini.', 'Resolva o bloqueio no navegador e tente novamente.', input);
    }
    return null;
};
