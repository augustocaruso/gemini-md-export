const nonNegativeNumber = (value) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0)
        return 0;
    return Math.floor(parsed);
};
const scanDateImportStatuses = (items) => {
    const counts = {
        matched: 0,
        partial: 0,
        unresolved: 0,
    };
    for (const item of items) {
        const status = item?.dateImport?.status;
        if (status === 'matched')
            counts.matched += 1;
        if (status === 'partial')
            counts.partial += 1;
        if (status === 'unresolved')
            counts.unresolved += 1;
    }
    return counts;
};
const richestDateImportItems = (job) => {
    const successes = Array.isArray(job.successes) ? job.successes : [];
    const conversations = Array.isArray(job.metrics?.conversations) ? job.metrics.conversations : [];
    const recentSuccesses = Array.isArray(job.recentSuccesses) ? job.recentSuccesses : [];
    return [successes, conversations, recentSuccesses].sort((a, b) => b.length - a.length)[0] || [];
};
export const dateImportIssueCountsForJob = (job = {}) => {
    const counters = job.metrics?.counters || {};
    let matched = nonNegativeNumber(counters.dateImportMatched);
    let partial = nonNegativeNumber(counters.dateImportPartial);
    let unresolved = nonNegativeNumber(counters.dateImportUnresolved);
    const scanned = scanDateImportStatuses(richestDateImportItems(job));
    matched = Math.max(matched, scanned.matched);
    partial = Math.max(partial, scanned.partial);
    unresolved = Math.max(unresolved, scanned.unresolved);
    return {
        matched,
        partial,
        unresolved,
        pending: partial + unresolved,
    };
};
export const evaluateDateImportMessageFsm = (job = {}) => {
    const source = String(job.dateImport?.source || '').toLowerCase();
    const primarySource = String(job.dateImport?.primarySource || '').toLowerCase();
    const hasSourceFile = Boolean(job.dateImport?.sourceFile);
    const enabled = job.dateImport?.enabled === true;
    if (!enabled || source === 'none') {
        return {
            state: 'disabled',
            sourceLabel: 'importação de datas',
            loadingMessage: 'Preparando metadados antes de salvar...',
        };
    }
    if (source === 'my-activity' || primarySource === 'my-activity') {
        return {
            state: 'my_activity_only',
            sourceLabel: 'My Activity',
            loadingMessage: 'Preparando My Activity para preencher datas antes de salvar...',
        };
    }
    if (source === 'takeout+my-activity' ||
        (hasSourceFile && job.dateImport?.fallback === 'my-activity')) {
        return {
            state: 'takeout_with_activity_fallback',
            sourceLabel: 'Takeout/My Activity',
            loadingMessage: 'Indexando Takeout; My Activity cobre datas restantes antes de salvar...',
        };
    }
    if (source === 'takeout' || hasSourceFile) {
        return {
            state: 'takeout_only',
            sourceLabel: 'Takeout',
            loadingMessage: 'Indexando Takeout para preencher datas antes de salvar...',
        };
    }
    return {
        state: 'unknown_enabled',
        sourceLabel: 'Takeout/My Activity',
        loadingMessage: 'Preparando importação de datas antes de salvar...',
    };
};
const shellQuote = (value) => {
    const text = String(value || '');
    if (!text)
        return "''";
    return `'${text.replace(/'/g, "'\\''")}'`;
};
const fixVaultCommandText = (job = {}) => {
    const vaultDir = job.existingScanDir || job.vaultDir || job.outputDir || '.';
    const parts = ['gemini-md-export', 'fix-vault', shellQuote(vaultDir), '--use-my-activity'];
    if (job.reportFile)
        parts.push('--report', shellQuote(job.reportFile));
    return parts.join(' ');
};
export const evaluateDateCompletenessGateFsm = (job = {}) => {
    const counts = dateImportIssueCountsForJob(job);
    const base = {
        matched: counts.matched,
        partial: counts.partial,
        unresolved: counts.unresolved,
        pending: counts.pending,
    };
    if (job.dateImport?.enabled !== true) {
        return {
            state: 'disabled',
            ok: true,
            status: 'completed',
            ...base,
            nextAction: null,
        };
    }
    if (job.dateImport?.requireCompleteDates !== true) {
        return {
            state: 'not_required',
            ok: true,
            status: 'completed',
            ...base,
            nextAction: null,
        };
    }
    if (counts.pending <= 0) {
        return {
            state: 'complete',
            ok: true,
            status: 'completed',
            ...base,
            nextAction: null,
        };
    }
    const sourceLabel = evaluateDateImportMessageFsm(job).sourceLabel;
    const pendingText = `${counts.pending} conversa${counts.pending === 1 ? '' : 's'} ` +
        `${counts.pending === 1 ? 'ficou' : 'ficaram'} com datas pendentes`;
    return {
        state: 'date_errors',
        ok: false,
        status: 'completed_with_errors',
        ...base,
        nextAction: {
            code: 'fix_vault_required',
            message: `Não consegui preencher todas as datas no ${sourceLabel}: ${pendingText}. ` +
                'Rode fix-vault para completar o vault antes de considerar o export concluído.',
            command: {
                tool: 'shell',
                text: fixVaultCommandText(job),
            },
        },
    };
};
export const terminalExportStatusForDateCompleteness = (job = {}, failureCount = 0, historyIncomplete = false) => Number(failureCount || 0) > 0 ||
    historyIncomplete === true ||
    evaluateDateCompletenessGateFsm(job).state === 'date_errors'
    ? 'completed_with_errors'
    : 'completed';
export const dateCompletenessNextActionForJob = (job = {}) => {
    const decision = evaluateDateCompletenessGateFsm(job);
    return decision.state === 'date_errors' ? decision.nextAction : null;
};
export const dateImportLoadingMessageForJob = (job = {}) => evaluateDateImportMessageFsm(job).loadingMessage;
export const metadataDateWarningsForJob = (job = {}) => {
    if (job.dateImport?.enabled !== true)
        return [];
    const counts = dateImportIssueCountsForJob(job);
    const sourceLabel = evaluateDateImportMessageFsm(job).sourceLabel;
    const warnings = [];
    if (counts.unresolved > 0) {
        warnings.push(`${counts.unresolved} conversa${counts.unresolved === 1 ? '' : 's'} ` +
            `${counts.unresolved === 1 ? 'ficou' : 'ficaram'} sem datas no ${sourceLabel}.`);
    }
    if (counts.partial > 0) {
        warnings.push(`${counts.partial} conversa${counts.partial === 1 ? '' : 's'} ` +
            `${counts.partial === 1 ? 'ficou' : 'ficaram'} com datas incompletas no ${sourceLabel}.`);
    }
    return warnings;
};
export const exportJobProgressMessageForJob = (job = {}, context = {}) => {
    const errorCount = job.failureCount || 0;
    const fullHistoryVerified = context.fullHistoryVerified === true;
    const mediaWarnings = Number(context.mediaWarnings || 0);
    if (job.status === 'cancel_requested') {
        return 'Cancelamento solicitado. Vou parar antes da próxima conversa.';
    }
    if (job.status === 'cancelled') {
        return 'Exportação cancelada. O relatório já permite retomar depois.';
    }
    if (job.status === 'failed') {
        return 'Exportação falhou. Use o relatório para retomar quando o problema for resolvido.';
    }
    if (job.status === 'completed_with_errors') {
        const dateAction = dateCompletenessNextActionForJob(job);
        if (dateAction)
            return dateAction.message;
        if (job.loadWarning || job.truncated || job.loadMoreTimedOut || job.vaultScan?.truncated) {
            return 'Não consegui confirmar o fim do histórico. O relatório mostra o que foi salvo e como retomar.';
        }
        return `Exportação concluída com ${errorCount} erro${errorCount === 1 ? '' : 's'}.`;
    }
    if (job.status === 'completed') {
        if (job.syncMode) {
            const downloaded = Math.max(0, Number(context.downloadedThisRun || 0));
            return downloaded > 0
                ? `Vault atualizado. ${downloaded} conversa${downloaded === 1 ? '' : 's'} nova${downloaded === 1 ? '' : 's'} salva${downloaded === 1 ? '' : 's'}.`
                : 'Vault já estava atualizado. Nenhuma conversa nova encontrada.';
        }
        if (job.exportMissingOnly && fullHistoryVerified && (job.missingCount || 0) === 0) {
            return 'Histórico inteiro verificado. Nada faltava no vault.';
        }
        if (fullHistoryVerified) {
            const suffix = mediaWarnings > 0
                ? ` ${mediaWarnings} mídia${mediaWarnings === 1 ? '' : 's'} ficaram com warning.`
                : '';
            return `Histórico inteiro verificado.${suffix}`;
        }
        return 'Exportação concluída.';
    }
    if (job.resume && job.phase === 'loading-history') {
        return 'Retomando do relatório anterior e listando histórico do Gemini...';
    }
    if (job.phase === 'loading-history') {
        if (job.syncMode)
            return 'Verificando histórico desde a última sincronização...';
        return 'Listando histórico do Gemini...';
    }
    if (job.phase === 'scanning-vault') {
        if (job.syncMode)
            return 'Lendo índice local do vault antes de sincronizar...';
        return 'Cruzando histórico do Gemini com o vault...';
    }
    if (job.phase === 'loading-metadata') {
        return dateImportLoadingMessageForJob(job);
    }
    if (job.phase === 'resolving-metadata') {
        return 'Conferindo datas do lote antes de salvar...';
    }
    if (job.phase === 'exporting' && job.current?.skippedExisting) {
        const title = job.current.title || job.current.chatId || 'conversa já salva';
        return `Pulando conversa já salva: ${title}`;
    }
    if (job.phase === 'exporting') {
        const title = job.current?.title || job.current?.chatId || '';
        const prefix = job.exportMissingOnly
            ? job.syncMode
                ? 'Baixando conversas novas'
                : 'Baixando somente o que falta no vault'
            : 'Baixando conversas do Gemini';
        return `${prefix}${title ? `: ${title}` : '...'}`;
    }
    if (job.phase === 'writing-report') {
        return 'Gravando relatório final...';
    }
    return 'Preparando...';
};
