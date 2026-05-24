export type ChatId = string & { readonly __brand: 'ChatId' };
export type IsoDateTime = string & { readonly __brand: 'IsoDateTime' };

export type ChatRole = 'user' | 'assistant';

export type ChatAttachment = {
  kind: 'image' | 'document' | 'artifact' | 'unknown';
  label: string;
  url?: string;
  hash?: string;
};

export type ChatTurn = {
  role: ChatRole;
  markdown: string;
  textHash: string;
  sourceOrder: number;
  attachments: ChatAttachment[];
};

export type ChatMetadata = {
  model?: string;
  dateCreated?: IsoDateTime;
  dateLastMessage?: IsoDateTime;
  dateExported?: IsoDateTime;
  assistantTurnCount: number;
};

export type EvidenceSource =
  | 'chat-dom'
  | 'my-activity-web'
  | 'takeout-html'
  | 'takeout-json'
  | 'frontmatter'
  | 'filename'
  | 'receipt';

export type SanitizedEvidence = {
  source: EvidenceSource;
  kind: string;
  confidence: 'strong' | 'weak' | 'missing';
  score?: number;
  date?: IsoDateTime;
  textHash?: string;
  sampleHash?: string;
  sampleLength?: number;
  warnings: string[];
};

export type MetadataEvidence = SanitizedEvidence & {
  chatId?: ChatId;
  dateKind: 'created' | 'last_message' | 'unknown';
};

export type ChatSnapshot = {
  chatId: ChatId;
  title: string;
  url: string;
  turns: ChatTurn[];
  metadata: ChatMetadata;
  evidence: SanitizedEvidence[];
};

export type MarkdownChatNote = {
  filePath: string;
  relativePath: string;
  chatId: ChatId;
  title: string;
  url: string;
  body: string;
  metadata: ChatMetadata;
  scoring: {
    title?: string;
    firstPrompt: string;
    lastPrompt: string;
    firstAssistant?: string;
    lastAssistant?: string;
    assistantSamples: string[];
  };
};

export type BlockedResult = {
  ok: false;
  code:
    | 'identity_unproven'
    | 'chat_id_mismatch'
    | 'empty_chat'
    | 'mixed_chat_suspected'
    | 'adapter_contract_missing'
    | 'write_failed'
    | 'metadata_unresolved';
  message: string;
  requestedChatId?: string;
  observedChatId?: string;
  evidence: SanitizedEvidence[];
};

export type ExportReceipt = {
  ok: true;
  chatId: ChatId;
  filePath: string;
  markdownHash: string;
  assistantTurnCount: number;
  evidence: SanitizedEvidence[];
};
