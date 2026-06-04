import { runPrivateApiSelectedExport, summarizePrivateApiSelectedExportJob, } from './private-api-selected-export.js';
const EXIT = {
    OK: 0,
    WARNINGS: 1,
    JOB_FAILED: 5,
};
const terminal = (job) => ['completed', 'completed_with_errors', 'failed'].includes(job.status);
const selectFormat = (flags, stdout) => {
    if (flags.format === 'json' || flags.format === 'jsonl' || flags.format === 'plain') {
        return flags.format;
    }
    if (flags.format === 'tui' && !stdout?.isTTY)
        return 'plain';
    if (flags.format === 'tui')
        return 'tui';
    return stdout?.isTTY ? 'tui' : 'plain';
};
const exitCodeFor = (job) => {
    if (job.status === 'completed')
        return EXIT.OK;
    if (job.status === 'completed_with_errors')
        return EXIT.WARNINGS;
    return EXIT.JOB_FAILED;
};
const bar = (job, width) => {
    const total = Math.max(1, job.requested);
    const active = job.current && !terminal(job) ? 0.62 : 0;
    const current = job.status === 'completed' || job.status === 'completed_with_errors'
        ? total
        : Math.min(total, Math.max(0, job.completed + active));
    const filled = Math.max(0, Math.min(width, Math.round((current / total) * width)));
    return `[${'#'.repeat(filled)}${'-'.repeat(width - filled)}]`;
};
const renderTui = (stdout, job) => {
    const width = Math.max(18, Math.min(42, Math.floor((stdout.columns || 88) / 3)));
    const count = `${Math.min(job.completed + (job.current && !terminal(job) ? 1 : 0), job.requested)}/${job.requested}`;
    const current = job.current?.title || job.current?.chatId || '';
    const line = `${bar(job, width)} ${count} ${job.progressMessage}${current ? ` - ${current}` : ''}`;
    stdout.write(`\r\x1b[2K${line.slice(0, Math.max(40, (stdout.columns || 120) - 1))}`);
    if (terminal(job))
        stdout.write('\n');
};
const renderPlain = (stdout, job, previousKey) => {
    const key = `${job.status}|${job.completed}|${job.current?.chatId || ''}|${job.progressMessage}`;
    if (key === previousKey)
        return previousKey;
    stdout.write(`[${new Date().toLocaleTimeString()}] ${job.status}/${job.phase}: ${job.completed}/${job.requested} - ${job.progressMessage}\n`);
    return key;
};
const writeResult = (stdout, format, flags, job) => {
    const result = summarizePrivateApiSelectedExportJob(job);
    if (format === 'json') {
        stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return result;
    }
    if (format === 'jsonl') {
        stdout.write(`${JSON.stringify({ type: 'result', result })}\n`);
        return result;
    }
    stdout.write(job.status === 'completed'
        ? `Export privado concluido: ${job.successCount}/${job.requested} chat(s).\n`
        : `Export privado terminou com ${job.failureCount} falha(s).\n`);
    if (flags.resultJson === true)
        stdout.write(`RESULT_JSON ${JSON.stringify(result)}\n`);
    return result;
};
export const runPrivateApiSelectedExportCommand = async ({ flags, streams = {} }) => {
    const stdout = streams.stdout || process.stdout;
    const format = selectFormat(flags, stdout);
    let latestJob = null;
    let previousPlainKey = '';
    const onProgress = (job) => {
        latestJob = job;
        if (format === 'jsonl')
            stdout.write(`${JSON.stringify({ type: 'job_status', job })}\n`);
        else if (format === 'plain')
            previousPlainKey = renderPlain(stdout, job, previousPlainKey);
        else if (format === 'tui')
            renderTui(stdout, job);
    };
    const timer = format === 'tui'
        ? setInterval(() => {
            if (latestJob && !terminal(latestJob))
                renderTui(stdout, latestJob);
        }, 250)
        : null;
    timer?.unref();
    try {
        const job = await runPrivateApiSelectedExport({
            chatIds: flags.chatIds,
            items: flags.selectionItems,
            expectedCount: flags.expectedCount,
            outputDir: flags.outputDir,
            limit: flags.maxChats,
            waitMs: flags.waitMs,
            privateReadWaitMs: flags.privateReadWaitMs,
            timeoutMs: flags.timeoutMs,
            bootstrapTimeoutMs: flags.bootstrapTimeoutMs,
            bridgeUrl: flags.bridgeUrl,
            pollMs: flags.pollMs,
            clientId: flags.clientId,
            tabId: flags.tabId,
            claimId: flags.claimId,
            sessionId: flags.sessionId,
            openIfMissing: flags.openIfMissing,
            wakeBrowser: flags.wakeBrowser,
            activateTab: flags.activateTab,
            allowReload: flags.allowReload,
            python: flags.python,
            cookiesJson: flags.cookiesJson,
            delayMs: flags.delayMs,
            recent: flags.privateApiRecent === true,
            startIndex: flags.startIndex,
            onProgress,
        });
        const result = writeResult(stdout, format, flags, job);
        return { exitCode: exitCodeFor(job), result };
    }
    finally {
        if (timer)
            clearInterval(timer);
    }
};
