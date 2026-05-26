import type { IsoDateTime } from '../src/core/types.js';
import type {
  ExportDateImportContext,
  ExportDateImportMatchedReceipt,
  ExportDateImportReceipt,
} from '../src/mcp/export-metadata.js';

declare const context: ExportDateImportContext;

if (context.enabled && context.source === 'takeout') {
  context.takeout.itemsIndexed satisfies number;
} else {
  // @ts-expect-error disabled/My Activity metadata contexts must not expose a Takeout index.
  context.takeout;
}

const matchedReceipt = {
  enabled: true,
  status: 'matched',
  source: 'takeout',
  sourceFile: 'Minhaatividade.html',
  dateCreated: '2026-05-10T06:46:09Z' as IsoDateTime,
  dateLastMessage: '2026-05-10T07:12:31Z' as IsoDateTime,
  evidenceCount: 2,
  warnings: [],
  dateResolution: {
    chatShape: 'multi_turn',
    turnCount: 2,
    hasCreatedEdge: true,
    hasLastMessageEdge: true,
    hasUnknownEvidence: false,
    unknownEvidencePolicy: 'not_used',
    warnings: [],
  },
} satisfies ExportDateImportReceipt;

void matchedReceipt;

const myActivityMatchedReceipt = {
  ...matchedReceipt,
  source: 'my-activity',
  sourceFile: null,
} satisfies ExportDateImportReceipt;

void myActivityMatchedReceipt;

const invalidMatchedReceipt = {
  enabled: true,
  status: 'matched',
  source: 'takeout',
  sourceFile: 'Minhaatividade.html',
  // @ts-expect-error matched receipts must carry date_created.
  dateCreated: null,
  dateLastMessage: '2026-05-10T07:12:31Z' as IsoDateTime,
  evidenceCount: 2,
  warnings: [],
  dateResolution: {
    chatShape: 'multi_turn',
    turnCount: 2,
    hasCreatedEdge: true,
    hasLastMessageEdge: true,
    hasUnknownEvidence: false,
    unknownEvidencePolicy: 'not_used',
    warnings: [],
  },
} satisfies ExportDateImportMatchedReceipt;

void invalidMatchedReceipt;
