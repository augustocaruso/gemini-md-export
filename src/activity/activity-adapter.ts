import type {
  ActivityDomAdapter,
  ActivityScanInput,
  ActivityScanResult,
} from '../browser/dom-adapter/types.js';
import { portableIsoSeconds } from '../core/date.js';
import { type MetadataCandidate, scoreMetadataEvidence } from '../core/metadata-evidence.js';
import { hashText } from '../core/text-hash.js';
import type { ChatId, IsoDateTime } from '../core/types.js';

export type ActivityDomAdapterOptions = {
  documentRef: Document;
};

const DEFAULT_MAX_CARDS = 1000;
const DATE_CONTEXT_PREVIOUS_SIBLING_LIMIT = 80;

const isElement = (value: unknown): value is Element =>
  Boolean(value && typeof (value as Element).querySelector === 'function');

const normalizeText = (value: unknown): string =>
  String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

const parseNumericTimestamp = (value: unknown): IsoDateTime | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const number = Number(raw.replace(/[^\d]/g, ''));
  if (!Number.isFinite(number) || number <= 0) return null;
  if (number > 10_000_000_000_000) {
    return portableIsoSeconds(new Date(Math.floor(number / 1000)));
  }
  if (number > 10_000_000_000) return portableIsoSeconds(new Date(number));
  return portableIsoSeconds(new Date(number * 1000));
};

const PT_MONTHS: Record<string, number> = {
  jan: 0,
  janeiro: 0,
  fev: 1,
  fevereiro: 1,
  mar: 2,
  marco: 2,
  março: 2,
  abr: 3,
  abril: 3,
  mai: 4,
  maio: 4,
  jun: 5,
  junho: 5,
  jul: 6,
  julho: 6,
  ago: 7,
  agosto: 7,
  set: 8,
  setembro: 8,
  out: 9,
  outubro: 9,
  nov: 10,
  novembro: 10,
  dez: 11,
  dezembro: 11,
};

const EN_MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const parseTimeParts = (text: unknown): { hour: number; minute: number; second: number } | null => {
  const match = String(text || '').match(/(?:^|[^\d])(\d{1,2}):(\d{2})(?:\s*(AM|PM))?/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = String(match[3] || '').toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute, second: 0 };
};

const localIsoFromParts = (
  { year, month, day }: { year: number; month: number; day: number },
  time: { hour: number; minute: number; second: number },
): IsoDateTime | null =>
  portableIsoSeconds(new Date(year, month, day, time.hour, time.minute, time.second));

const parsePortugueseDate = (dateText: unknown, cardText: unknown): IsoDateTime | null => {
  const normalized = normalizeText(dateText);
  const match = normalized.match(/\b(\d{1,2})\s+de\s+([a-z.]+)(?:\s+de\s+(\d{4}))?\b/);
  const time = parseTimeParts(cardText);
  if (!match || !time) return null;
  const month = PT_MONTHS[String(match[2] || '').replace(/\./g, '')];
  if (month === undefined) return null;
  return localIsoFromParts(
    {
      year: Number(match[3] || new Date().getFullYear()),
      month,
      day: Number(match[1]),
    },
    time,
  );
};

const parseEnglishDate = (dateText: unknown, cardText: unknown): IsoDateTime | null => {
  const normalized = normalizeText(dateText);
  const match = normalized.match(
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\.?\s+(\d{1,2})(?:,?\s+(\d{4}))?\b/,
  );
  const time = parseTimeParts(cardText);
  if (!match || !time) return null;
  const month = EN_MONTHS[String(match[1] || '').replace(/\./g, '')];
  if (month === undefined) return null;
  return localIsoFromParts(
    {
      year: Number(match[3] || new Date().getFullYear()),
      month,
      day: Number(match[2]),
    },
    time,
  );
};

const parseRelativeDate = (dateText: unknown, cardText: unknown): IsoDateTime | null => {
  const normalized = normalizeText(dateText);
  const time = parseTimeParts(cardText);
  if (!time) return null;
  const now = new Date();
  let offsetDays: number | null = null;
  if (/\b(today|hoje)\b/.test(normalized)) offsetDays = 0;
  if (/\b(yesterday|ontem)\b/.test(normalized)) offsetDays = -1;
  if (offsetDays === null) return null;
  const date = new Date(now.getFullYear(), now.getMonth(), now.getDate() + offsetDays);
  return localIsoFromParts(
    { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() },
    time,
  );
};

const parseTextualTimestamp = (dateText: unknown, cardText: unknown): IsoDateTime | null => {
  const time = parseTimeParts(cardText);
  if (!dateText || !time) return null;
  const relative = parseRelativeDate(dateText, cardText);
  if (relative) return relative;
  const pt = parsePortugueseDate(dateText, cardText);
  if (pt) return pt;
  const en = parseEnglishDate(dateText, cardText);
  if (en) return en;
  const timeText =
    String(cardText).match(/(?:^|[^\d])(\d{1,2}:\d{2}(?:\s*(?:AM|PM))?)/i)?.[1] || '';
  const parsed = new Date(`${String(dateText)} ${timeText}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return portableIsoSeconds(parsed);
};

const looksLikeDateContext = (text: unknown): boolean => {
  const normalized = normalizeText(text);
  if (!normalized || normalized.length > 90) return false;
  return (
    /\b(today|yesterday|hoje|ontem)\b/.test(normalized) ||
    /\b(january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sept|sep|october|oct|november|nov|december|dec)\b/.test(
      normalized,
    ) ||
    /\b\d{1,2}\s+de\s+[a-z.]+/.test(normalized)
  );
};

const findDateContextText = (card: Element): string => {
  for (
    let node: Element | null = card, depth = 0;
    node && node !== card.ownerDocument.body && depth < 8;
    node = node.parentElement, depth += 1
  ) {
    let sibling = node.previousElementSibling;
    for (
      let scanned = 0;
      sibling && scanned < DATE_CONTEXT_PREVIOUS_SIBLING_LIMIT;
      sibling = sibling.previousElementSibling
    ) {
      scanned += 1;
      const directText = String(sibling.textContent || '')
        .replace(/\s+/g, ' ')
        .trim();
      if (looksLikeDateContext(directText)) return directText;
      const heading = Array.from(sibling.querySelectorAll('h1,h2,h3,[role="heading"],time'))
        .reverse()
        .find((element) => looksLikeDateContext(element.textContent || ''));
      if (heading)
        return String(heading.textContent || '')
          .replace(/\s+/g, ' ')
          .trim();
    }
  }
  return '';
};

export const extractActivityCardDate = (card: Element): IsoDateTime | null => {
  const timestampEl = card.closest('[data-timestamp]') || card.querySelector('[data-timestamp]');
  const numeric =
    parseNumericTimestamp(card.getAttribute('data-timestamp')) ||
    parseNumericTimestamp(timestampEl?.getAttribute('data-timestamp')) ||
    parseNumericTimestamp(card.getAttribute('data-time'));
  if (numeric) return numeric;
  const cardText = card.textContent || '';
  const dateCandidates = [
    card.getAttribute('data-date'),
    card.closest('[data-date]')?.getAttribute('data-date'),
    card.querySelector('[data-date]')?.getAttribute('data-date'),
    findDateContextText(card),
  ].filter(Boolean);
  for (const dateText of dateCandidates) {
    const parsed = parseTextualTimestamp(dateText, cardText);
    if (parsed) return parsed;
  }
  return null;
};

const findActivityCards = (documentRef: Document, maxCards: number): Element[] => {
  const selectors = [
    '[data-timestamp]',
    '[data-date]',
    '[data-gm-activity-card]',
    '.activity-card',
    'c-wiz',
  ];
  const nestedCardSelector = '[data-timestamp],[data-date],[data-gm-activity-card],.activity-card';
  const isActivityLike = (element: Element): boolean => {
    const text = normalizeText(element.textContent || '');
    return text.includes('gemini') || Boolean(element.querySelector('[data-gm-activity-details]'));
  };
  const containsNestedActivity = (element: Element): boolean =>
    Array.from(element.querySelectorAll(nestedCardSelector)).some(
      (child) => child !== element && isActivityLike(child),
    );
  const seen = new Set<Element>();
  const cards: Element[] = [];
  for (const selector of selectors) {
    for (const element of Array.from(documentRef.querySelectorAll(selector))) {
      if (!isElement(element) || seen.has(element)) continue;
      if (!isActivityLike(element) || containsNestedActivity(element)) continue;
      seen.add(element);
      cards.push(element);
      if (cards.length >= maxCards) return cards;
    }
  }
  return cards;
};

export const createActivityDomAdapter = ({
  documentRef,
}: ActivityDomAdapterOptions): ActivityDomAdapter => ({
  scanLoadedEvidence(input: ActivityScanInput): ActivityScanResult {
    const maxCards = Math.max(
      1,
      Math.min(DEFAULT_MAX_CARDS, Number(input.maxCards || DEFAULT_MAX_CARDS)),
    );
    const candidates = input.candidates || [];
    const cards = findActivityCards(documentRef, maxCards);
    const evidence = [];
    const warnings = [];
    let lastSeenActivityToken: string | null = null;

    for (const [cardIndex, card] of cards.entries()) {
      const text = String(card.textContent || '');
      const date = extractActivityCardDate(card);
      if (!date) warnings.push(`card_${cardIndex}_missing_date`);
      const cardEvidence = [];
      for (const candidate of candidates) {
        const scored = scoreMetadataEvidence(candidate as MetadataCandidate, {
          source: 'my-activity-web',
          text,
          date,
          textHash: hashText(text),
          sampleLength: text.length,
        });
        if (scored) cardEvidence.push(scored);
      }
      cardEvidence.sort((left, right) => {
        const leftScore = Number(left.score || 0);
        const rightScore = Number(right.score || 0);
        if (rightScore !== leftScore) return rightScore - leftScore;
        return (right.sampleLength || 0) - (left.sampleLength || 0);
      });
      if (cardEvidence[0]) evidence.push(cardEvidence[0]);
      lastSeenActivityToken = date || hashText(text);
    }

    const unique = new Map<string, (typeof evidence)[number]>();
    for (const item of evidence) {
      unique.set(`${item.chatId || ''}:${item.dateKind}:${item.date || ''}`, item);
    }
    const uniqueEvidence = Array.from(unique.values());
    const resolvedChatIds = Array.from(
      new Set(uniqueEvidence.map((item) => item.chatId).filter(Boolean)),
    ) as ChatId[];

    return {
      evidence: uniqueEvidence,
      loadedCardCount: cards.length,
      scannedCardCount: cards.length,
      resolvedChatIds,
      lastSeenActivityToken,
      warnings,
    };
  },
});
