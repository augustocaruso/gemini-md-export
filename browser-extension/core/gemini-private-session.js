const unescapeJsonString = (value) => {
    try {
        return JSON.parse(`"${value.replace(/"/g, '\\"')}"`);
    }
    catch {
        return value;
    }
};
const extractField = (html, key) => {
    const match = html.match(new RegExp(`"${key}"\\s*:\\s*"(.*?)"`));
    return match?.[1] ? unescapeJsonString(match[1]) : null;
};
export const extractGeminiPrivateSessionFields = (html) => ({
    at: extractField(html, 'SNlM0e') || '',
    bl: extractField(html, 'cfb2h'),
    fSid: extractField(html, 'FdrFJe'),
    hl: extractField(html, 'TuX5cc'),
});
export const looksLikeGoogleVerificationHtml = (value) => /<html[\s>]/i.test(value) &&
    (/\/sorry\//i.test(value) ||
        /CaptchaRedirect/i.test(value) ||
        /unusual traffic/i.test(value) ||
        /detected unusual traffic/i.test(value) ||
        /Our systems have detected/i.test(value) ||
        /<title>\s*Sorry/i.test(value));
