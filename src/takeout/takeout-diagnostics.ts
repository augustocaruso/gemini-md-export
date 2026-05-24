import { existsSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { AhoCorasick } from '../core/aho-corasick.js';
import { candidateNeedles, type MetadataNeedle } from '../core/metadata-evidence.js';
import { hashText } from '../core/text-hash.js';
import { loadTakeoutSource } from './takeout-adapter.js';

export type TakeoutDiagnosticCandidate = {
  chatId: string;
  title?: string;
  turnCount?: number | null;
  attachmentCount?: number | null;
  scoring: {
    title?: string;
    firstPrompt?: string;
    lastPrompt?: string;
    firstAssistant?: string;
    lastAssistant?: string;
    assistantSamples?: string[];
  };
};

export type RawExportDiagnosticCode =
  | 'takeout_source_mismatch_for_raw_chat'
  | 'takeout_no_evidence_for_raw_chat'
  | 'takeout_no_user_activity_for_assistant_only_chat'
  | 'takeout_ambiguous_duplicate_content'
  | 'takeout_multiple_edge_candidates_for_raw_chat'
  | 'takeout_first_edge_missing_for_raw_chat'
  | 'takeout_last_edge_missing_for_raw_chat'
  | 'takeout_weak_or_partial_evidence'
  | 'takeout_diagnostics_unavailable';

export type RawExportDiagnostic = {
  chatId: string;
  status: 'raw_export_suspected' | 'takeout_source_gap' | 'takeout_source_mismatch';
  code: RawExportDiagnosticCode;
  confidence: 'strong' | 'weak';
  sourceFile: string | null;
  evidence: {
    takeoutItemsIndexed: number;
    candidateHits: number;
    strongestDate: string | null;
    strongestTextHash: string | null;
    strongestPromptHash: string | null;
    competingChatIds: string[];
    attachmentCount: number;
    turnCount: number;
    edgeIntegrity: {
      hasFirstPromptEdge: boolean;
      hasLastPromptEdge: boolean;
      firstPromptDates: string[];
      lastPromptDates: string[];
    };
    truncation: {
      direction: 'head' | 'tail';
      message: string;
    } | null;
    corpus: {
      candidateCount: number;
      candidateHitCount: number;
      evidenceCoverage: number;
      noEvidencePendingCount: number;
      sourceMismatchLikely: boolean;
    };
  };
  repair: {
    action:
      | 'reexport_chat'
      | 'dedupe_or_reexport'
      | 'inspect_takeout_source'
      | 'use_matching_takeout_or_browser_profile';
    message: string;
  };
};

type IndexedNeedle = MetadataNeedle & {
  chatId: string;
  haystack: 'prompt' | 'full_text';
};

type IndexedTakeoutHit = {
  itemIndex: number;
  date: string;
  textHash: string;
  promptHash: string;
  byChatId: Map<string, IndexedNeedle[]>;
};

const candidatePromptIsImageOnly = (candidate: TakeoutDiagnosticCandidate): boolean => {
  const prompt = `${candidate.scoring.firstPrompt || ''} ${candidate.scoring.lastPrompt || ''}`;
  return (
    /!\[[^\]]*\]\(/.test(prompt) &&
    !/[A-Za-zÀ-ÿ0-9]{4,}/.test(prompt.replace(/!\[[^\]]*\]\([^)]+\)/g, ''))
  );
};

const candidateHasNoUserActivity = (candidate: TakeoutDiagnosticCandidate): boolean => {
  const firstPrompt = String(candidate.scoring.firstPrompt || '').trim();
  const lastPrompt = String(candidate.scoring.lastPrompt || '').trim();
  const assistantText = [
    candidate.scoring.firstAssistant,
    candidate.scoring.lastAssistant,
    ...(candidate.scoring.assistantSamples || []),
  ]
    .join(' ')
    .trim();
  return !firstPrompt && !lastPrompt && assistantText.length > 0;
};

const indexedNeedlesFor = (candidate: TakeoutDiagnosticCandidate): IndexedNeedle[] =>
  candidateNeedles(candidate, { minPromptLength: 8 }).map((needle) => ({
    ...needle,
    chatId: candidate.chatId.toLowerCase(),
    haystack:
      needle.haystack ||
      (needle.kind === 'created' || needle.kind === 'last_message' ? 'prompt' : 'full_text'),
  }));

const indexTakeoutHits = (
  takeoutPath: string,
  candidates: TakeoutDiagnosticCandidate[],
): { sourceFile: string | null; indexedItems: number; hits: IndexedTakeoutHit[] } => {
  if (!takeoutPath) return { sourceFile: null, indexedItems: 0, hits: [] };
  const resolved = resolve(takeoutPath);
  if (!existsSync(resolved)) return { sourceFile: basename(resolved), indexedItems: 0, hits: [] };
  const source = loadTakeoutSource(resolved);

  const promptNeedlesByPattern = new Map<string, IndexedNeedle[]>();
  const fullTextNeedlesByPattern = new Map<string, IndexedNeedle[]>();
  for (const needle of candidates.flatMap(indexedNeedlesFor)) {
    const target = needle.haystack === 'prompt' ? promptNeedlesByPattern : fullTextNeedlesByPattern;
    const current = target.get(needle.comparable) || [];
    current.push(needle);
    target.set(needle.comparable, current);
  }
  const promptMatcher = new AhoCorasick(
    Array.from(promptNeedlesByPattern.keys()).map((pattern, index) => ({
      id: `prompt-${index}`,
      pattern,
      value: pattern,
    })),
  );
  const fullTextMatcher = new AhoCorasick(
    Array.from(fullTextNeedlesByPattern.keys()).map((pattern, index) => ({
      id: `full-${index}`,
      pattern,
      value: pattern,
    })),
  );
  const items = source.htmlItems;
  const hits: IndexedTakeoutHit[] = [];
  for (const [itemIndex, item] of items.entries()) {
    const byChatId = new Map<string, IndexedNeedle[]>();
    const addNeedlesForPatterns = (
      patterns: Set<string>,
      needlesByPattern: Map<string, IndexedNeedle[]>,
    ) => {
      for (const pattern of patterns) {
        for (const needle of needlesByPattern.get(pattern) || []) {
          if (
            needle.requiresPromptComparable &&
            !item.promptComparableText.includes(needle.requiresPromptComparable)
          ) {
            continue;
          }
          const current = byChatId.get(needle.chatId) || [];
          current.push(needle);
          byChatId.set(needle.chatId, current);
        }
      }
    };
    addNeedlesForPatterns(
      new Set(promptMatcher.search(item.promptComparableText).map((match) => match.value)),
      promptNeedlesByPattern,
    );
    addNeedlesForPatterns(
      new Set(fullTextMatcher.search(item.comparableText).map((match) => match.value)),
      fullTextNeedlesByPattern,
    );
    if (!byChatId.size) continue;
    hits.push({
      itemIndex,
      date: item.date,
      textHash: item.textHash,
      promptHash: hashText(item.promptText || ''),
      byChatId,
    });
  }
  return { sourceFile: basename(resolved), indexedItems: source.itemsIndexed, hits };
};

const diagnosticFor = ({
  candidate,
  sourceFile,
  indexedItems,
  hits,
  corpusEvidence,
}: {
  candidate: TakeoutDiagnosticCandidate;
  sourceFile: string | null;
  indexedItems: number;
  hits: IndexedTakeoutHit[];
  corpusEvidence: {
    candidateCount: number;
    candidateHitCount: number;
    evidenceCoverage: number;
    noEvidencePendingCount: number;
    sourceMismatchLikely: boolean;
  };
}): RawExportDiagnostic => {
  const chatId = candidate.chatId.toLowerCase();
  const localHits = hits.filter((hit) => hit.byChatId.has(chatId));
  const best = localHits
    .map((hit) => ({
      hit,
      localScore: (hit.byChatId.get(chatId) || []).reduce((sum, needle) => sum + needle.weight, 0),
    }))
    .sort((a, b) => b.localScore - a.localScore)[0]?.hit;
  const competingChatIds = best
    ? Array.from(best.byChatId.keys())
        .filter((id) => id !== chatId)
        .sort()
    : [];

  if (!indexedItems) {
    return {
      chatId,
      status: 'raw_export_suspected',
      code: 'takeout_diagnostics_unavailable',
      confidence: 'weak',
      sourceFile,
      evidence: {
        takeoutItemsIndexed: indexedItems,
        candidateHits: 0,
        strongestDate: null,
        strongestTextHash: null,
        strongestPromptHash: null,
        competingChatIds: [],
        attachmentCount: candidate.attachmentCount || 0,
        turnCount: candidate.turnCount || 0,
        edgeIntegrity: {
          hasFirstPromptEdge: false,
          hasLastPromptEdge: false,
          firstPromptDates: [],
          lastPromptDates: [],
        },
        truncation: null,
        corpus: corpusEvidence,
      },
      repair: {
        action: 'inspect_takeout_source',
        message: 'Nao consegui indexar evidencias suficientes no Takeout informado.',
      },
    };
  }

  const hasOnlyImagePrompt = candidatePromptIsImageOnly(candidate);
  const edgeDatesFor = (kind: 'created' | 'last_message') =>
    Array.from(
      new Set(
        localHits
          .filter((hit) => (hit.byChatId.get(chatId) || []).some((needle) => needle.kind === kind))
          .map((hit) => hit.date),
      ),
    ).sort();
  const firstPromptDates = edgeDatesFor('created');
  const lastPromptDates = edgeDatesFor('last_message');
  const hasFirstPromptEdge = firstPromptDates.length > 0;
  const hasLastPromptEdge = lastPromptDates.length > 0;
  const hasMultipleEdgeCandidates = firstPromptDates.length > 1 || lastPromptDates.length > 1;
  const turnCount = candidate.turnCount || 0;
  const hasNoUserActivity = candidateHasNoUserActivity(candidate);
  const code: RawExportDiagnosticCode =
    corpusEvidence.sourceMismatchLikely && !hasNoUserActivity
      ? 'takeout_source_mismatch_for_raw_chat'
      : !localHits.length && hasNoUserActivity
        ? 'takeout_no_user_activity_for_assistant_only_chat'
        : !localHits.length
          ? 'takeout_no_evidence_for_raw_chat'
          : competingChatIds.length
            ? 'takeout_ambiguous_duplicate_content'
            : hasMultipleEdgeCandidates
              ? 'takeout_multiple_edge_candidates_for_raw_chat'
              : turnCount !== 1 && hasFirstPromptEdge && !hasLastPromptEdge
                ? 'takeout_last_edge_missing_for_raw_chat'
                : turnCount !== 1 && !hasFirstPromptEdge && hasLastPromptEdge
                  ? 'takeout_first_edge_missing_for_raw_chat'
                  : 'takeout_weak_or_partial_evidence';
  const action =
    code === 'takeout_source_mismatch_for_raw_chat'
      ? 'use_matching_takeout_or_browser_profile'
      : code === 'takeout_no_user_activity_for_assistant_only_chat'
        ? 'inspect_takeout_source'
        : code === 'takeout_ambiguous_duplicate_content' ||
            code === 'takeout_multiple_edge_candidates_for_raw_chat'
          ? 'dedupe_or_reexport'
          : 'reexport_chat';
  const message =
    code === 'takeout_source_mismatch_for_raw_chat'
      ? 'A maior parte dos chats exportados nao aparece no Takeout informado. Use o Takeout da mesma conta/perfil do navegador que gerou estes arquivos ou exporte os chats do perfil correto.'
      : code === 'takeout_no_user_activity_for_assistant_only_chat'
        ? 'A conversa nao tem prompt/mensagem do usuario no Markdown; o Takeout de Gemini Apps nao traz atividade suficiente para reconciliar esse chat. Use uma fonte web alternativa para datas ou remova do conjunto reconciliavel por Takeout.'
        : code === 'takeout_ambiguous_duplicate_content'
          ? 'O texto do raw chat bate em um item do Takeout que tambem bate em outro(s) chat(s); dedupe ou reexport por chat_id.'
          : code === 'takeout_multiple_edge_candidates_for_raw_chat'
            ? 'Mais de uma borda do raw chat aparece no Takeout; pode ser conversa duplicada, repetida ou nota com chats encadeados.'
            : code === 'takeout_last_edge_missing_for_raw_chat'
              ? 'O começo do raw chat aparece no Takeout, mas o fim nao aparece; o export pode estar truncado no final.'
              : code === 'takeout_first_edge_missing_for_raw_chat'
                ? 'O fim do raw chat aparece no Takeout, mas o começo nao aparece; o export pode estar truncado no inicio.'
                : hasOnlyImagePrompt
                  ? 'O raw chat depende de anexo/imagem e nao tem texto suficiente para reconciliar com seguranca; reexport por chat_id.'
                  : 'O raw chat nao tem evidência textual suficiente no Takeout; reexport por chat_id ou revise se o arquivo veio de outro export.';
  const truncation =
    code === 'takeout_last_edge_missing_for_raw_chat'
      ? {
          direction: 'tail' as const,
          message: 'fim do chat nao confirmado no Takeout',
        }
      : code === 'takeout_first_edge_missing_for_raw_chat'
        ? {
            direction: 'head' as const,
            message: 'começo do chat nao confirmado no Takeout',
          }
        : null;

  return {
    chatId,
    status:
      code === 'takeout_source_mismatch_for_raw_chat'
        ? 'takeout_source_mismatch'
        : code === 'takeout_no_user_activity_for_assistant_only_chat'
          ? 'takeout_source_gap'
          : 'raw_export_suspected',
    code,
    confidence:
      code === 'takeout_weak_or_partial_evidence' || code === 'takeout_no_evidence_for_raw_chat'
        ? 'weak'
        : 'strong',
    sourceFile,
    evidence: {
      takeoutItemsIndexed: indexedItems,
      candidateHits: localHits.length,
      strongestDate: best?.date || null,
      strongestTextHash: best?.textHash || null,
      strongestPromptHash: best?.promptHash || null,
      competingChatIds,
      attachmentCount: candidate.attachmentCount || 0,
      turnCount,
      edgeIntegrity: {
        hasFirstPromptEdge,
        hasLastPromptEdge,
        firstPromptDates,
        lastPromptDates,
      },
      truncation,
      corpus: corpusEvidence,
    },
    repair: {
      action,
      message,
    },
  };
};

export const diagnoseRawExportAgainstTakeout = ({
  takeoutPath,
  pendingCandidates,
  allCandidates,
}: {
  takeoutPath: string;
  pendingCandidates: TakeoutDiagnosticCandidate[];
  allCandidates: TakeoutDiagnosticCandidate[];
}): Map<string, RawExportDiagnostic> => {
  const { sourceFile, indexedItems, hits } = indexTakeoutHits(takeoutPath, allCandidates);
  const candidateCount = allCandidates.length;
  const chatIdsWithEvidence = new Set<string>();
  for (const hit of hits) {
    for (const chatId of hit.byChatId.keys()) chatIdsWithEvidence.add(chatId.toLowerCase());
  }
  const noEvidencePendingCount = pendingCandidates.filter(
    (candidate) =>
      !candidateHasNoUserActivity(candidate) &&
      !chatIdsWithEvidence.has(candidate.chatId.toLowerCase()),
  ).length;
  const evidenceCoverage = candidateCount ? chatIdsWithEvidence.size / candidateCount : 0;
  const sourceMismatchLikely =
    indexedItems > 0 &&
    candidateCount >= 10 &&
    evidenceCoverage <= 0.2 &&
    noEvidencePendingCount >= Math.max(5, Math.ceil(candidateCount * 0.5));
  const corpusEvidence = {
    candidateCount,
    candidateHitCount: chatIdsWithEvidence.size,
    evidenceCoverage,
    noEvidencePendingCount,
    sourceMismatchLikely,
  };
  const diagnostics = new Map<string, RawExportDiagnostic>();
  for (const candidate of pendingCandidates) {
    diagnostics.set(
      candidate.chatId.toLowerCase(),
      diagnosticFor({ candidate, sourceFile, indexedItems, hits, corpusEvidence }),
    );
  }
  return diagnostics;
};
