import { hashText } from './text-hash.js';
import type { ChatAttachment, ChatId, ChatSnapshot, EvidenceSource } from './types.js';

export type AssetKind = ChatAttachment['kind'];

export type AssetRef = Readonly<{
  id: string;
  chatId: ChatId | string;
  turnSourceOrder: number;
  attachmentIndex: number;
  kind: AssetKind;
  label: string;
  url?: string | null;
  source: EvidenceSource;
  contentHash?: string | null;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type AssetFetchRequest = Readonly<{
  requestId: string;
  refId: string;
  url: string;
  dedupeKey: string;
  kind: AssetKind;
  label: string;
}>;

export type AssetFetchPlan = Readonly<{
  refs: readonly AssetRef[];
  requests: readonly AssetFetchRequest[];
  dedupedRefs: readonly { refId: string; duplicateOfRefId: string; dedupeKey: string }[];
  warnings: readonly string[];
}>;

export type AssetReceipt = Readonly<{
  ok: boolean;
  refId: string;
  status: 'downloaded' | 'deduped' | 'metadata_only' | 'failed';
  filePath?: string | null;
  contentHash?: string | null;
  duplicateOfRefId?: string | null;
  warning?: string | null;
}>;

const sourceForSnapshot = (snapshot: ChatSnapshot): EvidenceSource =>
  snapshot.evidence[0]?.source || 'chat-dom';

const stableAssetRefId = ({
  chatId,
  turnSourceOrder,
  attachmentIndex,
  attachment,
}: Readonly<{
  chatId: ChatId | string;
  turnSourceOrder: number;
  attachmentIndex: number;
  attachment: ChatAttachment;
}>): string => {
  if (attachment.assetRefId) return attachment.assetRefId;
  const fingerprint = hashText(
    JSON.stringify({
      chatId,
      turnSourceOrder,
      attachmentIndex,
      kind: attachment.kind,
      label: attachment.label,
      url: attachment.url || null,
      hash: attachment.hash || null,
    }),
  );
  return `asset:${chatId}:${turnSourceOrder}:${attachmentIndex}:${fingerprint.replace(':', '-')}`;
};

export const assetRefsFromChatSnapshot = (snapshot: ChatSnapshot): AssetRef[] => {
  const source = sourceForSnapshot(snapshot);
  const refs: AssetRef[] = [];
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

const dedupeKeyForAsset = (ref: AssetRef): string | null => {
  if (ref.contentHash) return `hash:${ref.contentHash}`;
  if (ref.url) return `url:${ref.url}`;
  return null;
};

export const buildAssetFetchPlan = (refs: readonly AssetRef[]): AssetFetchPlan => {
  const firstRefByDedupeKey = new Map<string, AssetRef>();
  const requests: AssetFetchRequest[] = [];
  const dedupedRefs: AssetFetchPlan['dedupedRefs'][number][] = [];
  const warnings: string[] = [];

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

export const receiptsForAssetFetchPlan = (plan: AssetFetchPlan): AssetReceipt[] => {
  const requestRefIds = new Set(plan.requests.map((request) => request.refId));
  const receipts: AssetReceipt[] = [];
  for (const ref of plan.refs) {
    if (requestRefIds.has(ref.id)) continue;
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
