export const FORBIDDEN_BRIDGE_ONLY_BROWSER_ENV_KEYS = Object.freeze([
  'GEMINI_MCP_BROWSER_CONTROL',
  'GEMINI_MD_EXPORT_BROWSER_CONTROL',
  'GME_BROWSER_CONTROL',
  'GEMINI_MCP_BROWSER_SIDE_EFFECTS',
  'GEMINI_MD_EXPORT_BROWSER_SIDE_EFFECTS',
] as const);

export type ForbiddenBridgeOnlyBrowserEnvKey =
  (typeof FORBIDDEN_BRIDGE_ONLY_BROWSER_ENV_KEYS)[number];

export type BridgeOnlyChildEnv = Readonly<
  Record<string, string | undefined> & { GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false' } & {
    [K in ForbiddenBridgeOnlyBrowserEnvKey]?: never;
  }
>;

export const buildBridgeOnlyChildEnv = (
  baseEnv: Record<string, string | undefined> = process.env,
): BridgeOnlyChildEnv => {
  const env: Record<string, string | undefined> = { ...baseEnv };
  for (const key of FORBIDDEN_BRIDGE_ONLY_BROWSER_ENV_KEYS) {
    delete env[key];
  }
  env.GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED = 'false';
  return env as BridgeOnlyChildEnv;
};
