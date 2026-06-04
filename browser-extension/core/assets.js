import { hashText } from './text-hash.js';
const sourceForSnapshot = (snapshot) => snapshot.evidence[0]?.source || 'chat-dom';
const stableAssetRefId = ({ chatId, turnSourceOrder, attachmentIndex, attachment, }) => {
    if (attachment.assetRefId)
        return attachment.assetRefId;
    const fingerprint = hashText(JSON.stringify({
        chatId,
        turnSourceOrder,
        attachmentIndex,
        kind: attachment.kind,
        label: attachment.label,
        url: attachment.url || null,
        hash: attachment.hash || null,
    }));
    return `asset:${chatId}:${turnSourceOrder}:${attachmentIndex}:${fingerprint.replace(':', '-')}`;
};
export const assetRefsFromChatSnapshot = (snapshot) => {
    const source = sourceForSnapshot(snapshot);
    const refs = [];
    for (const turn of snapshot.turns) {
        turn.attachments.forEach((attachment, attachmentIndex) => {
            refs.push({
                id: stableAssetRefId({
                    chatId: snapshot.chatId,
                    turnSourceOrder: turn.sourceOrder,
                    attachmentIndex,
                    attachment,
                }),
                chatId: snapshot.chatId,
                turnSourceOrder: turn.sourceOrder,
                attachmentIndex,
                kind: attachment.kind,
                label: attachment.label,
                url: attachment.url || null,
                source,
                contentHash: attachment.hash || null,
                metadata: {},
            });
        });
    }
    return refs;
};
const dedupeKeyForAsset = (ref) => {
    if (ref.contentHash)
        return `hash:${ref.contentHash}`;
    if (ref.url)
        return `url:${ref.url}`;
    return null;
};
export const buildAssetFetchPlan = (refs) => {
    const firstRefByDedupeKey = new Map();
    const requests = [];
    const dedupedRefs = [];
    const warnings = [];
    for (const ref of refs) {
        const dedupeKey = dedupeKeyForAsset(ref);
        if (!dedupeKey) {
            warnings.push(`asset_metadata_only:${ref.id}`);
            continue;
        }
        const firstRef = firstRefByDedupeKey.get(dedupeKey);
        if (firstRef) {
            dedupedRefs.push({
                refId: ref.id,
                duplicateOfRefId: firstRef.id,
                dedupeKey,
            });
            warnings.push(`asset_deduped:${ref.id}->${firstRef.id}`);
            continue;
        }
        firstRefByDedupeKey.set(dedupeKey, ref);
        if (!ref.url) {
            warnings.push(`asset_hash_only:${ref.id}`);
            continue;
        }
        requests.push({
            requestId: `asset-fetch:${hashText(`${ref.id}:${ref.url}`)}`,
            refId: ref.id,
            url: ref.url,
            dedupeKey,
            kind: ref.kind,
            label: ref.label,
        });
    }
    return {
        refs,
        requests,
        dedupedRefs,
        warnings,
    };
};
export const receiptsForAssetFetchPlan = (plan) => {
    const requestRefIds = new Set(plan.requests.map((request) => request.refId));
    const receipts = [];
    for (const ref of plan.refs) {
        if (requestRefIds.has(ref.id))
            continue;
        const deduped = plan.dedupedRefs.find((item) => item.refId === ref.id);
        if (deduped) {
            receipts.push({
                ok: true,
                refId: ref.id,
                status: 'deduped',
                duplicateOfRefId: deduped.duplicateOfRefId,
            });
            continue;
        }
        receipts.push({
            ok: true,
            refId: ref.id,
            status: 'metadata_only',
            warning: 'asset_has_no_fetchable_url',
        });
    }
    return receipts;
};
