import { existsSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { canonicalGeminiChatUrl, parseChatId } from './chat-id.js';
import { planExportAdapters } from './export-adapter-policy.js';
import { buildFixVaultProgressViewModel } from './progress-view-model.js';
export const FIX_VAULT_MANUAL_ACTION_EXIT_CODE = 2;
export const diagnosisExitIsUsable = (exitCode) => exitCode === 0 || exitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE;
export const buildRepairAuditArgs = ({ vaultDir, repairReportDir, takeout = '', }) => {
    const args = ['--dry-run', '--skip-browser-check', '--report-dir', repairReportDir];
    if (takeout)
        args.push('--takeout', takeout);
    args.push(vaultDir);
    return args;
};
export const buildMetadataArgs = ({ vaultDir, reportPath, flags, diagnoseOnly = false, }) => {
    const args = [vaultDir, '--report', reportPath, '--bridge-url', flags.bridgeUrl];
    if (flags.takeout)
        args.push('--takeout', flags.takeout);
    if (!flags.noMyActivity)
        args.push('--use-my-activity');
    if (flags.openIfMissing === false)
        args.push('--no-open-if-missing');
    else if (flags.openIfMissing === true)
        args.push('--open-if-missing');
    if (Number.isFinite(flags.limit) && Number(flags.limit) > 0) {
        args.push('--limit', String(flags.limit));
    }
    if (diagnoseOnly)
        args.push('--diagnose-only');
    return args;
};
export const buildWebRepairArgs = ({ vaultDir, repairReportDir, flags, repairTargetPaths, }) => {
    const args = ['--report-dir', repairReportDir, '--bridge-url', flags.bridgeUrl];
    if (flags.takeout)
        args.push('--takeout', flags.takeout);
    if (flags.claimId)
        args.push('--claim-id', flags.claimId);
    if (flags.clientId)
        args.push('--client-id', flags.clientId);
    if (flags.tabId !== null && flags.tabId !== undefined)
        args.push('--tab-id', String(flags.tabId));
    if (flags.session)
        args.push('--session', flags.session);
    if (flags.activateTab === true)
        args.push('--activate-tab');
    for (const targetPath of repairTargetPaths)
        args.push('--path', targetPath);
    args.push(vaultDir);
    return args;
};
export const metadataExportErrorItems = (diagnosisReport) => (diagnosisReport?.items || []).filter((item) => item.status === 'export_error');
export const repairTargetPathsFromDiagnosis = ({ vaultDir, diagnosisReport, }) => metadataExportErrorItems(diagnosisReport)
    .map((item) => (item.file ? resolve(vaultDir, item.file) : null))
    .filter((item) => Boolean(item && existsSync(item)));
export const buildFixVaultPrivateRepairTargets = ({ vaultDir, diagnosisReport, vaultRecords = [], }) => {
    const resolvedVaultDir = resolve(vaultDir);
    const byPath = new Map();
    const recordsByPath = new Map(vaultRecords.map((record) => [resolve(record.sourcePath), record]));
    const addTarget = (record, reason, missingAssets = []) => {
        const resolvedPath = resolve(record.sourcePath);
        const existing = byPath.get(resolvedPath);
        const reasons = new Set([...(existing?.reasons || []), reason]);
        const assetSet = new Set([...(existing?.missingAssets || []), ...missingAssets]);
        byPath.set(resolvedPath, {
            chatId: String(record.chatId).toLowerCase(),
            title: record.title || null,
            url: record.url || null,
            sourcePath: resolvedPath,
            relativePath: record.relativePath,
            outputDir: dirname(resolvedPath),
            filename: basename(resolvedPath),
            reasons: [...reasons].sort(),
            missingAssets: [...assetSet].sort(),
        });
    };
    for (const item of metadataExportErrorItems(diagnosisReport)) {
        const targetPath = item.file ? resolve(resolvedVaultDir, item.file) : null;
        if (!targetPath || !existsSync(targetPath))
            continue;
        const record = recordsByPath.get(resolve(targetPath));
        if (record) {
            addTarget(record, 'metadata_export_error');
            continue;
        }
        const chatId = parseChatId(item.chatId) || parseChatId(item.url) || parseChatId(targetPath);
        if (!chatId)
            continue;
        addTarget({
            chatId,
            title: item.title || basename(targetPath, '.md'),
            url: item.url || canonicalGeminiChatUrl(chatId),
            sourcePath: targetPath,
            relativePath: item.file || basename(targetPath),
            missingAssets: [],
        }, 'metadata_export_error');
    }
    for (const record of vaultRecords) {
        if ((record.missingAssets || []).length > 0) {
            addTarget(record, 'missing_asset', record.missingAssets || []);
        }
    }
    return [...byPath.values()].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
};
export const buildFixVaultRepairAdapterPlan = ({ flags, targets, }) => planExportAdapters({
    operationKind: 'fix_vault',
    knownChatIds: targets.map((target) => target.chatId),
    privateApiAvailable: flags.privateApi !== false,
    extensionPrivateApiAvailable: false,
    pythonSidecarAvailable: flags.privateApi !== false,
    browserFallbackAllowed: flags.privateApi === false || flags.openIfMissing === true,
});
export const buildFixVaultPrivateRepairExportOptions = (flags) => ({
    bridgeUrl: flags.bridgeUrl,
    limit: flags.limit,
    waitMs: flags.waitMs,
    privateReadWaitMs: flags.privateReadWaitMs,
    timeoutMs: flags.timeoutMs,
    pollMs: flags.pollMs,
    clientId: flags.clientId,
    tabId: flags.tabId,
    claimId: flags.claimId,
    sessionId: flags.sessionId || flags.session,
    openIfMissing: false,
    wakeBrowser: false,
    activateTab: false,
    allowReload: false,
    bootstrapTimeoutMs: flags.bootstrapTimeoutMs,
    browserKeepAliveMs: flags.bridgeKeepAliveMs,
    python: flags.python,
    cookiesJson: flags.cookiesJson,
    delayMs: flags.delayMs,
});
export const formatFixVaultProgressLine = ({ format, current, total, message, }) => {
    const view = buildFixVaultProgressViewModel({ current, total, message });
    if (format !== 'tui' && format !== 'tui-stream')
        return `Fix vault: ${message}...\n`;
    const width = 28;
    const filled = Math.round((view.barCurrent / Math.max(1, view.total)) * width);
    return `▕${'█'.repeat(filled)}${'░'.repeat(width - filled)}▏ ${view.countLabel} ${view.label}\n`;
};
export const buildFixVaultCombinedReport = ({ generatedAt, vaultDir, takeout, repairExitCode, diagnosisExitCode, repairAdapter = 'private_api', webRepairExitCode, webRepairSkipped, webRepairTargetCount, webRepairUnavailable = null, metadataExitCode, repairReportDir, repairPreliminaryReportPath, metadataDiagnosisReportPath, metadataReportPath, repairSummary, diagnosisSummary, metadataSummary, warnings, }) => {
    const diagnosisUsable = diagnosisExitIsUsable(diagnosisExitCode);
    const ok = repairExitCode === 0 && diagnosisUsable && webRepairExitCode === 0 && metadataExitCode === 0;
    return {
        schema: 'gemini-md-export.fix-vault-report.v1',
        generatedAt,
        vaultDir,
        takeout,
        ok,
        steps: [
            {
                name: 'repair-audit',
                status: repairExitCode === 0 ? 'completed' : 'failed',
                exitCode: repairExitCode,
                reportDir: repairReportDir,
            },
            {
                name: 'metadata-diagnosis',
                status: diagnosisExitCode === 0
                    ? 'completed'
                    : diagnosisExitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE
                        ? 'blocked'
                        : 'failed',
                exitCode: diagnosisExitCode,
                reportPath: metadataDiagnosisReportPath,
            },
            {
                name: repairAdapter === 'web' ? 'web-repair' : 'private-api-repair',
                status: webRepairSkipped
                    ? 'skipped'
                    : webRepairExitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE
                        ? 'blocked'
                        : webRepairExitCode === 0
                            ? 'completed'
                            : 'failed',
                exitCode: webRepairExitCode,
                targetCount: webRepairTargetCount,
                reportDir: repairReportDir,
            },
            {
                name: 'metadata-backfill',
                status: metadataExitCode === 0
                    ? 'completed'
                    : metadataExitCode === FIX_VAULT_MANUAL_ACTION_EXIT_CODE
                        ? 'blocked'
                        : 'failed',
                exitCode: metadataExitCode,
                reportPath: metadataReportPath,
            },
            {
                name: 'vault-validation',
                status: ok ? 'completed' : 'blocked',
                exitCode: repairExitCode ||
                    (diagnosisUsable ? 0 : diagnosisExitCode) ||
                    webRepairExitCode ||
                    metadataExitCode,
            },
        ],
        reports: {
            repairPreliminaryReport: repairPreliminaryReportPath,
            metadataDiagnosisReport: metadataDiagnosisReportPath,
            metadataReport: metadataReportPath,
        },
        summary: {
            repair: {
                verificationQueueSize: repairSummary?.verificationQueueSize || 0,
                wikiReviewQueueSize: repairSummary?.wikiReviewQueueSize || 0,
                takeoutEvidence: repairSummary?.takeoutEvidence?.summary || { enabled: false },
            },
            diagnosis: diagnosisSummary || null,
            chatRepair: {
                adapter: repairAdapter,
                targetCount: webRepairTargetCount,
                exitCode: webRepairExitCode,
                skipped: webRepairSkipped,
                unavailable: webRepairUnavailable,
            },
            webRepair: {
                targetCount: webRepairTargetCount,
                exitCode: webRepairExitCode,
                skipped: webRepairSkipped,
                unavailable: webRepairUnavailable,
            },
            metadata: metadataSummary || null,
        },
        warnings,
    };
};
