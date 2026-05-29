import {
  assetRefsFromChatSnapshot,
  buildAssetFetchPlan,
  receiptsForAssetFetchPlan,
} from '../core/assets.js';
import { parseChatId } from '../core/chat-id.js';
import {
  browserBackgroundChatReadCapability,
  buildChatReadAdapterPlan,
  type ChatReadAdapterFallbackWarning,
  type ChatReadAdapterKind,
  type ChatReadAdapterPlan,
  domChatReadCapability,
  initialChatReadAdapterFallbackState,
  privateApiGeminiWebapiChatReadCapability,
  takeoutChatReadCapability,
  transitionChatReadAdapterFallback,
} from '../core/chat-read-adapter.js';
import { renderChatSnapshotMarkdown } from '../core/chat-snapshot-markdown.js';
import type { ChatSnapshot } from '../core/types.js';
import { validateMcpExportPayloadBeforeWrite } from './export-workflows.js';
import { runGeminiWebapiPythonReadChat } from './gemini-webapi-python-adapter.js';
import { buildPrivateApiReadChatCommand } from './private-api-read-chat-command.js';
import { createPrivateReadExportCollector } from './private-read-export-runtime.js';

type PrivateReadArgs = Readonly<{
  action?: unknown;
  privateApiTransport?: unknown;
  chatId?: unknown;
  url?: unknown;
  title?: unknown;
  cookiesJson?: unknown;
  python?: unknown;
  waitMs?: unknown;
  downloadAssets?: unknown;
  assetsDir?: unknown;
  assetsRelDir?: unknown;
  allowDomFallback?: unknown;
}>;

type GeminiWebapiPythonRunner = typeof runGeminiWebapiPythonReadChat;

type PrivateReadDeps = Readonly<{
  requireManagedChatClient: (args: unknown, purpose?: string) => unknown;
  enqueueCommand: (
    clientId: string,
    type: string,
    args?: unknown,
    options?: Readonly<{ timeoutMs?: number; browserSideEffectExplicit?: boolean }>,
  ) => Promise<unknown>;
  summarizeClient: (client: unknown) => unknown;
  runGeminiWebapiPythonReadChat?: GeminiWebapiPythonRunner;
}>;

type PrivateReadRuntimeDeps = PrivateReadDeps &
  Readonly<{
    validateMcpExportPayload: Parameters<
      typeof createPrivateReadExportCollector
    >[0]['validateMcpExportPayload'];
    assertNotAborted: Parameters<typeof createPrivateReadExportCollector>[0]['assertNotAborted'];
    env?: Parameters<typeof createPrivateReadExportCollector>[0]['env'];
  }>;

const clientIdOf = (client: unknown): string => {
  const value =
    client && typeof client === 'object' && 'clientId' in client ? client.clientId : null;
  if (typeof value === 'string' && value.trim()) return value;
  throw Object.assign(new Error('Cliente sem clientId para private_read.'), {
    code: 'private_read_client_id_missing',
  });
};

const usesGeminiWebapiPython = (args: PrivateReadArgs): boolean =>
  args.privateApiTransport === 'gemini-webapi-python';

const stringOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const timeoutMsOf = (value: unknown): number =>
  Math.max(5000, Math.min(120000, Number(value || 45000)));

const objectOrNull = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null;

const allowsDomFallback = (args: PrivateReadArgs): boolean => args.allowDomFallback === true;

const preferredAdapterForArgs = (args: PrivateReadArgs): ChatReadAdapterKind => {
  if (args.privateApiTransport === 'browser-background') return 'browserBackground';
  if (usesGeminiWebapiPython(args)) return 'privateApiGeminiWebapi';
  return 'browserBackground';
};

const buildPrivateReadAdapterPlan = (args: PrivateReadArgs): ChatReadAdapterPlan =>
  buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: preferredAdapterForArgs(args),
    capabilities: [
      privateApiGeminiWebapiChatReadCapability({
        available: !!(parseChatId(args.chatId) || parseChatId(args.url)),
        canReadAssets: true,
        reason:
          parseChatId(args.chatId) || parseChatId(args.url)
            ? 'gemini_webapi_python_sidecar'
            : 'gemini_webapi_python_requires_explicit_chat_id',
      }),
      browserBackgroundChatReadCapability({
        available: true,
        canReadAssets: false,
        reason: 'extension_background_fetch_with_browser_credentials',
      }),
      domChatReadCapability({
        available: allowsDomFallback(args),
        reason: allowsDomFallback(args)
          ? 'connected_gemini_content_script_dom_export'
          : 'dom_fallback_disabled_by_private_export_pipeline',
      }),
      takeoutChatReadCapability({
        available: false,
        reason: 'takeout_source_not_provided_for_private_read',
      }),
    ],
  });

const failureCodeOf = (adapter: ChatReadAdapterKind, result: unknown): string => {
  const record = objectOrNull(result);
  return (
    stringOrNull(record?.code) ||
    stringOrNull(record?.reason) ||
    stringOrNull(record?.errorCode) ||
    `${adapter}_failed`
  );
};

const failureMessageOf = (adapter: ChatReadAdapterKind, result: unknown): string => {
  if (result instanceof Error) return result.message;
  const record = objectOrNull(result);
  return (
    stringOrNull(record?.message) ||
    stringOrNull(record?.error) ||
    stringOrNull(record?.reason) ||
    `O adapter ${adapter} nao conseguiu ler a conversa.`
  );
};

const isOkResult = (result: unknown): boolean => objectOrNull(result)?.ok === true;

const payloadOf = (result: unknown): unknown => objectOrNull(result)?.payload;

const mediaFilesOfResult = (result: unknown): readonly unknown[] => {
  const record = objectOrNull(result);
  return Array.isArray(record?.mediaFiles) ? record.mediaFiles : [];
};

const expectedChatIdOf = (args: PrivateReadArgs): string | null =>
  parseChatId(args.chatId) || parseChatId(args.url);

const snapshotOf = (result: unknown): ChatSnapshot | null => {
  const snapshot = objectOrNull(objectOrNull(result)?.snapshot);
  if (!snapshot) return null;
  if (!parseChatId(snapshot.chatId) || !Array.isArray(snapshot.turns)) return null;
  return snapshot as ChatSnapshot;
};

const enrichSnapshotResult = (result: unknown): Record<string, unknown> => {
  const record = objectOrNull(result) || { result };
  const snapshot = snapshotOf(record);
  if (!snapshot) return record;
  const assetPlan = buildAssetFetchPlan(assetRefsFromChatSnapshot(snapshot));
  return {
    ...record,
    markdown: stringOrNull(record.markdown) || renderChatSnapshotMarkdown({ snapshot }),
    assetPlan: record.assetPlan || assetPlan,
    assetReceipts: record.assetReceipts || receiptsForAssetFetchPlan(assetPlan),
  };
};

export const createMcpPrivateReadAction =
  (deps: PrivateReadDeps) =>
  async (args: PrivateReadArgs = {}) => {
    const adapterPlan = buildPrivateReadAdapterPlan(args);
    let state = initialChatReadAdapterFallbackState(adapterPlan);
    let managedClient: unknown = null;

    const getManagedClient = (purpose: string): unknown => {
      if (!managedClient) managedClient = deps.requireManagedChatClient(args, purpose);
      return managedClient;
    };

    const readAdapter = async (adapter: ChatReadAdapterKind): Promise<unknown> => {
      if (adapter === 'privateApiGeminiWebapi') {
        const runner = deps.runGeminiWebapiPythonReadChat || runGeminiWebapiPythonReadChat;
        return runner({
          chatId: args.chatId || args.url,
          url: args.url,
          title: args.title,
          cookiesJson: args.cookiesJson,
          python: args.python,
          downloadAssets: args.downloadAssets,
          assetsDir: args.assetsDir,
          assetsRelDir: args.assetsRelDir,
          timeoutMs: args.waitMs,
        });
      }

      if (adapter === 'browserBackground') {
        const client = getManagedClient('private-api-read-chat');
        const command = buildPrivateApiReadChatCommand(
          args,
          client as Parameters<typeof buildPrivateApiReadChatCommand>[1],
        );
        const result = await deps.enqueueCommand(
          clientIdOf(client),
          'private-api-read-chat',
          command.args,
          { timeoutMs: command.timeoutMs },
        );
        const merged = {
          client: deps.summarizeClient(client),
          ...(objectOrNull(result) || { result }),
        };
        const enriched = enrichSnapshotResult(merged);
        const assetPlan = objectOrNull(enriched.assetPlan);
        const assetRequestCount = Array.isArray(assetPlan?.requests)
          ? assetPlan.requests.length
          : 0;
        if (
          args.downloadAssets === true &&
          assetRequestCount > 0 &&
          mediaFilesOfResult(enriched).length === 0
        ) {
          return {
            ok: false,
            code: 'browser_background_assets_unavailable',
            message:
              'A leitura pelo navegador encontrou assets, mas ainda nao consegue baixa-los; tentando sidecar Python.',
            chatId: expectedChatIdOf(args),
          };
        }
        return enriched;
      }

      if (adapter === 'dom') {
        const client = getManagedClient('dom-chat-read');
        const expectedChatId = expectedChatIdOf(args);
        const commandType = expectedChatId ? 'get-chat-by-id' : 'get-current-chat';
        const result = await deps.enqueueCommand(
          clientIdOf(client),
          commandType,
          {
            chatId: expectedChatId || undefined,
            url: stringOrNull(args.url) || undefined,
            title: stringOrNull(args.title) || undefined,
            returnToOriginal: true,
          },
          {
            timeoutMs: timeoutMsOf(args.waitMs),
            browserSideEffectExplicit: commandType === 'get-chat-by-id',
          },
        );
        const payload = payloadOf(result);
        const validation = validateMcpExportPayloadBeforeWrite(objectOrNull(payload) || {}, {
          expectedChatId: expectedChatId || undefined,
          requestedChatId: expectedChatId || undefined,
        });
        if (!validation.ok) return validation;
        return {
          ok: true,
          client: deps.summarizeClient(client),
          payload,
          snapshot: validation.snapshot,
          markdownHash: validation.markdownHash,
          assistantTurnCount: validation.assistantTurnCount,
          evidence: validation.evidence,
          warnings: validation.warnings,
        };
      }

      return {
        ok: false,
        code: 'takeout_read_adapter_not_available',
        message: 'Leitura Takeout ainda nao recebeu fonte para private_read.',
      };
    };

    let transition = transitionChatReadAdapterFallback(state, { type: 'start' });
    state = transition.state;

    while (true) {
      const readEffect = transition.effects.find((effect) => effect.type === 'read_adapter');
      if (!readEffect) break;
      let result: unknown;
      try {
        result = await readAdapter(readEffect.adapter);
      } catch (err) {
        result = err;
      }

      if (isOkResult(result)) {
        const success = transitionChatReadAdapterFallback(state, {
          type: 'adapter_succeeded',
          adapter: readEffect.adapter,
        });
        state = success.state;
        return {
          ...enrichSnapshotResult(result),
          ok: true,
          adapter: readEffect.adapter,
          adapterPlan,
          fallbackWarnings: state.warnings,
          adapterAttempts: state.attempts,
        };
      }

      transition = transitionChatReadAdapterFallback(state, {
        type: 'adapter_failed',
        adapter: readEffect.adapter,
        code: failureCodeOf(readEffect.adapter, result),
        message: failureMessageOf(readEffect.adapter, result),
      });
      state = transition.state;
    }

    const warnings: readonly ChatReadAdapterFallbackWarning[] = state.warnings;
    return {
      ok: false,
      code: warnings.at(-1)?.code || 'no_chat_read_adapter_available',
      message:
        warnings.at(-1)?.message || 'Nenhum adapter disponivel conseguiu ler a conversa do Gemini.',
      adapterPlan,
      fallbackWarnings: warnings,
      adapterAttempts: state.attempts,
    };
  };

export const createMcpPrivateReadRuntimes = (deps: PrivateReadRuntimeDeps) => {
  const run = createMcpPrivateReadAction(deps);
  return {
    run,
    collectExport: createPrivateReadExportCollector({
      runPrivateReadAction: run,
      validateMcpExportPayload: deps.validateMcpExportPayload,
      assertNotAborted: deps.assertNotAborted,
      env: deps.env,
    }),
  };
};
