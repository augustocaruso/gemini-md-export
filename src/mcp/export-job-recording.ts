type AnyRecord = Record<string, any>;

export type ExportJobRecordingDeps = {
  appendExportJobTrace(job: AnyRecord, event: string, payload?: AnyRecord): void;
  assetTimeoutCountFromConversationMetrics(metrics?: AnyRecord): number;
  browserTimeoutCountFromConversationMetrics(metrics?: AnyRecord): number;
  buildExportDateImportBatchEvidenceForPayloads(
    entries: Array<{ key: string; payload: AnyRecord; integrity: AnyRecord }>,
    args: AnyRecord,
  ): Promise<{ candidates: number; groupedByKey: Map<string, unknown> }>;
  createExportDateImportContextForArgs(args: AnyRecord): Promise<unknown>;
  finishConversationMetric(
    job: AnyRecord,
    itemMetric: AnyRecord,
    status: string,
    patch?: AnyRecord,
  ): void;
  getClientById(clientId: string): AnyRecord | null;
  hasDateImportSource(args?: AnyRecord): boolean;
  measureJobTiming<T>(job: AnyRecord, name: string, fn: () => Promise<T>): Promise<T>;
  rebindExportJobToClient(job: AnyRecord, client: AnyRecord, reason?: string): AnyRecord | null;
  recordJobCounter(job: AnyRecord, name: string, delta?: number): void;
  saveCollectedConversationPayload(collected: AnyRecord, args?: AnyRecord): Promise<AnyRecord>;
  summarizeExportDateImportContextForJob(context: unknown): Promise<AnyRecord>;
  touchExportJob(job: AnyRecord): void;
};

export type DeferredDateImportSave = {
  index: number;
  conversation: AnyRecord;
  itemMetric: AnyRecord;
  collected: AnyRecord;
};

export const buildConversationExportSuccess = ({
  index,
  conversation,
  result,
}: {
  index: number;
  conversation: AnyRecord;
  result: AnyRecord;
}): AnyRecord => ({
  index,
  chatId: result.chatId,
  title: result.title,
  filename: result.filename,
  filePath: result.filePath,
  bytes: result.bytes,
  mediaFileCount: result.mediaFileCount || 0,
  mediaFailureCount: result.mediaFailureCount || 0,
  turns: result.turns,
  overwritten: result.overwritten,
  ...(conversation?.request?.sourcePath ? { sourcePath: conversation.request.sourcePath } : {}),
  integrity: result.integrity || null,
  dateImport: result.dateImport || null,
  metrics: result.metrics || null,
});

export const recordConversationExportSuccess = (
  { job, successes, itemMetric, success, result }: AnyRecord,
  deps: ExportJobRecordingDeps,
): void => {
  successes.push(success);
  job.recentSuccesses.push(success);
  job.recentSuccesses = job.recentSuccesses.slice(-10);
  job.successCount = successes.length;
  deps.recordJobCounter(job, 'mediaFiles', result.mediaFileCount || 0);
  deps.recordJobCounter(job, 'mediaWarnings', result.mediaFailureCount || 0);
  if (result.dateImport?.enabled) {
    if (result.dateImport.status === 'matched') {
      deps.recordJobCounter(job, 'dateImportMatched');
    } else if (result.dateImport.status === 'partial') {
      deps.recordJobCounter(job, 'dateImportPartial');
    } else if (result.dateImport.status === 'unresolved') {
      deps.recordJobCounter(job, 'dateImportUnresolved');
    }
  }
  deps.recordJobCounter(
    job,
    'savedBytes',
    (result.bytes || 0) + (result.metrics?.counters?.savedMediaBytes || 0),
  );
  deps.recordJobCounter(
    job,
    'browserTimeouts',
    deps.browserTimeoutCountFromConversationMetrics(result.metrics),
  );
  deps.recordJobCounter(
    job,
    'assetTimeouts',
    deps.assetTimeoutCountFromConversationMetrics(result.metrics),
  );
  deps.finishConversationMetric(job, itemMetric, 'success', {
    chatId: result.chatId,
    filename: result.filename,
    filePath: result.filePath,
    bytes: result.bytes,
    ...(success.sourcePath ? { sourcePath: success.sourcePath } : {}),
    timings: result.metrics?.timings || {},
    counters: result.metrics?.counters || {},
    hydration: result.metrics?.hydration || null,
    navigation: result.metrics?.navigation || null,
    media: result.metrics?.media || null,
    dateImport: result.dateImport || null,
  });
};

export const buildConversationExportFailure = ({
  index,
  conversation,
  err,
}: {
  index: number;
  conversation: AnyRecord;
  err: AnyRecord;
}): AnyRecord => ({
  index,
  chatId: conversation.chatId || conversation.id || null,
  title: conversation.title || null,
  ...(conversation?.request?.sourcePath ? { sourcePath: conversation.request.sourcePath } : {}),
  error: err.message,
  code: err.code || null,
  dateImport: err.data?.dateImport || null,
  evidence: Array.isArray(err.data?.evidence) ? err.data.evidence : [],
});

export const recordConversationExportFailure = (
  { job, failures, itemMetric, failure, err }: AnyRecord,
  deps: ExportJobRecordingDeps,
): void => {
  failures.push(failure);
  job.failures.push(failure);
  job.failures = job.failures.slice(-20);
  job.failureCount = failures.length;
  deps.appendExportJobTrace(job, 'conversation_failed', {
    index: failure.index,
    chatId: failure.chatId,
    error: err.message,
    code: err.code || null,
    layer: err.layer || null,
    operation: err.operation || null,
    timeout: err.data?.timeout || null,
    dateImport: err.data?.dateImport || null,
  });
  deps.recordJobCounter(job, 'failedConversations');
  if (/timeout|tempo esgotado/i.test(err.message)) {
    deps.recordJobCounter(job, 'browserTimeouts');
  }
  deps.finishConversationMetric(job, itemMetric, 'failed', {
    ...(failure.sourcePath ? { sourcePath: failure.sourcePath } : {}),
    error: err.message,
    dateImport: err.data?.dateImport || null,
  });
};

const prepareDeferredDateImportSaves = async (
  { job, client, successes, failures, deferredSaves, args, persist, broadcast }: AnyRecord,
  deps: ExportJobRecordingDeps,
): Promise<boolean> => {
  if (!deps.hasDateImportSource(args) || deferredSaves.length === 0 || job.cancelRequested)
    return false;
  job.phase = 'resolving-metadata';
  job.current = null;
  deps.touchExportJob(job);
  persist(job, client, successes, failures);
  broadcast(job, client);
  const batchEvidence = await deps.measureJobTiming(job, 'resolveDateImportBatchMs', async () =>
    deps.buildExportDateImportBatchEvidenceForPayloads(
      deferredSaves.map(({ collected }: DeferredDateImportSave) => ({
        key: String(collected.integrity.snapshot.chatId).toLowerCase(),
        payload: collected.result.payload,
        integrity: collected.integrity,
      })),
      args,
    ),
  );
  args._exportDateImportGroupedEvidence = batchEvidence.groupedByKey;
  job.dateImport = {
    ...(job.dateImport || {}),
    batchCandidates: batchEvidence.candidates,
    ...(args._exportDateImportActivitySummary
      ? { myActivity: args._exportDateImportActivitySummary }
      : {}),
  };
  return true;
};

export const saveDeferredDateImportExports = async (
  input: AnyRecord,
  deps: ExportJobRecordingDeps,
): Promise<AnyRecord | null> => {
  let { client } = input;
  const shouldSave = await prepareDeferredDateImportSaves(input, deps);
  if (!shouldSave) return client;
  try {
    for (const {
      index,
      conversation,
      itemMetric,
      collected,
    } of input.deferredSaves as DeferredDateImportSave[]) {
      input.job.current = {
        index,
        title: conversation.title || null,
        chatId: conversation.chatId || conversation.id || null,
        sourcePath: conversation.request?.sourcePath || null,
      };
      deps.touchExportJob(input.job);
      input.broadcast(input.job, client);
      try {
        const result = await deps.saveCollectedConversationPayload(collected, {
          ...input.args,
          outputDir: input.job.outputDir,
        });
        const resultClient = result.client?.clientId
          ? deps.getClientById(result.client.clientId)
          : null;
        if (resultClient)
          client = deps.rebindExportJobToClient(input.job, resultClient, 'conversation-save');
        const success = buildConversationExportSuccess({ index, conversation, result });
        recordConversationExportSuccess(
          { job: input.job, successes: input.successes, itemMetric, success, result },
          deps,
        );
      } catch (err: any) {
        const failure = buildConversationExportFailure({ index, conversation, err });
        recordConversationExportFailure(
          { job: input.job, failures: input.failures, itemMetric, failure, err },
          deps,
        );
      } finally {
        deps.touchExportJob(input.job);
        input.persist(input.job, client, input.successes, input.failures);
        input.broadcast(input.job, client);
      }
    }
    return client;
  } finally {
    delete input.args._exportDateImportGroupedEvidence;
    delete input.args._exportDateImportActivitySummary;
  }
};

export const loadDateImportForExportJob = async (
  { job, client, args, successes, failures, persist, broadcast }: AnyRecord,
  deps: ExportJobRecordingDeps,
): Promise<void> => {
  if (!deps.hasDateImportSource(args)) return;
  job.phase = 'loading-metadata';
  deps.touchExportJob(job);
  persist(job, client, successes, failures);
  broadcast(job, client);
  const context = await deps.measureJobTiming(job, 'loadDateImportSourceMs', async () =>
    deps.createExportDateImportContextForArgs(args),
  );
  job.dateImport = await deps.summarizeExportDateImportContextForJob(context);
  deps.appendExportJobTrace(job, 'date_import_source_loaded', {
    dateImport: job.dateImport,
  });
};
