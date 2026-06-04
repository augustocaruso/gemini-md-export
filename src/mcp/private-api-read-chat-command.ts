import {
  browserBackgroundChatReadCapability,
  buildChatReadAdapterPlan,
  domChatReadCapability,
  takeoutChatReadCapability,
} from '../core/chat-read-adapter.js';

type PrivateReadArgs = Readonly<{
  chatId?: unknown;
  url?: unknown;
  title?: unknown;
  waitMs?: unknown;
  downloadAssets?: unknown;
  assetsRelDir?: unknown;
  assetsDir?: unknown;
}>;

type PrivateReadClient = Readonly<{
  page?: Readonly<{
    chatId?: unknown;
    title?: unknown;
  }> | null;
}> | null;

const stringOrNull = (value: unknown): string | null => {
  const text = String(value ?? '').trim();
  return text || null;
};

const privateReadTimeoutMs = (value: unknown): number =>
  Math.max(5000, Math.min(120000, Number(value || 45000)));

export const buildPrivateApiReadChatCommand = (
  args: PrivateReadArgs = {},
  client: PrivateReadClient = null,
) => {
  const timeoutMs = privateReadTimeoutMs(args.waitMs);
  const adapterPlan = buildChatReadAdapterPlan({
    allowExperimental: true,
    preferredAdapter: 'browserBackground',
    capabilities: [
      browserBackgroundChatReadCapability({
        available: true,
        reason: 'extension_background_fetch_with_browser_credentials',
      }),
      domChatReadCapability({
        available: true,
        reason: 'connected_gemini_content_script',
      }),
      takeoutChatReadCapability({
        available: false,
        reason: 'takeout_source_not_provided_for_private_read',
      }),
    ],
  });
  return {
    args: {
      chatId:
        stringOrNull(args.chatId) || stringOrNull(args.url) || stringOrNull(client?.page?.chatId),
      title: stringOrNull(args.title) || stringOrNull(client?.page?.title),
      timeoutMs,
      downloadAssets: args.downloadAssets === true,
      assetsRelDir: stringOrNull(args.assetsRelDir),
      assetsDir: stringOrNull(args.assetsDir),
      adapterPlan,
    },
    timeoutMs,
    adapterPlan,
  };
};
