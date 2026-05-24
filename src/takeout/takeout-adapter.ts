import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { AhoCorasick } from '../core/aho-corasick.js';
import { portableIsoSeconds } from '../core/date.js';
import { resolveMetadataDatesForCandidate } from '../core/metadata-date-resolution.js';
import {
  assistantFragments,
  candidateNeedles,
  groupMetadataEvidence,
  normalizeComparableText,
  sampleText,
} from '../core/metadata-evidence.js';
import { hashText } from '../core/text-hash.js';
import type { ChatId, MetadataEvidence } from '../core/types.js';
import { readZipEntries } from '../core/zip-reader.js';

export type TakeoutCandidate = {
  chatId: string;
  turnCount?: number | null;
  scoring: {
    title?: string;
    firstPrompt?: string;
    lastPrompt?: string;
    firstAssistant?: string;
    lastAssistant?: string;
    assistantSamples?: string[];
  };
};

export type TakeoutItem = {
  date: string;
  text: string;
  promptText: string;
  comparableText: string;
  promptComparableText: string;
  textHash: string;
  sampleLength: number;
  chatId: string | null;
};

export type LoadedTakeoutSource = {
  sourceFile: string;
  sourcePath: string;
  sourceKind: 'html' | 'json' | 'zip';
  sourceEntries: string[];
  itemsIndexed: number;
  htmlItems: TakeoutItem[];
  jsonMatches: MetadataEvidence[];
};

type TakeoutNeedleHit = {
  chatId: string;
  kind: 'created' | 'last_message' | 'assistant' | 'title';
  text: string;
  comparable: string;
  weight: number;
  length: number;
  haystack?: 'prompt' | 'full_text';
  requiresPromptComparable?: string;
  promptMatch?: 'exact' | 'contains';
};

type TakeoutCandidateScore = {
  chatId: string;
  score: number;
  hits: TakeoutNeedleHit[];
};

type TakeoutEdgeRef = {
  chatId: string;
  kind: 'created' | 'last_message';
  text: string;
  comparable: string;
  length: number;
  assistantComparableFragments: string[];
};

type TakeoutEdgeHit = {
  edge: TakeoutEdgeRef;
  item: TakeoutItem;
  promptMatch: 'exact' | 'contains';
  assistantSupported: boolean;
};

const CHAT_ID_RE = /^[a-f0-9]{12,}$/i;
const URL_CHAT_ID_RE = /\/app\/([a-f0-9]{12,})/i;

const decodeHtmlEntities = (value: unknown): string =>
  String(value || '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&emsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&amp;/gi, '&')
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number.parseInt(dec, 10)));

export const htmlToPlainText = (html: unknown): string =>
  decodeHtmlEntities(
    String(html || '')
      .replace(/<\s*br\s*\/?\s*>/gi, '\n')
      .replace(/<\/(p|div|li|tr|table|h[1-6])\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

const TAKEOUT_MONTHS_PT = new Map<string, number>([
  ['jan', 1],
  ['jan.', 1],
  ['janeiro', 1],
  ['fev', 2],
  ['fev.', 2],
  ['fevereiro', 2],
  ['mar', 3],
  ['mar.', 3],
  ['março', 3],
  ['marco', 3],
  ['abr', 4],
  ['abr.', 4],
  ['abril', 4],
  ['mai', 5],
  ['mai.', 5],
  ['maio', 5],
  ['jun', 6],
  ['jun.', 6],
  ['junho', 6],
  ['jul', 7],
  ['jul.', 7],
  ['julho', 7],
  ['ago', 8],
  ['ago.', 8],
  ['agosto', 8],
  ['set', 9],
  ['set.', 9],
  ['setembro', 9],
  ['out', 10],
  ['out.', 10],
  ['outubro', 10],
  ['nov', 11],
  ['nov.', 11],
  ['novembro', 11],
  ['dez', 12],
  ['dez.', 12],
  ['dezembro', 12],
]);

const TAKEOUT_MONTHS_EN = new Map<string, number>([
  ['jan', 1],
  ['january', 1],
  ['feb', 2],
  ['february', 2],
  ['mar', 3],
  ['march', 3],
  ['apr', 4],
  ['april', 4],
  ['may', 5],
  ['jun', 6],
  ['june', 6],
  ['jul', 7],
  ['july', 7],
  ['aug', 8],
  ['august', 8],
  ['sep', 9],
  ['sept', 9],
  ['september', 9],
  ['oct', 10],
  ['october', 10],
  ['nov', 11],
  ['november', 11],
  ['dec', 12],
  ['december', 12],
]);

const parseTakeoutZoneOffsetMinutes = (zoneText: unknown): number | null => {
  const zone = String(zoneText || '').trim().toUpperCase();
  if (zone === 'BRT') return -180;
  if (zone === 'UTC' || zone === 'GMT') return 0;
  const gmtOffset = zone.match(/^(?:GMT|UTC)?([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!gmtOffset) return null;
  const [, sign, hourText, minuteText = '0'] = gmtOffset;
  const minutes = Number(hourText) * 60 + Number(minuteText);
  return sign === '-' ? -minutes : minutes;
};

const portableIsoFromTakeoutParts = ({
  year,
  month,
  day,
  hour,
  minute,
  second,
  offsetMinutes,
}: {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
}) =>
  portableIsoSeconds(
    new Date(Date.UTC(year, month - 1, day, hour, minute, second) - offsetMinutes * 60_000),
  );

export const parseTakeoutDate = (text: unknown): string | null => {
  const normalized = String(text || '').replace(/[\u00a0\u202f]/g, ' ');
  const ptMatch = normalized.match(
    /(\d{1,2})\s+de\s+([A-Za-zÀ-ÿ.]+)\s+de\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+([A-Z]{2,5})/i,
  );
  if (ptMatch) {
    const [, dayText, monthText, yearText, hourText, minuteText, secondText, zoneText] = ptMatch;
    const month = TAKEOUT_MONTHS_PT.get(monthText.toLowerCase());
    const offsetMinutes = parseTakeoutZoneOffsetMinutes(zoneText);
    if (!month || offsetMinutes === null) return null;
    return portableIsoFromTakeoutParts({
      year: Number(yearText),
      month,
      day: Number(dayText),
      hour: Number(hourText),
      minute: Number(minuteText),
      second: Number(secondText),
      offsetMinutes,
    });
  }

  const enMatch = normalized.match(
    /([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4}),\s+(\d{1,2}):(\d{2}):(\d{2})\s+(AM|PM)?\s*(GMT|UTC)?([+-]\d{1,2}:?\d{2})?/i,
  );
  if (!enMatch) return null;
  const [, monthText, dayText, yearText, hourText, minuteText, secondText, meridiemText, zonePrefix, offsetText] =
    enMatch;
  const month = TAKEOUT_MONTHS_EN.get(monthText.toLowerCase());
  const offsetMinutes = parseTakeoutZoneOffsetMinutes(`${zonePrefix || 'GMT'}${offsetText || ''}`);
  if (!month || offsetMinutes === null) return null;
  let hour = Number(hourText);
  if (meridiemText) {
    const meridiem = meridiemText.toUpperCase();
    if (meridiem === 'PM' && hour < 12) hour += 12;
    if (meridiem === 'AM' && hour === 12) hour = 0;
  }
  return portableIsoFromTakeoutParts({
    year: Number(yearText),
    month,
    day: Number(dayText),
    hour,
    minute: Number(minuteText),
    second: Number(secondText),
    offsetMinutes,
  });
};

const TAKEOUT_DATE_LINE_RE =
  /\n(?:\d{1,2}\s+de\s+[A-Za-zÀ-ÿ.]+\s+de\s+\d{4}|[A-Za-z]{3,9}\s+\d{1,2},\s+\d{4}),\s+\d{1,2}:\d{2}:\d{2}\s+(?:AM|PM)?\s*(?:(?:GMT|UTC)?[+-]\d{1,2}:?\d{2}|[A-Z]{2,5})/i;

const extractTakeoutPromptText = (text: string): string => {
  const prompted = String(text || '').match(/(?:\bPrompted\b|Added chat from link:)([\s\S]*)/i);
  if (!prompted) return '';
  const rest = prompted[1].replace(/^\s+/, '');
  const boundaries = [rest.search(/\nAttached\b/i), rest.search(TAKEOUT_DATE_LINE_RE)].filter(
    (index) => index >= 0,
  );
  const end = boundaries.length ? Math.min(...boundaries) : rest.length;
  return rest.slice(0, end).trim();
};

export const parseTakeoutHtmlItems = (html: unknown): TakeoutItem[] => {
  const cards =
    String(html || '').match(
      /<div class="outer-cell\b[\s\S]*?(?=<div class="outer-cell\b|<\/body>|<\/html>|$)/g,
    ) || [];
  return cards
    .map((card) => {
      const text = htmlToPlainText(card);
      const promptText = extractTakeoutPromptText(text);
      const date = parseTakeoutDate(text);
      if (!date || !/Gemini Apps/i.test(text)) return null;
      return {
        date,
        text,
        promptText,
        comparableText: normalizeComparableText(text),
        promptComparableText: normalizeComparableText(promptText),
        textHash: hashText(text),
        sampleLength: text.length,
        chatId: card.match(URL_CHAT_ID_RE)?.[1]?.toLowerCase() || null,
      };
    })
    .filter((item): item is TakeoutItem => Boolean(item));
};

const collectTakeoutObjects = (value: unknown, out: Record<string, unknown>[] = []) => {
  if (Array.isArray(value)) {
    for (const item of value) collectTakeoutObjects(item, out);
    return out;
  }
  if (!value || typeof value !== 'object') return out;
  out.push(value as Record<string, unknown>);
  for (const item of Object.values(value)) collectTakeoutObjects(item, out);
  return out;
};

const matchTakeoutHtmlItems = (items: TakeoutItem[], candidates: TakeoutCandidate[]) => {
  const matches: MetadataEvidence[] = [];
  const candidateByChatId = new Map(candidates.map((candidate) => [candidate.chatId.toLowerCase(), candidate]));
  const textMatcher = buildTakeoutTextMatcher(candidates);
  for (const item of items) {
    if (item.chatId && candidateByChatId.has(item.chatId)) {
      matches.push({
        chatId: item.chatId as MetadataEvidence['chatId'],
        source: 'takeout-html',
        kind: 'unknown',
        dateKind: 'unknown',
        confidence: 'strong',
        date: item.date as MetadataEvidence['date'],
        score: 1,
        textHash: item.textHash,
        sampleLength: item.sampleLength,
        warnings: [],
      });
      continue;
    }
    const textMatches = textMatcher(item);
    if (textMatches.length) {
      matches.push(...textMatches);
      continue;
    }
  }
  return preferExactPromptTakeoutMatches(
    dedupeTakeoutEvidence([...matches, ...matchTakeoutCandidateEdges(items, candidates)]),
  );
};

const preferExactPromptTakeoutMatches = (matches: MetadataEvidence[]): MetadataEvidence[] => {
  const exactPromptKindsByChatId = new Map<string, Set<MetadataEvidence['dateKind']>>();
  const assistantSupportedExactDateByChatKind = new Map<string, string>();
  const exactMatchesByChatKind = new Map<string, MetadataEvidence[]>();
  for (const match of matches) {
    if (!match.warnings?.includes('takeout_prompt_exact')) continue;
    const chatId = String(match.chatId || '').toLowerCase();
    const kinds = exactPromptKindsByChatId.get(chatId) || new Set<MetadataEvidence['dateKind']>();
    kinds.add(match.dateKind);
    exactPromptKindsByChatId.set(chatId, kinds);
    const key = `${chatId}:${match.dateKind}`;
    const exactMatches = exactMatchesByChatKind.get(key) || [];
    exactMatches.push(match);
    exactMatchesByChatKind.set(key, exactMatches);
  }
  for (const [key, exactMatches] of exactMatchesByChatKind.entries()) {
    const supportedDates = Array.from(
      new Set(
        exactMatches
          .filter((match) => match.warnings?.includes('takeout_assistant_hit'))
          .map((match) => match.date)
          .filter(Boolean),
      ),
    );
    if (supportedDates.length === 1) assistantSupportedExactDateByChatKind.set(key, supportedDates[0] as string);
  }
  if (!exactPromptKindsByChatId.size) return matches;
  return matches.filter((match) => {
    const chatId = String(match.chatId || '').toLowerCase();
    const assistantSupportedDate = assistantSupportedExactDateByChatKind.get(
      `${chatId}:${match.dateKind}`,
    );
    if (
      assistantSupportedDate &&
      match.warnings?.includes('takeout_prompt_exact') &&
      match.date !== assistantSupportedDate
    ) {
      return false;
    }
    const exactKinds = exactPromptKindsByChatId.get(chatId);
    if (!exactKinds) return true;
    if (match.warnings?.includes('takeout_prompt_exact')) return true;
    if (!match.warnings?.includes('takeout_prompt_contains')) return true;
    if (match.dateKind !== 'unknown') return true;
    return !exactKinds.has('unknown');
  });
};

const dedupeTakeoutEvidence = (matches: MetadataEvidence[]): MetadataEvidence[] => {
  const byKey = new Map<string, MetadataEvidence>();
  const rank = (match: MetadataEvidence) =>
    Number(match.score || 0) +
    (match.warnings?.includes('takeout_assistant_hit') ? 0.02 : 0) +
    (match.warnings?.includes('takeout_prompt_exact') ? 0.01 : 0);
  for (const match of matches) {
    const key = [
      String(match.chatId || '').toLowerCase(),
      match.dateKind,
      match.date,
      match.textHash || '',
      match.sampleHash || '',
    ].join('|');
    const current = byKey.get(key);
    if (!current || rank(match) > rank(current)) byKey.set(key, match);
  }
  return Array.from(byKey.values());
};

const edgeRefsForCandidate = (candidate: TakeoutCandidate): TakeoutEdgeRef[] => {
  if (!Number.isFinite(candidate.turnCount) || Number(candidate.turnCount) <= 1) return [];
  const refs: TakeoutEdgeRef[] = [];
  const add = (
    kind: TakeoutEdgeRef['kind'],
    prompt: unknown,
    assistantText: unknown,
  ) => {
    const text = sampleText(prompt, 500);
    const comparable = normalizeComparableText(text);
    if (comparable.length < 8) return;
    refs.push({
      chatId: candidate.chatId.toLowerCase(),
      kind,
      text,
      comparable,
      length: comparable.length,
      assistantComparableFragments: assistantFragments(assistantText),
    });
  };
  add('created', candidate.scoring.firstPrompt, candidate.scoring.firstAssistant);
  add('last_message', candidate.scoring.lastPrompt, candidate.scoring.lastAssistant);
  return refs;
};

const uniqueDates = (hits: TakeoutEdgeHit[]): string[] =>
  Array.from(new Set(hits.map((hit) => hit.item.date))).sort();

const pickEdgeHit = (hits: TakeoutEdgeHit[]): TakeoutEdgeHit | null => {
  if (!hits.length) return null;
  const supportedHits = hits.filter((hit) => hit.assistantSupported);
  const supportedDates = uniqueDates(supportedHits);
  if (supportedDates.length === 1) {
    return supportedHits.find((hit) => hit.item.date === supportedDates[0]) || null;
  }
  const exactHits = hits.filter((hit) => hit.promptMatch === 'exact');
  const exactDates = uniqueDates(exactHits);
  if (exactDates.length === 1) {
    return exactHits.find((hit) => hit.item.date === exactDates[0]) || null;
  }
  const allDates = uniqueDates(hits);
  if (allDates.length === 1) {
    return hits.find((hit) => hit.item.date === allDates[0]) || null;
  }
  return null;
};

const matchTakeoutCandidateEdges = (
  items: TakeoutItem[],
  candidates: TakeoutCandidate[],
): MetadataEvidence[] => {
  const edgeRefsByPattern = new Map<string, TakeoutEdgeRef[]>();
  for (const candidate of candidates) {
    for (const edge of edgeRefsForCandidate(candidate)) {
      const refs = edgeRefsByPattern.get(edge.comparable) || [];
      refs.push(edge);
      edgeRefsByPattern.set(edge.comparable, refs);
    }
  }
  if (!edgeRefsByPattern.size) return [];
  const automaton = new AhoCorasick(
    Array.from(edgeRefsByPattern.keys()).map((pattern, index) => ({
      id: String(index),
      pattern,
      value: pattern,
    })),
  );
  const hitsByChatEdge = new Map<string, TakeoutEdgeHit[]>();
  for (const item of items) {
    const patterns = new Set(automaton.search(item.promptComparableText).map((match) => match.value));
    for (const pattern of patterns) {
      for (const edge of edgeRefsByPattern.get(pattern) || []) {
        const promptMatch = item.promptComparableText === edge.comparable ? 'exact' : 'contains';
        if (promptMatch === 'contains' && edge.length < 24) continue;
        const assistantSupported = edge.assistantComparableFragments.some((fragment) =>
          item.comparableText.includes(fragment),
        );
        const key = `${edge.chatId}:${edge.kind}`;
        const current = hitsByChatEdge.get(key) || [];
        current.push({ edge, item, promptMatch, assistantSupported });
        hitsByChatEdge.set(key, current);
      }
    }
  }

  const evidence: MetadataEvidence[] = [];
  for (const hits of hitsByChatEdge.values()) {
    const picked = pickEdgeHit(hits);
    if (!picked) continue;
    const warnings = Array.from(
      new Set(
        [
          'takeout_edge_candidate',
          picked.promptMatch === 'exact' ? 'takeout_prompt_exact' : 'takeout_prompt_contains',
          picked.assistantSupported ? 'takeout_assistant_hit' : '',
        ].filter(Boolean),
      ),
    );
    evidence.push({
      chatId: picked.edge.chatId as ChatId,
      source: 'takeout-html',
      kind: picked.edge.kind,
      dateKind: picked.edge.kind,
      confidence: 'strong',
      date: picked.item.date as MetadataEvidence['date'],
      score:
        picked.promptMatch === 'exact' || picked.assistantSupported
          ? 1
          : 0.92,
      textHash: picked.item.textHash,
      sampleHash: hashText(`${picked.edge.kind}:${picked.edge.comparable}`),
      sampleLength: picked.item.sampleLength,
      warnings,
    });
  }
  return evidence;
};

const buildTakeoutTextMatcher = (candidates: TakeoutCandidate[]) => {
  const promptHitsByPattern = new Map<string, TakeoutNeedleHit[]>();
  const fullTextHitsByPattern = new Map<string, TakeoutNeedleHit[]>();
  for (const candidate of candidates) {
    for (const needle of candidateNeedles(candidate, { minPromptLength: 8 })) {
      const targetMap =
        needle.haystack === 'prompt'
          ? promptHitsByPattern
          : fullTextHitsByPattern;
      const hits = targetMap.get(needle.comparable) || [];
      hits.push({
        chatId: candidate.chatId.toLowerCase(),
        kind: needle.kind,
        text: needle.text,
        comparable: needle.comparable,
        weight: needle.weight,
        length: needle.length,
        haystack: needle.haystack,
        requiresPromptComparable: needle.requiresPromptComparable,
      });
      targetMap.set(needle.comparable, hits);
    }
  }

  const promptPatterns = Array.from(promptHitsByPattern.keys()).map((pattern, index) => ({
    id: String(index),
    pattern,
    value: pattern,
  }));
  const fullTextPatterns = Array.from(fullTextHitsByPattern.keys()).map((pattern, index) => ({
    id: String(index),
    pattern,
    value: pattern,
  }));
  const promptAutomaton = new AhoCorasick(promptPatterns);
  const fullTextAutomaton = new AhoCorasick(fullTextPatterns);
  const distinctCandidateCountByPattern = new Map(
    [...promptHitsByPattern.entries(), ...fullTextHitsByPattern.entries()].map(
      ([pattern, hits]) => [pattern, new Set(hits.map((hit) => hit.chatId)).size],
    ),
  );

  return (item: TakeoutItem): MetadataEvidence[] => {
    const foundPromptPatterns = new Set(
      promptAutomaton.search(item.promptComparableText).map((match) => match.value),
    );
    const foundFullTextPatterns = new Set(
      fullTextAutomaton.search(item.comparableText).map((match) => match.value),
    );
    if (!foundPromptPatterns.size && !foundFullTextPatterns.size) return [];

    const byCandidate = new Map<string, TakeoutCandidateScore>();
    const addHits = (patterns: Set<string>, hitsByPattern: Map<string, TakeoutNeedleHit[]>) => {
      for (const pattern of patterns) {
        for (const hit of hitsByPattern.get(pattern) || []) {
          const promptMatch =
            hit.haystack === 'prompt'
              ? item.promptComparableText === hit.comparable
                ? 'exact'
                : 'contains'
              : undefined;
          if (
            hit.requiresPromptComparable &&
            !(
              item.promptComparableText === hit.requiresPromptComparable ||
              (hit.requiresPromptComparable.length >= 48 &&
                item.promptComparableText.includes(hit.requiresPromptComparable))
            )
          ) {
            continue;
          }
          const current = byCandidate.get(hit.chatId) || { chatId: hit.chatId, score: 0, hits: [] };
          const effectiveWeight =
            promptMatch === 'exact' && (hit.kind === 'created' || hit.kind === 'last_message')
              ? Math.max(hit.weight, 1.3)
              : hit.weight;
          current.score += effectiveWeight;
          current.hits.push({ ...hit, weight: effectiveWeight, promptMatch });
          byCandidate.set(hit.chatId, current);
        }
      }
    };
    addHits(foundPromptPatterns, promptHitsByPattern);
    addHits(foundFullTextPatterns, fullTextHitsByPattern);

    const scored = Array.from(byCandidate.values())
      .map((score) => ({
        score,
        rawScore: score.score,
        evidence: evidenceFromTakeoutScore({
          item,
          score,
          candidateCount: byCandidate.size,
          distinctCandidateCountByPattern,
        }),
      }))
      .filter((item): item is { score: TakeoutCandidateScore; rawScore: number; evidence: MetadataEvidence } =>
        Boolean(item.evidence),
      )
      .sort((a, b) => b.rawScore - a.rawScore);
    const [best, runnerUp] = scored;
    if (!best) return [];

    const independentlyAnchored = scored.filter(({ score, rawScore }) => {
      if (rawScore < 0.62) return false;
      const hasUniqueEdgePrompt = score.hits.some(
        (hit) =>
          (hit.kind === 'created' || hit.kind === 'last_message') &&
          Boolean(hit.promptMatch) &&
          hit.length >= 24 &&
          distinctCandidateCountByPattern.get(hit.comparable) === 1,
      );
      const hasEdgePrompt = score.hits.some(
        (hit) =>
          (hit.kind === 'created' || hit.kind === 'last_message') &&
          !hit.requiresPromptComparable &&
          hit.promptMatch === 'exact' &&
          hit.weight >= 0.62,
      );
      const hasEdgeAssistant = score.hits.some(
        (hit) =>
          (hit.kind === 'created' || hit.kind === 'last_message') &&
          (hit.requiresPromptComparable || hit.weight < 0.62),
      );
      const hasIndependentAssistant = score.hits.some(
        (hit) =>
          hit.kind === 'assistant' &&
          hit.length >= 80 &&
          distinctCandidateCountByPattern.get(hit.comparable) === 1,
      );
      if (hasUniqueEdgePrompt) return true;
      if (rawScore < 1.04) return false;
      return hasEdgePrompt && (hasEdgeAssistant || hasIndependentAssistant);
    });
    if (independentlyAnchored.length) {
      return independentlyAnchored.map((item) => item.evidence);
    }

    if (runnerUp && runnerUp.rawScore >= best.rawScore - 0.05) return [];
    return [best.evidence];
  };
};

const evidenceFromTakeoutScore = ({
  item,
  score,
  candidateCount,
  distinctCandidateCountByPattern,
}: {
  item: TakeoutItem;
  score: TakeoutCandidateScore;
  candidateCount: number;
  distinctCandidateCountByPattern: Map<string, number>;
}): MetadataEvidence | null => {
  const promptHits = score.hits.filter(
    (hit) => hit.kind === 'created' || hit.kind === 'last_message',
  );
  const assistantHits = score.hits.filter((hit) => hit.kind === 'assistant');
  const titleHits = score.hits.filter((hit) => hit.kind === 'title');
  const hasLongPrompt = promptHits.some((hit) => hit.length >= 48);
  const hasUsableExactPrompt = promptHits.some(
    (hit) => hit.promptMatch === 'exact' && (candidateCount === 1 || hit.length >= 24),
  );
  const uniquePromptOnly =
    promptHits.some(
      (hit) =>
        Boolean(hit.promptMatch) &&
        hit.length >= 24 &&
        distinctCandidateCountByPattern.get(hit.comparable) === 1,
    );
  const longUniqueAssistant =
    assistantHits.some(
      (hit) => hit.length >= 80 && distinctCandidateCountByPattern.get(hit.comparable) === 1,
    );

  if (!promptHits.length && !(titleHits.length && assistantHits.length) && !longUniqueAssistant) {
    return null;
  }
  if (
    promptHits.length &&
    !hasLongPrompt &&
    !hasUsableExactPrompt &&
    !assistantHits.length &&
    !titleHits.length &&
    !uniquePromptOnly
  ) {
    return null;
  }

  const normalizedScore = Math.min(1, Number(score.score.toFixed(2)));
  if (normalizedScore < 0.72 && !uniquePromptOnly && !longUniqueAssistant && !hasUsableExactPrompt) {
    return null;
  }

  const promptKinds = new Set(promptHits.map((hit) => hit.kind));
  const kind = promptKinds.size === 1 ? Array.from(promptKinds)[0] : 'unknown';
  const promptMatchWarnings = Array.from(
    new Set(
      [
        ...promptHits.map((hit) =>
          hit.promptMatch === 'exact'
            ? 'takeout_prompt_exact'
            : hit.promptMatch === 'contains'
              ? 'takeout_prompt_contains'
              : '',
        ),
        assistantHits.length ? 'takeout_assistant_hit' : '',
      ].filter(Boolean),
    ),
  );
  return {
    chatId: score.chatId as ChatId,
    source: 'takeout-html',
    kind,
    dateKind: kind === 'created' || kind === 'last_message' ? kind : 'unknown',
    confidence: 'strong',
    date: item.date as MetadataEvidence['date'],
    score: normalizedScore,
    textHash: item.textHash,
    sampleHash: hashText(score.hits.map((hit) => `${hit.kind}:${hit.comparable}`).join('\n')),
    sampleLength: item.sampleLength,
    warnings: promptMatchWarnings,
  };
};

const loadTakeoutJsonMatchesFromText = (text: string): MetadataEvidence[] => {
  const parsed = JSON.parse(text);
  const matches: MetadataEvidence[] = [];
  for (const item of collectTakeoutObjects(parsed)) {
    const chatId =
      String(item.chatId || item.chat_id || '').match(CHAT_ID_RE)?.[0] ||
      String(item.url || item.link || item.titleUrl || '').match(URL_CHAT_ID_RE)?.[1] ||
      String(item.href || '').match(URL_CHAT_ID_RE)?.[1];
    const date = portableIsoSeconds(
      item.date || item.timestamp || item.time || item.time_usec || item.createdAt,
    );
    if (!chatId || !date) continue;
    matches.push({
      chatId: chatId.toLowerCase() as MetadataEvidence['chatId'],
      date,
      kind: String(item.kind || item.type || 'unknown'),
      dateKind:
        item.kind === 'created' || item.kind === 'last_message'
          ? (item.kind as MetadataEvidence['dateKind'])
          : 'unknown',
      confidence: 'strong',
      source: 'takeout-json',
      score: 1,
      textHash: item.textHash || item.hash ? String(item.textHash || item.hash) : undefined,
      warnings: [],
    });
  }
  return matches;
};

const loadTakeoutJsonMatches = (path: string): MetadataEvidence[] =>
  loadTakeoutJsonMatchesFromText(readFileSync(path, 'utf-8'));

const isTakeoutHtmlEntry = (name: string): boolean => /\.html?$/i.test(name);
const isTakeoutJsonEntry = (name: string): boolean => /\.json$/i.test(name);

export const matchTakeoutItems = (
  items: TakeoutItem[],
  candidates: TakeoutCandidate[] = [],
): MetadataEvidence[] => matchTakeoutHtmlItems(items, candidates);

export const matchTakeoutSource = (
  source: LoadedTakeoutSource,
  candidates: TakeoutCandidate[] = [],
): MetadataEvidence[] => {
  const candidateIds = new Set(candidates.map((candidate) => candidate.chatId.toLowerCase()));
  const jsonMatches = source.jsonMatches.filter((match) =>
    candidateIds.size ? candidateIds.has(String(match.chatId || '').toLowerCase()) : true,
  );
  return [...matchTakeoutItems(source.htmlItems, candidates), ...jsonMatches];
};

export const loadTakeoutSource = (path: string): LoadedTakeoutSource => {
  const resolved = resolve(path);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Takeout nao encontrado: ${resolved}`);
  }
  const sourceFile = basename(resolved);
  const raw = readFileSync(resolved);
  if (/\.zip$/i.test(resolved)) {
    const htmlItems: TakeoutItem[] = [];
    const jsonMatches: MetadataEvidence[] = [];
    const sourceEntries: string[] = [];
    for (const entry of readZipEntries(raw)) {
      if (entry.name.endsWith('/')) continue;
      if (isTakeoutHtmlEntry(entry.name)) {
        const items = parseTakeoutHtmlItems(entry.data.toString('utf-8'));
        if (!items.length) continue;
        htmlItems.push(...items);
        sourceEntries.push(entry.name);
      } else if (isTakeoutJsonEntry(entry.name)) {
        try {
          const matches = loadTakeoutJsonMatchesFromText(entry.data.toString('utf-8'));
          if (!matches.length) continue;
          jsonMatches.push(...matches);
          sourceEntries.push(entry.name);
        } catch {
          // Takeout pode conter JSON de outros produtos; ignorar entradas que nao seguem contrato de atividade.
        }
      }
    }
    return {
      sourceFile,
      sourcePath: resolved,
      sourceKind: 'zip',
      sourceEntries,
      itemsIndexed: htmlItems.length + jsonMatches.length,
      htmlItems,
      jsonMatches,
    };
  }

  const text = raw.toString('utf-8');
  if (/^\s*</.test(text) || /\.html?$/i.test(resolved)) {
    const htmlItems = parseTakeoutHtmlItems(text);
    return {
      sourceFile,
      sourcePath: resolved,
      sourceKind: 'html',
      sourceEntries: [sourceFile],
      itemsIndexed: htmlItems.length,
      htmlItems,
      jsonMatches: [],
    };
  }
  const jsonMatches = loadTakeoutJsonMatchesFromText(text);
  return {
    sourceFile,
    sourcePath: resolved,
    sourceKind: 'json',
    sourceEntries: [sourceFile],
    itemsIndexed: jsonMatches.length,
    htmlItems: [],
    jsonMatches,
  };
};

export const loadTakeoutMatches = (path: string, candidates: TakeoutCandidate[] = []) => {
  if (!path) return [];
  return matchTakeoutSource(loadTakeoutSource(path), candidates);
};

export const emptyTakeoutEvidence = (takeoutPath = '') => ({
  sourceFile: takeoutPath ? basename(takeoutPath) : null,
  summary: {
    enabled: Boolean(takeoutPath),
    itemsIndexed: 0,
    candidates: 0,
    matched: 0,
    unmatched: 0,
  },
  byChatId: new Map<string, unknown>(),
});

export const loadTakeoutEvidence = ({
  takeoutPath,
  candidates,
}: {
  takeoutPath: string;
  candidates: TakeoutCandidate[];
}) => {
  if (!takeoutPath) return emptyTakeoutEvidence('');
  const resolved = resolve(takeoutPath);
  if (!existsSync(resolved) || !statSync(resolved).isFile()) {
    throw new Error(`Takeout nao encontrado: ${resolved}`);
  }

  const source = loadTakeoutSource(resolved);
  const matches = matchTakeoutSource(source, candidates);

  const grouped = groupMetadataEvidence(matches);
  const byChatId = new Map<string, unknown>();
  for (const candidate of candidates) {
    const match = grouped.get(String(candidate.chatId).toLowerCase());
    const resolution = resolveMetadataDatesForCandidate({
      candidate,
      evidence: match?.evidence || [],
      existingDates: {
        dateCreated: null,
        dateLastMessage: null,
      },
    });
    byChatId.set(
      candidate.chatId,
      match
        ? {
            ...match,
            status: resolution.status,
            dateCreated: resolution.dateCreated,
            dateLastMessage: resolution.dateLastMessage,
            dateResolution: {
              chatShape: resolution.chatShape,
              turnCount: resolution.turnCount,
              hasCreatedEdge: resolution.hasCreatedEdge,
              hasLastMessageEdge: resolution.hasLastMessageEdge,
              hasUnknownEvidence: resolution.hasUnknownEvidence,
              unknownEvidencePolicy: resolution.unknownEvidencePolicy,
              warnings: resolution.warnings,
            },
          }
        : { status: 'unmatched', evidence: [] },
    );
  }

  const matched = Array.from(byChatId.values()).filter(
    (item) => (item as { status?: string }).status === 'matched',
  ).length;
  return {
    sourceFile: basename(resolved),
    summary: {
      enabled: true,
      itemsIndexed: source.itemsIndexed,
      candidates: candidates.length,
      matched,
      unmatched: Math.max(0, candidates.length - matched),
      sourceKind: source.sourceKind,
      sourceEntries: source.sourceEntries,
    },
    byChatId,
  };
};
