import { portableIsoSeconds } from './date.js';
const sortDates = (items) => [...items].sort((a, b) => String(a.date).localeCompare(String(b.date)));
const evidenceScore = (item) => {
    const score = Number(item.score);
    return Number.isFinite(score) ? score : 0;
};
const duplicateTakeoutEdgeResolution = (items, strategy, warningCode, warnings) => {
    if (!items.length)
        return null;
    const allStrongTakeout = items.every((item) => evidenceScore(item) >= 1 &&
        item.confidence === 'strong' &&
        (item.source === 'takeout-html' || item.source === 'takeout-json'));
    if (!allStrongTakeout)
        return null;
    warnings.push(warningCode);
    const sorted = sortDates(items);
    return strategy === 'earliest' ? sorted[0] || null : sorted.at(-1) || null;
};
const bestUniqueEdgeEvidence = (items, warningCode, warnings, duplicateResolution) => {
    if (!items.length)
        return null;
    const sorted = [...items].sort((a, b) => evidenceScore(b) - evidenceScore(a) || String(a.date).localeCompare(String(b.date)));
    const topScore = evidenceScore(sorted[0]);
    const topItems = sorted.filter((item) => Math.abs(evidenceScore(item) - topScore) < 0.0001);
    const topDates = Array.from(new Set(topItems.map((item) => item.date)));
    if (topDates.length === 1) {
        return sortDates(topItems.filter((item) => item.date === topDates[0]))[0] || null;
    }
    const duplicateResolved = duplicateResolution
        ? duplicateTakeoutEdgeResolution(topItems, duplicateResolution.strategy, duplicateResolution.warningCode, warnings)
        : null;
    if (duplicateResolved)
        return duplicateResolved;
    warnings.push(warningCode);
    return null;
};
const statusForDates = (dateCreated, dateLastMessage) => {
    if (dateCreated && dateLastMessage)
        return 'matched';
    return dateCreated || dateLastMessage ? 'partial' : 'unresolved';
};
export const metadataDateCandidateFor = (candidate) => {
    const turnCount = Number.isFinite(candidate.turnCount) && Number(candidate.turnCount) >= 0
        ? Number(candidate.turnCount)
        : null;
    if (turnCount === 1) {
        return {
            chatId: candidate.chatId,
            chatShape: 'single_turn',
            turnCount: 1,
        };
    }
    if (turnCount === null) {
        return {
            chatId: candidate.chatId,
            chatShape: 'unknown_turn_count',
            turnCount: null,
        };
    }
    return {
        chatId: candidate.chatId,
        chatShape: 'multi_turn',
        turnCount,
    };
};
const normalizeEvidenceDateKind = (item) => {
    const kind = String(item?.dateKind || item?.kind || 'unknown');
    return kind === 'created' || kind === 'last_message' ? kind : 'unknown';
};
export const normalizeDateEvidence = (item) => {
    const date = portableIsoSeconds(item?.date);
    if (!item || !date)
        return null;
    const dateKind = normalizeEvidenceDateKind(item);
    const evidence = {
        ...item,
        chatId: item.chatId,
        source: (item.source || 'takeout-html'),
        kind: item.kind || dateKind,
        dateKind,
        confidence: item.confidence || 'strong',
        date,
        score: item.score,
        warnings: item.warnings || [],
    };
    return evidence;
};
const isResolvedDateEvidence = (item) => Boolean(item);
const frontmatterEvidence = ({ chatId, date, dateKind, }) => ({
    chatId: chatId.toLowerCase(),
    source: 'frontmatter',
    kind: dateKind,
    dateKind,
    confidence: 'strong',
    date,
    score: 1,
    warnings: [],
});
export const resolveMetadataDatesForCandidate = ({ candidate, evidence = [], existingDates = {}, }) => {
    const shapedCandidate = metadataDateCandidateFor(candidate);
    const normalizedEvidence = evidence.map(normalizeDateEvidence).filter(isResolvedDateEvidence);
    const createdEvidence = [];
    const lastMessageEvidence = [];
    const unknownEvidence = [];
    const existingCreated = portableIsoSeconds(existingDates.dateCreated);
    const existingLastMessage = portableIsoSeconds(existingDates.dateLastMessage);
    if (existingCreated) {
        createdEvidence.push(frontmatterEvidence({
            chatId: candidate.chatId,
            date: existingCreated,
            dateKind: 'created',
        }));
    }
    if (existingLastMessage) {
        lastMessageEvidence.push(frontmatterEvidence({
            chatId: candidate.chatId,
            date: existingLastMessage,
            dateKind: 'last_message',
        }));
    }
    for (const item of normalizedEvidence) {
        if (item.dateKind === 'created')
            createdEvidence.push(item);
        else if (item.dateKind === 'last_message')
            lastMessageEvidence.push(item);
        else
            unknownEvidence.push(item);
    }
    const warnings = [];
    const firstCreated = shapedCandidate.chatShape === 'single_turn'
        ? sortDates(createdEvidence)[0] || null
        : bestUniqueEdgeEvidence(createdEvidence, 'created_date_ambiguous_for_non_single_turn', warnings, {
            strategy: 'earliest',
            warningCode: 'created_date_duplicate_takeout_edges_resolved_by_earliest',
        });
    const lastMessage = shapedCandidate.chatShape === 'single_turn'
        ? sortDates(lastMessageEvidence).at(-1) || null
        : bestUniqueEdgeEvidence(lastMessageEvidence, 'last_message_date_ambiguous_for_non_single_turn', warnings, {
            strategy: 'latest',
            warningCode: 'last_message_date_duplicate_takeout_edges_resolved_by_latest',
        });
    let dateCreated = firstCreated?.date || null;
    let dateLastMessage = lastMessage?.date || null;
    let unknownEvidencePolicy = 'not_used';
    let singleTurnSharedEvidence = null;
    if (shapedCandidate.chatShape === 'single_turn' && (!dateCreated || !dateLastMessage)) {
        const explicitEdges = sortDates([...createdEvidence, ...lastMessageEvidence]);
        const explicitEdgeDates = Array.from(new Set(explicitEdges.map((item) => item.date)));
        const unknownDates = Array.from(new Set(sortDates(unknownEvidence).map((item) => item.date)));
        if (explicitEdgeDates.length === 1) {
            singleTurnSharedEvidence =
                explicitEdges.find((item) => item.date === explicitEdgeDates[0]) || null;
            if (!dateCreated)
                dateCreated = explicitEdgeDates[0];
            if (!dateLastMessage)
                dateLastMessage = explicitEdgeDates[0];
        }
        else if (unknownDates.length === 1 && explicitEdgeDates.length === 0) {
            singleTurnSharedEvidence =
                unknownEvidence.find((item) => item.date === unknownDates[0]) || null;
            if (!dateCreated)
                dateCreated = unknownDates[0];
            if (!dateLastMessage)
                dateLastMessage = unknownDates[0];
            unknownEvidencePolicy = 'used_for_single_turn';
        }
        else if (unknownDates.length > 1 || explicitEdgeDates.length > 1) {
            unknownEvidencePolicy = 'ambiguous_for_single_turn';
            warnings.push('unknown_date_ambiguous_for_single_turn');
        }
    }
    else if (unknownEvidence.length) {
        unknownEvidencePolicy = 'ignored_for_multi_turn';
        warnings.push('unknown_date_ignored_for_non_single_turn');
    }
    if (dateCreated && dateLastMessage && dateCreated > dateLastMessage) {
        warnings.push('date_created_after_date_last_message');
        dateCreated = null;
        dateLastMessage = null;
    }
    const status = statusForDates(dateCreated, dateLastMessage);
    let complete = null;
    if (dateCreated && dateLastMessage && shapedCandidate.chatShape === 'single_turn') {
        const createdUsed = firstCreated || singleTurnSharedEvidence;
        const lastMessageUsed = lastMessage || singleTurnSharedEvidence;
        if (createdUsed && lastMessageUsed) {
            complete = {
                dateCreated,
                dateLastMessage,
                usedEvidence: {
                    created: createdUsed,
                    lastMessage: lastMessageUsed,
                },
                unknownEvidencePolicy: unknownEvidencePolicy === 'used_for_single_turn' ? 'used_for_single_turn' : 'not_used',
            };
        }
    }
    else if (dateCreated && dateLastMessage && firstCreated && lastMessage) {
        complete = {
            dateCreated,
            dateLastMessage,
            usedEvidence: {
                created: firstCreated,
                lastMessage,
            },
            unknownEvidencePolicy: 'not_used',
        };
    }
    return {
        status,
        dateCreated,
        dateLastMessage,
        chatShape: shapedCandidate.chatShape,
        turnCount: shapedCandidate.turnCount,
        hasCreatedEdge: createdEvidence.length > 0,
        hasLastMessageEdge: lastMessageEvidence.length > 0,
        hasUnknownEvidence: unknownEvidence.length > 0,
        unknownEvidencePolicy,
        warnings,
        complete,
    };
};
export const metadataCandidateHasCompleteResolvedDates = (candidate, match) => {
    const matchHasEvidence = Boolean((match?.evidence || []).length);
    return (resolveMetadataDatesForCandidate({
        candidate,
        evidence: match?.evidence || [],
        existingDates: {
            dateCreated: candidate.dateCreated || (!matchHasEvidence ? match?.dateCreated : null),
            dateLastMessage: candidate.dateLastMessage || (!matchHasEvidence ? match?.dateLastMessage : null),
        },
    }).status === 'matched');
};
export const filterCandidatesMissingResolvedMetadataDates = (candidates, groupedMatches) => candidates.filter((candidate) => !metadataCandidateHasCompleteResolvedDates(candidate, groupedMatches.get(candidate.chatId)));
