export type GeminiPrivateSessionFields = Readonly<{
  at: string;
  bl?: string | null;
  fSid?: string | null;
  hl?: string | null;
}>;

const unescapeJsonString = (value: string): string => {
  try {
    return JSON.parse(`"${value.replace(/"/g, '\\"')}"`) as string;
  } catch {
    return value;
  }
};

const extractField = (html: string, key: string): string | null => {
  const match = html.match(new RegExp(`"${key}"\\s*:\\s*"(.*?)"`));
  return match?.[1] ? unescapeJsonString(match[1]) : null;
};

export const extractGeminiPrivateSessionFields = (
  html: string,
): GeminiPrivateSessionFields => ({
  at: extractField(html, 'SNlM0e') || '',
  bl: extractField(html, 'cfb2h'),
  fSid: extractField(html, 'FdrFJe'),
  hl: extractField(html, 'TuX5cc'),
});

export const looksLikeGoogleVerificationHtml = (value: string): boolean =>
  /<html[\s>]/i.test(value) &&
  (/\/sorry\//i.test(value) ||
    /CaptchaRedirect/i.test(value) ||
    /unusual traffic/i.test(value) ||
    /detected unusual traffic/i.test(value) ||
    /Our systems have detected/i.test(value) ||
    /<title>\s*Sorry/i.test(value));
