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
  janeiro: 0,
  fevereiro: 1,
  marco: 2,
  março: 2,
  abril: 3,
  maio: 4,
  junho: 5,
  julho: 6,
  agosto: 7,
  setembro: 8,
  outubro: 9,
  novembro: 10,
  dezembro: 11,
};

const parseTimeParts = (text: unknown): { hour: number; minute: number; second: number } | null => {
  const match = String(text || '').match(/\b(\d{1,2}):(\d{2})(?:\s*(AM|PM))?\b/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = String(match[3] || '').toUpperCase();
  if (meridiem === 'PM' && hour < 12) hour += 12;
  if (meridiem === 'AM' && hour === 12) hour = 0;
  if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
  return { hour, minute, second: 0 };
};

const parsePortugueseDate = (dateText: unknown, cardText: unknown): IsoDateTime | null => {
  const normalized = normalizeText(dateText);
  const match = normalized.match(/\b(\d{1,2})\s+de\s+([a-z]+)\s+de\s+(\d{4})\b/);
  const time = parseTimeParts(cardText);
  if (!match || !time) return null;
  const month = PT_MONTHS[match[2]];
  if (month === undefined) return null;
  return portableIsoSeconds(
    new Date(Number(match[3]), month, Number(match[1]), time.hour, time.minute, time.second),
  );
};

const parseTextualTimestamp = (dateText: unknown, cardText: unknown): IsoDateTime | null => {
  const time = parseTimeParts(cardText);
  if (!dateText || !time) return null;
  const pt = parsePortugueseDate(dateText, cardText);
  if (pt) return pt;
  const timeText = String(cardText).match(/\b\d{1,2}:\d{2}(?:\s*(?:AM|PM))?\b/i)?.[0] || '';
  const parsed = new Date(`${String(dateText)} ${timeText}`);
  if (Number.isNaN(parsed.getTime())) return null;
  return portableIsoSeconds(parsed);
};

export const extractActivityCardDate = (card: Element): IsoDateTime | null => {
  const timestampEl = card.closest('[data-timestamp]') || card.querySelector('[data-timestamp]');
  const numeric =
    parseNumericTimestamp(card.getAttribute('data-timestamp')) ||
    parseNumericTimestamp(timestampEl?.getAttribute('data-timestamp')) ||
    parseNumericTimestamp(card.getAttribute('data-time'));
  if (numeric) return numeric;
  const dateText =
    card.getAttribute('data-date') ||
    card.closest('[data-date]')?.getAttribute('data-date') ||
    card.querySelector('[data-date]')?.getAttribute('data-date') ||
    '';
  return parseTextualTimestamp(dateText, card.textContent || '');
};

const findActivityCards = (documentRef: Document, maxCards: number): Element[] => {
  const selectors = [
    '[data-timestamp]',
    '[data-date]',
    '[data-gm-activity-card]',
    '.activity-card',
    'c-wiz',
  ];
  const seen = new Set<Element>();
  const cards: Element[] = [];
  for (const selector of selectors) {
    for (const element of Array.from(documentRef.querySelectorAll(selector))) {
      if (!isElement(element) || seen.has(element)) continue;
      const text = normalizeText(element.textContent || '');
      if (!text.includes('gemini') && !element.querySelector('[data-gm-activity-details]')) {
        continue;
      }
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
      for (const candidate of candidates) {
        const scored = scoreMetadataEvidence(candidate as MetadataCandidate, {
          source: 'my-activity-web',
          text,
          date,
          textHash: hashText(text),
          sampleLength: text.length,
        });
        if (scored) evidence.push(scored);
      }
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
