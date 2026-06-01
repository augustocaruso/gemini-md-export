import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';

const ROOT = resolve(import.meta.dirname, '..');

const runPython = (source) => {
  const result = spawnSync('uv', ['run', '--project', ROOT, 'python', '-c', source], {
    cwd: ROOT,
    encoding: 'utf-8',
  });
  if (result.status !== 0) {
    throw new Error(`python failed\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`);
  }
  return JSON.parse(result.stdout);
};

test('Google auth loader accepts Playwright storage_state and validates required cookies', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-auth-'));
  const storagePath = resolve(dir, 'storage_state.json');
  writeFileSync(
    storagePath,
    JSON.stringify({
      cookies: [
        { name: 'SID', value: 'sid', domain: '.google.com', path: '/', expires: -1 },
        { name: '__Secure-1PSID', value: 'psid', domain: '.google.com', path: '/', expires: -1 },
        { name: '__Secure-1PSIDTS', value: 'psidts', domain: '.google.com', path: '/', expires: -1 },
        { name: 'OSID', value: 'osid', domain: 'accounts.google.com', path: '/', expires: -1 },
      ],
    }),
    'utf-8',
  );

  const data = runPython(`
import json
from gemini_md_export.google_auth_cookies import load_google_auth_cookies
snapshot = load_google_auth_cookies(${JSON.stringify(storagePath)}, recover_psidts=False)
print(json.dumps({
  "ok": snapshot.ok,
  "names": sorted(snapshot.cookies.keys()),
  "source": snapshot.source,
  "secure_1psid": snapshot.secure_1psid,
  "secure_1psidts": snapshot.secure_1psidts,
  "message": snapshot.message,
}))
`);

  assert.equal(data.ok, true);
  assert.equal(data.source, 'explicit_cookies_json');
  assert.equal(data.secure_1psid, 'psid');
  assert.equal(data.secure_1psidts, 'psidts');
  assert.deepEqual(data.names, ['OSID', 'SID', '__Secure-1PSID', '__Secure-1PSIDTS']);
  assert.equal(data.message, null);
});

test('Google auth loader reports missing cookies instead of blaming stale PSIDTS', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-auth-'));
  const storagePath = resolve(dir, 'storage_state.json');
  writeFileSync(
    storagePath,
    JSON.stringify({
      cookies: [
        { name: '__Secure-1PSID', value: 'psid', domain: '.google.com', path: '/', expires: -1 },
      ],
    }),
    'utf-8',
  );

  const data = runPython(`
import json
from gemini_md_export.google_auth_cookies import load_google_auth_cookies
snapshot = load_google_auth_cookies(${JSON.stringify(storagePath)}, recover_psidts=False)
print(json.dumps({
  "ok": snapshot.ok,
  "code": snapshot.code,
  "missing": sorted(snapshot.missing),
  "message": snapshot.message,
}))
`);

  assert.equal(data.ok, false);
  assert.equal(data.code, 'google_auth_cookies_missing_required');
  assert.deepEqual(data.missing, ['SID', '__Secure-1PSIDTS']);
  assert.match(data.message, /sessao Google incompleta/i);
  assert.doesNotMatch(data.message, /expir/i);
});

test('Google auth loader rotates and persists PSIDTS when the cookie set is recoverable', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-auth-'));
  const storagePath = resolve(dir, 'storage_state.json');
  writeFileSync(
    storagePath,
    JSON.stringify({
      cookies: [
        { name: 'SID', value: 'sid', domain: '.google.com', path: '/', expires: -1 },
        { name: '__Secure-1PSID', value: 'psid', domain: '.google.com', path: '/', expires: -1 },
        { name: 'OSID', value: 'osid', domain: 'accounts.google.com', path: '/', expires: -1 },
      ],
    }),
    'utf-8',
  );

  const data = runPython(`
import json
from pathlib import Path
from gemini_md_export.google_auth_cookies import GoogleCookie, load_google_auth_cookies

def fake_rotate(entries):
    return [
        *entries,
        GoogleCookie(name="__Secure-1PSIDTS", value="fresh", domain=".google.com", path="/", expires=-1),
    ]

snapshot = load_google_auth_cookies(
    ${JSON.stringify(storagePath)},
    recover_psidts=True,
    rotate_cookies=fake_rotate,
)
stored = json.loads(Path(${JSON.stringify(storagePath)}).read_text())
print(json.dumps({
  "ok": snapshot.ok,
  "rotation_attempted": snapshot.rotation_attempted,
  "rotation_succeeded": snapshot.rotation_succeeded,
  "secure_1psidts": snapshot.secure_1psidts,
  "stored_names": sorted(item["name"] for item in stored["cookies"]),
}))
`);

  assert.equal(data.ok, true);
  assert.equal(data.rotation_attempted, true);
  assert.equal(data.rotation_succeeded, true);
  assert.equal(data.secure_1psidts, 'fresh');
  assert.deepEqual(data.stored_names, ['OSID', 'SID', '__Secure-1PSID', '__Secure-1PSIDTS']);
});

test('Google auth loader rotates browser-imported PSIDTS in memory', () => {
  const data = runPython(`
import json
from gemini_md_export import google_auth_cookies as mod
from gemini_md_export.google_auth_cookies import GoogleCookie, load_google_auth_cookies

def fake_browser_import():
    return ([
        GoogleCookie(name="SID", value="sid", domain=".google.com", path="/", expires=-1),
        GoogleCookie(name="__Secure-1PSID", value="psid", domain=".google.com", path="/", expires=-1),
        GoogleCookie(name="OSID", value="osid", domain="accounts.google.com", path="/", expires=-1),
    ], ["chrome: 3 cookie(s)"])

def fake_rotate(entries):
    return [
        *entries,
        GoogleCookie(name="__Secure-1PSIDTS", value="fresh-browser", domain=".google.com", path="/", expires=-1),
    ]

mod._load_browser_cookie_entries = fake_browser_import
snapshot = load_google_auth_cookies(
    None,
    recover_psidts=True,
    allow_browser_import=True,
    rotate_cookies=fake_rotate,
)
print(json.dumps({
  "ok": snapshot.ok,
  "source": snapshot.source,
  "rotation_attempted": snapshot.rotation_attempted,
  "rotation_succeeded": snapshot.rotation_succeeded,
  "secure_1psidts": snapshot.secure_1psidts,
  "diagnostics": snapshot.browser_diagnostics,
}))
`);

  assert.equal(data.ok, true);
  assert.equal(data.source, 'browser_import');
  assert.equal(data.rotation_attempted, true);
  assert.equal(data.rotation_succeeded, true);
  assert.equal(data.secure_1psidts, 'fresh-browser');
  assert.deepEqual(data.diagnostics, ['chrome: 3 cookie(s)']);
});

test('Google auth loader prefers rookiepy browser extraction when available', () => {
  const data = runPython(`
import json
import sys
import types
from gemini_md_export import google_auth_cookies as mod

fake_rookiepy = types.SimpleNamespace(
    chrome=lambda domains: [
        {"name": "SID", "value": "sid", "domain": ".google.com", "path": "/", "expires": -1},
        {"name": "__Secure-1PSID", "value": "psid", "domain": ".google.com", "path": "/", "expires": -1},
        {"name": "__Secure-1PSIDTS", "value": "psidts", "domain": ".google.com", "path": "/", "expires": -1},
        {"name": "OSID", "value": "osid", "domain": "accounts.google.com", "path": "/", "expires": -1},
    ],
    edge=lambda domains: [],
    brave=lambda domains: [],
    firefox=lambda domains: [],
    load=lambda domains: [],
)
sys.modules["rookiepy"] = fake_rookiepy
entries, diagnostics = mod._load_browser_cookie_entries()
snapshot = mod._snapshot_from_entries(entries, source="browser_import", browser_diagnostics=diagnostics)
print(json.dumps({
  "ok": snapshot.ok,
  "names": sorted(snapshot.cookies),
  "diagnostics": diagnostics,
}))
`);

  assert.equal(data.ok, true);
  assert.deepEqual(data.names, ['OSID', 'SID', '__Secure-1PSID', '__Secure-1PSIDTS']);
  assert.ok(data.diagnostics.some((line) => line === 'rookiepy:chrome: 4 cookie(s)'));
});

test('Google auth loader imports Dia Chromium profile cookies explicitly', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-dia-auth-'));
  const diaProfile = resolve(dir, 'Default');
  mkdirSync(diaProfile, { recursive: true });
  writeFileSync(resolve(diaProfile, 'Cookies'), 'sqlite-placeholder', 'utf-8');

  const data = runPython(`
import json
import os
import sys
import types
from gemini_md_export import google_auth_cookies as mod

calls = []

def chromium_based(db_path, domains=None):
    calls.append({"db_path": db_path, "domains": domains})
    return [
        {"name": "SID", "value": "sid-dia", "domain": ".google.com", "path": "/", "expires": -1},
        {"name": "__Secure-1PSID", "value": "psid-dia", "domain": ".google.com", "path": "/", "expires": -1},
        {"name": "__Secure-1PSIDTS", "value": "psidts-dia", "domain": ".google.com", "path": "/", "expires": -1},
        {"name": "OSID", "value": "osid-dia", "domain": "accounts.google.com", "path": "/", "expires": -1},
    ]

fake_rookiepy = types.SimpleNamespace(
    chromium_based=chromium_based,
    chrome=lambda domains: [],
    edge=lambda domains: [],
    brave=lambda domains: [],
    firefox=lambda domains: [],
    load=lambda domains: [],
)
sys.modules["rookiepy"] = fake_rookiepy
os.environ["GME_DIA_USER_DATA_DIR"] = ${JSON.stringify(dir)}
entries, diagnostics = mod._load_browser_cookie_entries()
snapshot = mod._snapshot_from_entries(entries, source="browser_import", browser_diagnostics=diagnostics)
print(json.dumps({
  "ok": snapshot.ok,
  "source": snapshot.source,
  "secure_1psid": snapshot.secure_1psid,
  "secure_1psidts": snapshot.secure_1psidts,
  "calls": calls,
  "diagnostics": diagnostics,
}))
`);

  assert.equal(data.ok, true);
  assert.equal(data.source, 'browser_import');
  assert.equal(data.secure_1psid, 'psid-dia');
  assert.equal(data.secure_1psidts, 'psidts-dia');
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].db_path.endsWith('/Default/Cookies'), true);
  assert.ok(data.diagnostics.some((line) => line === 'rookiepy:dia:Default: 4 cookie(s)'));
});

test('Google auth loader falls back to Dia Keychain service when rookiepy cannot decrypt Dia', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-dia-auth-'));
  const diaProfile = resolve(dir, 'Default');
  mkdirSync(diaProfile, { recursive: true });
  writeFileSync(resolve(dir, 'Local State'), '{}', 'utf-8');
  writeFileSync(resolve(diaProfile, 'Cookies'), 'sqlite-placeholder', 'utf-8');

  const data = runPython(`
import json
import os
import sys
import types
from gemini_md_export import google_auth_cookies as mod

def fail_chromium_based(db_path, domains=None):
    raise RuntimeError("missing osx_key_service")

fake_rookiepy = types.SimpleNamespace(
    chromium_based=fail_chromium_based,
    chrome=lambda domains: [],
    edge=lambda domains: [],
    brave=lambda domains: [],
    firefox=lambda domains: [],
    load=lambda domains: [],
)

class FakeCookie:
    def __init__(self, name, value, domain=".google.com", path="/", expires=-1):
        self.name = name
        self.value = value
        self.domain = domain
        self.path = path
        self.expires = expires

    def is_expired(self):
        return False

class FakeChromiumBased:
    calls = []

    def __init__(self, **kwargs):
        self.kwargs = kwargs
        FakeChromiumBased.calls.append(kwargs)

    def load(self):
        return [
            FakeCookie("SID", "sid-dia"),
            FakeCookie("__Secure-1PSID", "psid-dia"),
            FakeCookie("__Secure-1PSIDTS", "psidts-dia"),
            FakeCookie("OSID", "osid-dia", domain="accounts.google.com"),
        ]

def empty_browser(domain_name=None):
    return []

fake_browser_cookie3 = types.SimpleNamespace(
    ChromiumBased=FakeChromiumBased,
    chrome=empty_browser,
    chromium=empty_browser,
    opera=empty_browser,
    opera_gx=empty_browser,
    brave=empty_browser,
    edge=empty_browser,
    vivaldi=empty_browser,
    firefox=empty_browser,
    librewolf=empty_browser,
    safari=empty_browser,
)

sys.modules["rookiepy"] = fake_rookiepy
sys.modules["browser_cookie3"] = fake_browser_cookie3
os.environ["GME_DIA_USER_DATA_DIR"] = ${JSON.stringify(dir)}
entries, diagnostics = mod._load_browser_cookie_entries()
snapshot = mod._snapshot_from_entries(entries, source="browser_import", browser_diagnostics=diagnostics)
print(json.dumps({
  "ok": snapshot.ok,
  "secure_1psid": snapshot.secure_1psid,
  "secure_1psidts": snapshot.secure_1psidts,
  "calls": FakeChromiumBased.calls,
  "diagnostics": diagnostics,
}))
`);

  assert.equal(data.ok, true);
  assert.equal(data.secure_1psid, 'psid-dia');
  assert.equal(data.secure_1psidts, 'psidts-dia');
  assert.equal(data.calls.length, 1);
  assert.equal(data.calls[0].browser, 'Dia');
  assert.equal(data.calls[0].osx_key_service, 'Dia Safe Storage');
  assert.equal(data.calls[0].osx_key_user, 'Dia');
  assert.equal(data.calls[0].cookie_file.endsWith('/Default/Cookies'), true);
  assert.equal(data.calls[0].key_file.endsWith('/Local State'), true);
  assert.ok(data.diagnostics.some((line) => line === 'browser_cookie3:dia:Default: 4 cookie(s)'));
});

test('Google auth loader falls back to browser-cookie3 diagnostics when rookiepy fails', () => {
  const data = runPython(`
import json
import sys
import types
from gemini_md_export import google_auth_cookies as mod

def fail(domains):
    raise RuntimeError("decrypt_encrypted_value failed")

fake_rookiepy = types.SimpleNamespace(
    chrome=fail,
    edge=fail,
    brave=fail,
    firefox=lambda domains: [],
    load=lambda domains: [],
)
def chrome(domain_name=None):
    return []

fake_browser_cookie3 = types.SimpleNamespace(
    chrome=chrome,
    chromium=chrome,
    opera=chrome,
    opera_gx=chrome,
    brave=chrome,
    edge=chrome,
    vivaldi=chrome,
    firefox=chrome,
    librewolf=chrome,
    safari=chrome,
)
sys.modules["rookiepy"] = fake_rookiepy
sys.modules["browser_cookie3"] = fake_browser_cookie3
entries, diagnostics = mod._load_browser_cookie_entries()
print(json.dumps({
  "count": len(entries),
  "has_rookiepy_error": any("rookiepy:chrome: RuntimeError" in item for item in diagnostics),
  "has_browser_cookie3": any(item.startswith("chrome:") for item in diagnostics),
}))
`);

  assert.equal(data.count, 0);
  assert.equal(data.has_rookiepy_error, true);
  assert.equal(data.has_browser_cookie3, true);
});

test('gemini_webapi sidecar preflights explicit cookies before initializing network client', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-auth-'));
  const storagePath = resolve(dir, 'storage_state.json');
  writeFileSync(
    storagePath,
    JSON.stringify({
      cookies: [
        { name: '__Secure-1PSID', value: 'psid', domain: '.google.com', path: '/', expires: -1 },
      ],
    }),
    'utf-8',
  );

  const result = spawnSync(
    'uv',
    ['run', '--project', ROOT, 'gemini-md-export-gemini-webapi-adapter'],
    {
      cwd: ROOT,
      input: JSON.stringify({
        action: 'session_status',
        cookies_json: storagePath,
        timeout_ms: 5000,
      }),
      encoding: 'utf-8',
    },
  );

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'google_auth_cookies_missing_required');
  assert.deepEqual(payload.warnings, []);
  assert.match(payload.message, /sessao Google incompleta/i);
  assert.doesNotMatch(payload.message, /Failed to initialize client/i);
});

test('gemini_webapi sidecar rejects initialized but unauthenticated accounts', () => {
  const dir = mkdtempSync(resolve(tmpdir(), 'gme-auth-status-'));
  const fakePackage = resolve(dir, 'gemini_webapi');
  const storagePath = resolve(dir, 'storage_state.json');
  mkdirSync(fakePackage, { recursive: true });
  writeFileSync(
    resolve(fakePackage, '__init__.py'),
    `
class _AccountStatus:
    name = "UNAUTHENTICATED"
    description = "Session is not authenticated or cookies have expired."

class GeminiClient:
    def __init__(self, *args, **kwargs):
        self.cookies = {}
        self.account_status = None

    async def init(self, *args, **kwargs):
        self.account_status = _AccountStatus()

    def list_chats(self):
        return []

    async def close(self):
        return None

def set_log_level(_level):
    return None
`,
    'utf-8',
  );
  writeFileSync(
    resolve(fakePackage, 'exceptions.py'),
    `
class AuthError(Exception):
    pass
`,
    'utf-8',
  );
  writeFileSync(
    storagePath,
    JSON.stringify({
      cookies: [
        { name: 'SID', value: 'sid', domain: '.google.com', path: '/', expires: -1 },
        { name: '__Secure-1PSID', value: 'psid', domain: '.google.com', path: '/', expires: -1 },
        { name: '__Secure-1PSIDTS', value: 'psidts', domain: '.google.com', path: '/', expires: -1 },
        { name: 'OSID', value: 'osid', domain: 'accounts.google.com', path: '/', expires: -1 },
      ],
    }),
    'utf-8',
  );

  const result = spawnSync(
    'uv',
    ['run', '--project', ROOT, 'python', '-m', 'gemini_md_export.gemini_webapi_adapter'],
    {
      cwd: ROOT,
      input: JSON.stringify({
        action: 'session_status',
        cookies_json: storagePath,
        timeout_ms: 5000,
      }),
      encoding: 'utf-8',
      env: {
        ...process.env,
        PYTHONPATH: `${dir}:${resolve(ROOT, 'python')}:${process.env.PYTHONPATH || ''}`,
      },
    },
  );

  assert.equal(result.status, 1);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, 'gemini_webapi_auth_failed');
  assert.match(payload.message, /UNAUTHENTICATED/);
});
