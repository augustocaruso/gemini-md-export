import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildUsageHelp,
  commonOptionHelp,
  exitCodeHelp,
  jobOptionHelp,
  outputModeHelp,
} from '../build/ts/cli/help-text.js';

test('CLI common help text lives outside the JavaScript entrypoint', () => {
  assert.match(outputModeHelp().join('\n'), /--tui/);
  assert.match(exitCodeHelp().join('\n'), /64  uso invalido/);
  assert.match(commonOptionHelp().join('\n'), /--bridge-url <url>/);
  assert.match(jobOptionHelp().join('\n'), /--resume-report-file <path>/);
  assert.match(buildUsageHelp({ version: '0.0.0' }), /gemini-md-export 0\.0\.0/);
});
