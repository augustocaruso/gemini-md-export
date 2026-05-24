import type { BridgeOnlyChildEnv } from '../src/mcp/browser-runtime-env.js';

const bridgeOnlyEnv = {
  GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
  GEMINI_MCP_BROWSER_SIDE_EFFECTS_DISABLED: 'true',
} satisfies BridgeOnlyChildEnv;

void bridgeOnlyEnv;

const bridgeOnlyWithBrowserControl = {
  GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
  // @ts-expect-error bridge-only child env must not authorize browser control.
  GEMINI_MCP_BROWSER_CONTROL: 'cli',
} satisfies BridgeOnlyChildEnv;

void bridgeOnlyWithBrowserControl;

const bridgeOnlyWithSideEffectsOn = {
  GEMINI_MCP_CHROME_LAUNCH_IF_CLOSED: 'false',
  // @ts-expect-error bridge-only child env must not force browser side effects on.
  GEMINI_MCP_BROWSER_SIDE_EFFECTS: 'on',
} satisfies BridgeOnlyChildEnv;

void bridgeOnlyWithSideEffectsOn;
