import { diagnoseRawExportAgainstTakeout, } from '../takeout/takeout-diagnostics.js';
import { portableIsoSeconds } from './date.js';
import { buildMetadataBackfillContract, metadataBackfillStatusForDates, summarizeMetadataBackfillItems, } from './metadata-backfill-contract.js';
import { resolveMetadataDatesForCandidate, } from './metadata-date-resolution.js';
import { hashText } from './text-hash.js';
const buildReportItem = (candidate, status, dates, dateResolution, evidence = [], diagnostic = null) => ({
    chatId: candidate.chatId,
    file: candidate.relativePath,
    status,
    dateCreated: dates.dateCreated,
    dateLastMessage: dates.dateLastMessage,
    dateExported: portableIsoSeconds(candidate.dateExported) || null,
    turnCount: candidate.turnCount,
    attachmentCount: candidate.attachmentCount || 0,
    candidateHash: hashText([
        candidate.scoring.firstPrompt,
        candidate.scoring.lastPrompt,
        candidate.scoring.firstAssistant,
        candidate.scoring.lastAssistant,
        ...(candidate.scoring.assistantSamples || []),
    ].join('\n')),
    dateResolution: {
        chatShape: dateResolution.chatShape,
        turnCount: dateResolution.turnCount,
        hasCreatedEdge: dateResolution.hasCreatedEdge,
        hasLastMessageEdge: dateResolution.hasLastMessageEdge,
        hasUnknownEvidence: dateResolution.hasUnknownEvidence,
        unknownEvidencePolicy: dateResolution.unknownEvidencePolicy,
        warnings: dateResolution.warnings,
    },
    evidence: evidence.map((item) => ({
        kind: item.kind || 'unknown',
        dateKind: item.dateKind || item.kind || 'unknown',
        date: item.date || null,
        score: item.score ?? null,
        source: item.source || null,
        textHash: item.textHash || null,
        sampleHash: item.sampleHash || null,
        sampleLength: item.sampleLength || null,
    })),
    ...(diagnostic ? { diagnostic } : {}),
});
const diagnosticSummary = (diagnostics) => ({
    enabled: true,
    diagnosed: diagnostics.size,
    byCode: Array.from(diagnostics.values()).reduce((acc, diagnostic) => {
        acc[diagnostic.code] = (acc[diagnostic.code] || 0) + 1;
        return acc;
    }, {}),
});
export const buildMetadataBackfillReportState = ({ candidates, groupedMatches, filesRewritten, takeoutPath = '', activityError = null, }) => {
    let rawExportDiagnostics = new Map();
    if (takeoutPath) {
        const pendingForDiagnostics = candidates.filter((candidate) => {
            const match = groupedMatches.get(candidate.chatId);
            return (resolveMetadataDatesForCandidate({
                candidate,
                evidence: match?.evidence || [],
                existingDates: {
                    dateCreated: candidate.dateCreated || null,
                    dateLastMessage: candidate.dateLastMessage || null,
                },
            }).status !== 'matched');
        });
        if (pendingForDiagnostics.length) {
            rawExportDiagnostics = diagnoseRawExportAgainstTakeout({
                takeoutPath,
                pendingCandidates: pendingForDiagnostics,
                allCandidates: candidates,
            });
        }
    }
    const items = candidates.map((candidate) => {
        const match = groupedMatches.get(candidate.chatId);
        const dateResolution = resolveMetadataDatesForCandidate({
            candidate,
            evidence: match?.evidence || [],
            existingDates: {
                dateCreated: candidate.dateCreated || null,
                dateLastMessage: candidate.dateLastMessage || null,
            },
        });
        const dates = {
            dateCreated: portableIsoSeconds(dateResolution.dateCreated) || null,
            dateLastMessage: portableIsoSeconds(dateResolution.dateLastMessage) || null,
        };
        const baseStatus = metadataBackfillStatusForDates(dates);
        const diagnostic = baseStatus !== 'matched' ? rawExportDiagnostics.get(candidate.chatId) || null : null;
        const status = diagnostic
            ? diagnostic.status === 'takeout_source_gap'
                ? 'source_gap'
                : diagnostic.status === 'takeout_source_mismatch'
                    ? 'source_mismatch'
                    : 'export_error'
            : baseStatus;
        return buildReportItem(candidate, status, dates, dateResolution, match?.evidence || [], diagnostic);
    });
    const summary = summarizeMetadataBackfillItems({
        totalChats: candidates.length,
        filesRewritten,
        items,
    });
    const contract = buildMetadataBackfillContract({ summary, items, activityError });
    return {
        items,
        summary,
        contract,
        rawExportDiagnostics: takeoutPath
            ? diagnosticSummary(rawExportDiagnostics)
            : { enabled: false },
    };
};
