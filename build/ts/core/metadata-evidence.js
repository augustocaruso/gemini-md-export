import { portableIsoSeconds } from './date.js';
import { hashText } from './text-hash.js';
export const sampleText = (value, max = 1200) => String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
const stripMarkdownSyntax = (value) => String(value || '')
    .replace(/!\[[^\]]*]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, ' $1 ')
    .replace(/[`*_~>#|]+/g, ' ');
export const normalizeComparableText = (value) => stripMarkdownSyntax(value)
    .normalize('NFKC')
    .normalize('NFKD')
    .replace(/\p{Mark}/gu, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, ' ')
    .trim()
    .toLowerCase();
export const assistantFragments = (value) => {
    const comparable = normalizeComparableText(sampleText(value, 1800));
    const words = comparable.split(/\s+/).filter((word) => word.length > 2);
    const size = 8;
    if (words.length < size)
        return [];
    const starts = new Set([
        0,
        Math.max(0, Math.floor(words.length * 0.15)),
        Math.max(0, Math.floor(words.length * 0.35)),
        Math.max(0, Math.floor(words.length * 0.6)),
        Math.max(0, words.length - size),
    ]);
    return Array.from(starts)
        .map((start) => words.slice(start, start + size).join(' '))
        .filter((fragment) => fragment.length >= 42);
};
const promptIsImageOnly = (value) => {
    const text = String(value || '');
    if (!/!\[[^\]]*\]\([^)]+\)/.test(text))
        return false;
    const withoutImages = text.replace(/!\[[^\]]*\]\([^)]+\)/g, ' ');
    return !/[A-Za-zÀ-ÿ0-9]{4,}/.test(withoutImages);
};
export const candidateNeedles = (candidate, options = {}) => {
    const needles = [];
    const add = (kind, value, weight, haystack, requiresPromptComparable) => {
        const text = sampleText(value, 500);
        const comparable = normalizeComparableText(text);
        const minLength = kind === 'created' || kind === 'last_message'
            ? (options.minPromptLength ?? options.minLength ?? 16)
            : kind === 'assistant'
                ? (options.minAssistantLength ?? options.minLength ?? 16)
                : (options.minTitleLength ?? options.minLength ?? 16);
        if (comparable.length >= minLength) {
            needles.push({
                kind,
                text,
                comparable,
                weight,
                length: comparable.length,
                haystack,
                requiresPromptComparable,
            });
        }
    };
    const addAssistantFragments = (kind, value, requiresPromptComparable) => {
        for (const fragment of assistantFragments(value)) {
            add(kind, fragment, 0.42, 'full_text', requiresPromptComparable);
        }
    };
    const firstPromptComparable = normalizeComparableText(candidate.scoring.firstPrompt);
    const lastPromptComparable = normalizeComparableText(candidate.scoring.lastPrompt);
    const firstAssistantPromptRequirement = promptIsImageOnly(candidate.scoring.firstPrompt)
        ? undefined
        : firstPromptComparable.length >= 2
            ? firstPromptComparable
            : undefined;
    const lastAssistantPromptRequirement = promptIsImageOnly(candidate.scoring.lastPrompt)
        ? undefined
        : lastPromptComparable.length >= 2
            ? lastPromptComparable
            : undefined;
    add('title', candidate.scoring.title, 0.32, 'full_text');
    add('created', candidate.scoring.firstPrompt, 0.62, 'prompt');
    add('last_message', candidate.scoring.lastPrompt, 0.62, 'prompt');
    add('created', candidate.scoring.firstAssistant, 0.42, 'full_text', firstAssistantPromptRequirement);
    addAssistantFragments('created', candidate.scoring.firstAssistant, firstAssistantPromptRequirement);
    add('last_message', candidate.scoring.lastAssistant, 0.42, 'full_text', lastAssistantPromptRequirement);
    addAssistantFragments('last_message', candidate.scoring.lastAssistant, lastAssistantPromptRequirement);
    for (const sample of candidate.scoring.assistantSamples || [])
        add('assistant', sample, 0.42, 'full_text');
    return needles;
};
export const scoreMetadataEvidence = (candidate, input) => {
    const date = portableIsoSeconds(input.date);
    if (!date)
        return null;
    if (input.source === 'takeout-json' && input.kind) {
        return {
            chatId: String(candidate.chatId).toLowerCase(),
            source: input.source,
            kind: input.kind,
            dateKind: input.kind === 'created' || input.kind === 'last_message' ? input.kind : 'unknown',
            confidence: 'strong',
            date,
            score: input.score ?? 1,
            textHash: input.textHash || undefined,
            sampleHash: input.sampleHash || undefined,
            sampleLength: input.sampleLength ?? undefined,
            warnings: [],
        };
    }
    const comparableText = normalizeComparableText(input.text);
    const hits = [];
    let score = 0;
    for (const needle of candidateNeedles(candidate)) {
        if (!comparableText.includes(needle.comparable))
            continue;
        hits.push(needle);
        score += needle.weight;
    }
    const promptHits = hits.filter((hit) => hit.kind === 'created' || hit.kind === 'last_message');
    const assistantHits = hits.filter((hit) => hit.kind === 'assistant');
    const titleHits = hits.filter((hit) => hit.kind === 'title');
    const hasLongPrompt = promptHits.some((hit) => hit.length >= 48);
    if (!promptHits.length && (!titleHits.length || !assistantHits.length))
        return null;
    if (promptHits.length && !hasLongPrompt && !assistantHits.length && !titleHits.length)
        return null;
    const kinds = new Set(promptHits.map((hit) => hit.kind));
    const kind = kinds.size === 1 ? Array.from(kinds)[0] : 'unknown';
    return {
        chatId: String(candidate.chatId).toLowerCase(),
        source: input.source,
        kind,
        dateKind: kind === 'created' || kind === 'last_message' ? kind : 'unknown',
        confidence: score >= 0.72 ? 'strong' : 'weak',
        date,
        score: Math.min(1, Number(score.toFixed(2))),
        textHash: input.textHash || hashText(input.text),
        sampleHash: input.sampleHash || hashText(hits.map((hit) => `${hit.kind}:${hit.text}`).join('\n')),
        sampleLength: input.sampleLength ?? String(input.text || '').length,
        warnings: [],
    };
};
const dateFromEvidence = (match) => portableIsoSeconds(match.date || match.timestamp || match.time);
export const groupMetadataEvidence = (matches = []) => {
    const grouped = new Map();
    for (const match of matches) {
        const chatId = String(match.chatId || '').toLowerCase();
        const date = dateFromEvidence(match);
        if (!chatId || !date)
            continue;
        const current = grouped.get(chatId) || { created: [], last: [], evidence: [] };
        const kind = String(match.kind || match.dateKind || 'unknown');
        const evidence = {
            chatId: chatId,
            source: (match.source || 'takeout-html'),
            kind,
            dateKind: kind === 'created' || kind === 'last_message' ? kind : 'unknown',
            confidence: match.confidence || 'strong',
            date,
            score: Number(match.score || 0),
            textHash: match.textHash || undefined,
            sampleHash: match.sampleHash || undefined,
            sampleLength: match.sampleLength || undefined,
            warnings: match.warnings || [],
        };
        current.evidence.push(evidence);
        if (kind === 'created')
            current.created.push(date);
        else if (kind === 'last_message')
            current.last.push(date);
        grouped.set(chatId, current);
    }
    const result = new Map();
    for (const [chatId, value] of grouped.entries()) {
        result.set(chatId, {
            status: 'matched',
            dateCreated: value.created.sort()[0] || null,
            dateLastMessage: value.last.sort().at(-1) || null,
            evidence: value.evidence,
        });
    }
    return result;
};
