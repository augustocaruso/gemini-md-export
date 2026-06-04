import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { applyPrivateApiSessionDefaults } from './private-api-session-store.js';
const fileOrDirExists = (path, kind) => {
    if (!path || !existsSync(path))
        return false;
    const stat = statSync(path);
    return kind === 'dir' ? stat.isDirectory() : stat.isFile();
};
const checkVault = (vaultDir) => {
    if (!vaultDir) {
        return { ok: false, code: 'vault_dir_missing', message: 'Vault nao configurado.', path: null };
    }
    const path = resolve(vaultDir);
    if (!fileOrDirExists(path, 'dir')) {
        return {
            ok: false,
            code: 'vault_dir_not_found',
            message: `Vault nao encontrado: ${path}`,
            path,
        };
    }
    return { ok: true, code: 'ready', message: 'Vault encontrado.', path };
};
const checkTakeout = (takeout) => {
    if (!takeout) {
        return {
            ok: false,
            code: 'takeout_missing',
            message: 'Takeout nao informado; datas podem depender de My Activity.',
            path: null,
        };
    }
    const path = resolve(takeout);
    if (!fileOrDirExists(path, 'file')) {
        return {
            ok: false,
            code: 'takeout_not_found',
            message: `Takeout nao encontrado: ${path}`,
            path,
        };
    }
    return { ok: true, code: 'ready', message: `Takeout encontrado: ${basename(path)}`, path };
};
const checkSessionFile = (flags) => {
    const effectiveFlags = applyPrivateApiSessionDefaults(flags);
    const path = typeof effectiveFlags.cookiesJson === 'string' ? effectiveFlags.cookiesJson : null;
    if (!path) {
        return {
            flags: effectiveFlags,
            check: {
                ok: false,
                code: 'storage_state_missing',
                message: 'Sessao persistida nao encontrada.',
                path: null,
            },
        };
    }
    return {
        flags: effectiveFlags,
        check: {
            ok: fileOrDirExists(path, 'file'),
            code: fileOrDirExists(path, 'file') ? 'ready' : 'storage_state_not_found',
            message: fileOrDirExists(path, 'file')
                ? 'Sessao persistida encontrada.'
                : `Arquivo de sessao nao encontrado: ${path}`,
            path,
        },
    };
};
export const buildFixVaultPreflightReport = async ({ flags, deps = {}, }) => {
    const session = checkSessionFile(flags);
    const sessionStatus = deps.checkAuthStatus
        ? await deps.checkAuthStatus(session.flags)
        : { ok: session.check.ok, selectedAdapter: session.check.ok ? 'storage_state' : null };
    const sessionReady = sessionStatus.ok === true;
    const sessionMessage = session.check.ok
        ? session.check.message
        : sessionStatus.selectedAdapter === 'browserBackground'
            ? 'Sessao do navegador pronta para API privada.'
            : 'Sessao privada pronta para API privada.';
    const sessionCheck = {
        ...session.check,
        ok: sessionReady,
        code: sessionReady ? 'ready' : session.check.code,
        selectedAdapter: sessionStatus.selectedAdapter || null,
        message: sessionReady
            ? sessionMessage
            : sessionStatus.nextAction?.message || sessionStatus.message || session.check.message,
    };
    const markdownDb = deps.checkMarkdownDb
        ? await deps.checkMarkdownDb()
        : { ok: true, code: 'ready', message: 'MarkdownDB disponivel.' };
    const checks = {
        vault: checkVault(flags.vaultDir),
        takeout: checkTakeout(flags.takeout),
        session: sessionCheck,
        markdownDb,
    };
    const ok = checks.vault.ok && checks.session.ok && checks.markdownDb.ok;
    return {
        ok,
        action: 'fix_vault_preflight',
        requiresBrowser: !checks.session.ok,
        effectiveFlags: session.flags,
        checks,
        nextAction: ok
            ? { code: 'ready', message: 'fix-vault pronto para rodar pela API privada.' }
            : {
                code: 'fix_vault_preflight_failed',
                message: 'Corrija os itens marcados como nao prontos antes de rodar o reparo completo.',
            },
    };
};
export const fixVaultPreflightPlainLabel = (report) => report.ok
    ? 'Fix vault doctor: pronto para rodar pela API privada.'
    : `Fix vault doctor: requer acao - ${report.nextAction.message}`;
