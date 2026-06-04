import assert from 'node:assert/strict';
import test from 'node:test';

import {
  discoverLoadedBrowserExtensionsFromProfiles,
  planLoadedBrowserExtensionSync,
} from '../build/ts/cli/windows-extension-sync-plan.js';

const canonicalPath =
  'C:\\Users\\leo\\.gemini\\extensions\\gemini-md-export\\browser-extension';
const legacyPath = 'C:\\Users\\leona\\AppData\\Local\\GeminiMdExport\\extension';
const sourcePath = 'C:\\payload\\dist\\extension';

test('sync plan keeps the canonical browser extension and marks duplicate IDs for removal', () => {
  const plan = planLoadedBrowserExtensionSync(
    [
      {
        browser: 'Chrome',
        profile: 'Default',
        extensionId: 'bpdmkcbcnhgbofiodbachaimkjodjpji',
        extensionPath: canonicalPath,
      },
      {
        browser: 'Chrome',
        profile: 'Default',
        extensionId: 'ccojhfcdbfcafijgmakpdlinoiollfmh',
        extensionPath: legacyPath,
      },
    ],
    {
      canonicalExtensionPath: canonicalPath,
      legacyExtensionPath: 'C:\\Users\\leo\\AppData\\Local\\GeminiMdExport\\extension',
      sourceExtensionPath: sourcePath,
      platform: 'win32',
    },
  );

  assert.deepEqual(
    plan.map((item) => ({
      id: item.extensionId,
      status: item.status,
      shouldSync: item.shouldSync,
      duplicateOf: item.duplicateOf,
    })),
    [
      {
        id: 'bpdmkcbcnhgbofiodbachaimkjodjpji',
        status: 'already-current-path',
        shouldSync: false,
        duplicateOf: null,
      },
      {
        id: 'ccojhfcdbfcafijgmakpdlinoiollfmh',
        status: 'duplicate-needs-removal',
        shouldSync: false,
        duplicateOf: 'bpdmkcbcnhgbofiodbachaimkjodjpji',
      },
    ],
  );
});

test('profile discovery reads Secure Preferences extension records', () => {
  const records = discoverLoadedBrowserExtensionsFromProfiles(
    [
      {
        browser: 'Chrome',
        profile: 'Default',
        fileName: 'Secure Preferences',
        settings: {
          ccojhfcdbfcafijgmakpdlinoiollfmh: {
            path: legacyPath,
            location: 4,
            active_permissions: {
              explicit_host: ['https://gemini.google.com/*'],
            },
          },
        },
        profileDir: 'C:\\Users\\leo\\AppData\\Local\\Google\\Chrome\\User Data\\Default',
        preferencesPath:
          'C:\\Users\\leo\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Secure Preferences',
      },
    ],
    {
      isExtensionDir: (dir) => dir === legacyPath,
      platform: 'win32',
    },
  );

  assert.deepEqual(records, [
    {
      browser: 'Chrome',
      profile: 'Default',
      extensionId: 'ccojhfcdbfcafijgmakpdlinoiollfmh',
      extensionPath: legacyPath,
      preferencesPath:
        'C:\\Users\\leo\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Secure Preferences',
      preferencesFile: 'Secure Preferences',
    },
  ]);
});
