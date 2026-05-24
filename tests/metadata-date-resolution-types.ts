import type {
  CompleteMultiTurnMetadataDates,
  CreatedDateEvidence,
  LastMessageDateEvidence,
  SingleTurnMetadataDateCandidate,
  UnknownDateEvidence,
} from '../src/core/metadata-date-resolution.js';

declare const createdEvidence: CreatedDateEvidence;
declare const lastMessageEvidence: LastMessageDateEvidence;
declare const unknownEvidence: UnknownDateEvidence;
declare const singleTurnCandidate: SingleTurnMetadataDateCandidate;

const validMultiTurnCompletion = {
  dateCreated: createdEvidence.date,
  dateLastMessage: lastMessageEvidence.date,
  usedEvidence: {
    created: createdEvidence,
    lastMessage: lastMessageEvidence,
  },
  unknownEvidencePolicy: 'not_used',
} satisfies CompleteMultiTurnMetadataDates;

void validMultiTurnCompletion;

const invalidMultiTurnCompletion = {
  dateCreated: unknownEvidence.date,
  dateLastMessage: unknownEvidence.date,
  usedEvidence: {
    // @ts-expect-error unknown evidence cannot prove the first edge of a multi-turn chat.
    created: unknownEvidence,
    // @ts-expect-error unknown evidence cannot prove the last edge of a multi-turn chat.
    lastMessage: unknownEvidence,
  },
  unknownEvidencePolicy: 'not_used',
} satisfies CompleteMultiTurnMetadataDates;

void invalidMultiTurnCompletion;

const invalidSingleTurnCandidate = {
  chatId: singleTurnCandidate.chatId,
  // @ts-expect-error single-turn metadata candidates must be proven by the single_turn shape.
  chatShape: 'multi_turn',
  turnCount: 1,
} satisfies SingleTurnMetadataDateCandidate;

void invalidSingleTurnCandidate;
