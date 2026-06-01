"""Google cookie auth lifecycle helpers for Gemini private API adapters.

Portions of this module are adapted from `notebooklm-py`:
https://github.com/teng-lin/notebooklm-py

MIT License
Copyright (c) 2026 Teng Lin

The original project treats Google cookie auth as a product surface: validate
required cookies before RPC calls, extract installed-browser cookies with
``rookiepy`` when available, explain incomplete browser extraction, and rotate
``__Secure-1PSIDTS`` when the rest of the Google binding is present. This
adapter keeps the same discipline while returning redacted, structured results
for gemini-md-export.
"""

from __future__ import annotations

import json
import os
import time
from collections.abc import Callable, Iterable, Mapping
from contextlib import suppress
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import BaseModel, Field

CookieSource = Literal["explicit_cookies_json", "browser_import", "none"]

MINIMUM_REQUIRED_COOKIES = frozenset({"SID", "__Secure-1PSIDTS"})
GEMINI_WEBAPI_REQUIRED_COOKIES = frozenset({"__Secure-1PSID"})
PSIDTS_COOKIE = "__Secure-1PSIDTS"
ALLOWED_AUTH_DOMAINS = frozenset(
    {
        "google.com",
        ".google.com",
        "accounts.google.com",
        ".accounts.google.com",
        "gemini.google.com",
        ".gemini.google.com",
    }
)
ROTATE_COOKIES_URL = "https://accounts.google.com/RotateCookies"
ROTATE_COOKIES_HEADERS = {
    "Content-Type": "application/json",
    "Origin": "https://accounts.google.com",
}
ROTATE_COOKIES_BODY = '[000,"-0000000000000000000"]'
ROOKIEPY_BROWSER_ALIASES = ("chrome", "edge", "brave", "firefox", "auto")
ROOKIEPY_COOKIE_DOMAINS = (
    ".google.com",
    "google.com",
    "accounts.google.com",
    "gemini.google.com",
)
DIA_USER_DATA_ENV_VARS = (
    "GME_DIA_USER_DATA_DIR",
    "GEMINI_MCP_DIA_USER_DATA_DIR",
    "DIA_USER_DATA_DIR",
)
DIA_OSX_KEY_SERVICE = "Dia Safe Storage"
DIA_OSX_KEY_USER = "Dia"


class GoogleCookie(BaseModel):
    name: str
    value: str
    domain: str = ".google.com"
    path: str = "/"
    expires: int | float | None = None


class GoogleAuthCookieSnapshot(BaseModel):
    ok: bool
    source: CookieSource
    cookies: dict[str, str] = Field(default_factory=dict)
    cookie_entries: list[GoogleCookie] = Field(default_factory=list)
    secure_1psid: str | None = None
    secure_1psidts: str | None = None
    missing: list[str] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)
    code: str | None = None
    message: str | None = None
    browser_diagnostics: list[str] = Field(default_factory=list)
    rotation_attempted: bool = False
    rotation_succeeded: bool = False


RotateCookiesFn = Callable[[list[GoogleCookie]], list[GoogleCookie] | None]


def _normalize_domain(value: Any) -> str:
    raw = str(value or ".google.com").strip().lower()
    return raw or ".google.com"


def _auth_domain_priority(domain: str) -> int:
    normalized = _normalize_domain(domain).lstrip(".")
    if normalized == "google.com":
        return 100
    if normalized == "accounts.google.com":
        return 80
    if normalized == "gemini.google.com":
        return 70
    if normalized.endswith(".google.com"):
        return 40
    return 0


def _is_allowed_auth_domain(domain: str) -> bool:
    normalized = _normalize_domain(domain)
    bare = normalized.lstrip(".")
    return normalized in ALLOWED_AUTH_DOMAINS or bare.endswith(".google.com")


def _has_valid_secondary_binding(cookie_names: set[str]) -> bool:
    if "OSID" in cookie_names:
        return True
    return {"APISID", "SAPISID"} <= cookie_names


def _psidts_needs_recovery(
    cookie_names: set[str],
    cookie_expiry: Mapping[str, Any],
    *,
    now: float | None = None,
) -> bool:
    if PSIDTS_COOKIE not in cookie_names:
        return True
    expires = cookie_expiry.get(PSIDTS_COOKIE)
    if expires in (None, -1):
        return False
    if not isinstance(expires, int | float) or isinstance(expires, bool):
        return False
    return expires < (time.time() if now is None else now)


def _cookie_message(missing: set[str], cookie_names: set[str], source: CookieSource) -> str:
    source_text = (
        "o arquivo de cookies informado"
        if source == "explicit_cookies_json"
        else "os navegadores locais"
        if source == "browser_import"
        else "a sessão local"
    )
    if not cookie_names:
        return (
            f"Nao encontrei cookies Google utilizaveis em {source_text}. "
            "Abra o Gemini no navegador logado e conecte a extensao, "
            "ou forneca um storage_state.json valido."
        )
    if "SID" in missing:
        return (
            f"A sessao Google incompleta em {source_text}: faltou SID. "
            "Entre na conta Google no navegador e abra https://gemini.google.com "
            "antes de tentar de novo."
        )
    if PSIDTS_COOKIE in missing and not _has_valid_secondary_binding(cookie_names):
        return (
            f"A sessao Google incompleta em {source_text}: faltou __Secure-1PSIDTS e tambem "
            "OSID ou APISID+SAPISID. Abra o Gemini no navegador logado para o Google "
            "renovar os cookies."
        )
    if PSIDTS_COOKIE in missing:
        return (
            f"A sessao Google incompleta em {source_text}: faltou __Secure-1PSIDTS. "
            "O cookie pode ser renovado pelo RotateCookies quando a sessao ainda esta valida."
        )
    if "__Secure-1PSID" in missing:
        return (
            f"A sessao Google incompleta em {source_text}: faltou __Secure-1PSID, "
            "que o adapter Gemini precisa para abrir a sessao privada."
        )
    return (
        f"A sessao Google em {source_text} esta incompleta para a API privada do Gemini. "
        "Abra o Gemini no navegador logado e tente novamente."
    )


def _coerce_cookie_entries(data: Any, *, default_domain: str = ".google.com") -> list[GoogleCookie]:
    if isinstance(data, Mapping) and isinstance(data.get("cookies"), Mapping | list):
        data = data["cookies"]

    entries: list[GoogleCookie] = []
    if isinstance(data, Mapping):
        for name, value in data.items():
            if isinstance(name, str) and isinstance(value, str) and value:
                entries.append(GoogleCookie(name=name, value=value, domain=default_domain))
        return entries

    if isinstance(data, list):
        for item in data:
            if not isinstance(item, Mapping):
                continue
            name = item.get("name")
            value = item.get("value")
            if not isinstance(name, str) or not isinstance(value, str) or not value:
                continue
            expires = item.get("expires")
            entries.append(
                GoogleCookie(
                    name=name,
                    value=value,
                    domain=_normalize_domain(item.get("domain", default_domain)),
                    path=str(item.get("path") or "/"),
                    expires=expires if isinstance(expires, int | float) else None,
                )
            )
    return entries


def _cookie_value(item: Mapping[str, Any], *names: str) -> Any:
    for name in names:
        value = item.get(name)
        if value not in (None, ""):
            return value
    return None


def _coerce_rookiepy_cookie(item: Mapping[str, Any]) -> GoogleCookie | None:
    name = _cookie_value(item, "name")
    value = _cookie_value(item, "value")
    if not isinstance(name, str) or not isinstance(value, str) or not value:
        return None
    expires = _cookie_value(item, "expires", "expiry", "expirationDate", "expires_utc")
    return GoogleCookie(
        name=name,
        value=value,
        domain=_normalize_domain(_cookie_value(item, "domain", "host", "host_key")),
        path=str(_cookie_value(item, "path") or "/"),
        expires=expires if isinstance(expires, int | float) else None,
    )


def _coerce_rookiepy_cookies(raw_cookies: Iterable[Any]) -> list[GoogleCookie]:
    entries: list[GoogleCookie] = []
    for raw in raw_cookies:
        if not isinstance(raw, Mapping):
            continue
        cookie = _coerce_rookiepy_cookie(raw)
        if cookie is not None:
            entries.append(cookie)
    return entries


def _unique_existing_paths(paths: Iterable[Path]) -> list[Path]:
    seen: set[str] = set()
    unique: list[Path] = []
    for path in paths:
        try:
            resolved = path.expanduser().resolve()
        except Exception:
            resolved = path.expanduser()
        key = str(resolved)
        if key in seen or not resolved.exists():
            continue
        seen.add(key)
        unique.append(resolved)
    return unique


def _dia_user_data_roots() -> list[Path]:
    env_roots = [
        Path(value)
        for name in DIA_USER_DATA_ENV_VARS
        if (value := str(os.environ.get(name, "")).strip())
    ]
    if env_roots:
        return _unique_existing_paths(env_roots)
    home = Path.home()
    local_app_data = str(os.environ.get("LOCALAPPDATA", "")).strip()
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", home / ".config"))
    defaults = [
        home / "Library" / "Application Support" / "Dia" / "User Data",
        home / "Library" / "Application Support" / "Dia" / "User Data" / "User Data",
        *([Path(local_app_data) / "Dia" / "User Data"] if local_app_data else []),
        home / "AppData" / "Local" / "Dia" / "User Data",
        config_home / "Dia",
    ]
    return _unique_existing_paths([*env_roots, *defaults])


def _profile_sort_key(path: Path) -> tuple[int, str]:
    name = path.name
    if name == "Default":
        return (0, name)
    if name.startswith("Profile "):
        suffix = name.removeprefix("Profile ")
        if suffix.isdigit():
            return (1, f"{int(suffix):04d}")
        return (1, name)
    return (2, name)


def _dia_cookie_db_candidates() -> list[Path]:
    candidates: list[Path] = []
    for root in _dia_user_data_roots():
        profile_dirs = [root]
        with suppress(OSError):
            profile_dirs.extend(
                sorted(
                    [child for child in root.iterdir() if child.is_dir()],
                    key=_profile_sort_key,
                )
            )
        for profile_dir in profile_dirs:
            for cookie_path in (profile_dir / "Cookies", profile_dir / "Network" / "Cookies"):
                if cookie_path.is_file():
                    candidates.append(cookie_path)
    return _unique_existing_paths(candidates)


def _dia_cookie_profile_label(cookie_db: Path) -> str:
    if cookie_db.parent.name == "Network":
        return cookie_db.parent.parent.name
    return cookie_db.parent.name


def _dia_local_state_for_cookie_db(cookie_db: Path) -> Path:
    if cookie_db.parent.name == "Network":
        return cookie_db.parent.parent.parent / "Local State"
    return cookie_db.parent.parent / "Local State"


def _load_dia_rookiepy_cookie_entries(rookiepy: Any) -> tuple[list[GoogleCookie], list[str]]:
    chromium_based = getattr(rookiepy, "chromium_based", None)
    if not callable(chromium_based):
        return [], ["rookiepy:dia: chromium_based indisponivel."]

    entries: list[GoogleCookie] = []
    diagnostics: list[str] = []
    candidates = _dia_cookie_db_candidates()
    if not candidates:
        return [], ["rookiepy:dia: nenhum perfil Dia com Cookies encontrado."]

    for cookie_db in candidates:
        label = _dia_cookie_profile_label(cookie_db)
        try:
            raw_cookies = chromium_based(str(cookie_db), domains=list(ROOKIEPY_COOKIE_DOMAINS))
        except Exception as exc:  # pragma: no cover - depends on host profile encryption.
            diagnostics.append(f"rookiepy:dia:{label}: {type(exc).__name__}: {str(exc)[:160]}")
            continue
        browser_entries = _coerce_rookiepy_cookies(cast(Iterable[Any], raw_cookies))
        entries.extend(browser_entries)
        diagnostics.append(f"rookiepy:dia:{label}: {len(browser_entries)} cookie(s)")
    return entries, diagnostics


def _coerce_cookiejar_entries(cookiejar: Iterable[Any]) -> list[GoogleCookie]:
    entries: list[GoogleCookie] = []
    for cookie in cookiejar:
        if cookie.is_expired():
            continue
        entries.append(
            GoogleCookie(
                name=str(cookie.name),
                value=str(cookie.value),
                domain=_normalize_domain(cookie.domain),
                path=str(cookie.path or "/"),
                expires=cookie.expires,
            )
        )
    return entries


def _load_dia_browser_cookie3_cookie_entries(bc3: Any) -> tuple[list[GoogleCookie], list[str]]:
    chromium_based = getattr(bc3, "ChromiumBased", None)
    if not callable(chromium_based):
        return [], ["browser_cookie3:dia: ChromiumBased indisponivel."]

    entries: list[GoogleCookie] = []
    diagnostics: list[str] = []
    candidates = _dia_cookie_db_candidates()
    if not candidates:
        return [], ["browser_cookie3:dia: nenhum perfil Dia com Cookies encontrado."]

    for cookie_db in candidates:
        label = _dia_cookie_profile_label(cookie_db)
        local_state = _dia_local_state_for_cookie_db(cookie_db)
        try:
            browser = cast(Any, chromium_based)(
                browser="Dia",
                cookie_file=str(cookie_db),
                domain_name="google.com",
                key_file=str(local_state) if local_state.is_file() else None,
                os_crypt_name="chromium",
                osx_key_service=DIA_OSX_KEY_SERVICE,
                osx_key_user=DIA_OSX_KEY_USER,
                osx_cookies=[],
                linux_cookies=[],
                windows_cookies=[],
                windows_keys=[],
            )
            jar = browser.load()
        except Exception as exc:  # pragma: no cover - depends on host profile encryption.
            diagnostics.append(f"browser_cookie3:dia:{label}: {type(exc).__name__}")
            continue
        browser_entries = _coerce_cookiejar_entries(jar)
        entries.extend(browser_entries)
        diagnostics.append(f"browser_cookie3:dia:{label}: {len(browser_entries)} cookie(s)")
    return entries, diagnostics


def _load_rookiepy_cookie_entries() -> tuple[list[GoogleCookie], list[str]]:
    try:
        import rookiepy
    except ModuleNotFoundError:
        return [], ["rookiepy indisponivel no ambiente Python."]

    entries: list[GoogleCookie] = []
    diagnostics: list[str] = []
    dia_entries, dia_diagnostics = _load_dia_rookiepy_cookie_entries(rookiepy)
    entries.extend(dia_entries)
    diagnostics.extend(dia_diagnostics)
    for browser_name in ROOKIEPY_BROWSER_ALIASES:
        try:
            cookie_fn = rookiepy.load if browser_name == "auto" else getattr(rookiepy, browser_name)
            raw_cookies = cookie_fn(domains=list(ROOKIEPY_COOKIE_DOMAINS))
        except Exception as exc:  # pragma: no cover - depends on host browsers.
            diagnostics.append(f"rookiepy:{browser_name}: {type(exc).__name__}: {str(exc)[:160]}")
            continue
        browser_entries = _coerce_rookiepy_cookies(raw_cookies)
        entries.extend(browser_entries)
        diagnostics.append(f"rookiepy:{browser_name}: {len(browser_entries)} cookie(s)")
    return entries, diagnostics


def _index_cookie_entries(
    entries: Iterable[GoogleCookie],
) -> tuple[dict[str, str], dict[str, Any], list[GoogleCookie]]:
    values: dict[str, str] = {}
    expiry: dict[str, Any] = {}
    selected: dict[str, GoogleCookie] = {}
    priority: dict[str, int] = {}

    for entry in entries:
        if not entry.name or not entry.value:
            continue
        if not _is_allowed_auth_domain(entry.domain):
            continue
        item_priority = _auth_domain_priority(entry.domain)
        if entry.name not in values or item_priority > priority[entry.name]:
            values[entry.name] = entry.value
            expiry[entry.name] = entry.expires
            selected[entry.name] = entry
            priority[entry.name] = item_priority

    return values, expiry, list(selected.values())


def _snapshot_from_entries(
    entries: list[GoogleCookie],
    *,
    source: CookieSource,
    browser_diagnostics: list[str] | None = None,
    rotation_attempted: bool = False,
    rotation_succeeded: bool = False,
) -> GoogleAuthCookieSnapshot:
    cookies, expiry, selected_entries = _index_cookie_entries(entries)
    cookie_names = set(cookies)
    missing = set(MINIMUM_REQUIRED_COOKIES | GEMINI_WEBAPI_REQUIRED_COOKIES) - cookie_names
    warnings: list[str] = []
    if not missing and not _has_valid_secondary_binding(cookie_names):
        warnings.append(
            "Sessao Google sem binding secundario forte: preciso de OSID ou APISID+SAPISID."
        )
    if _psidts_needs_recovery(cookie_names, expiry) and PSIDTS_COOKIE in cookie_names:
        missing.add(PSIDTS_COOKIE)

    if missing:
        return GoogleAuthCookieSnapshot(
            ok=False,
            source=source,
            cookies=cookies,
            cookie_entries=selected_entries,
            secure_1psid=cookies.get("__Secure-1PSID"),
            secure_1psidts=cookies.get(PSIDTS_COOKIE),
            missing=sorted(missing),
            warnings=warnings,
            code="google_auth_cookies_missing_required",
            message=_cookie_message(missing, cookie_names, source),
            browser_diagnostics=browser_diagnostics or [],
            rotation_attempted=rotation_attempted,
            rotation_succeeded=rotation_succeeded,
        )

    return GoogleAuthCookieSnapshot(
        ok=True,
        source=source,
        cookies=cookies,
        cookie_entries=selected_entries,
        secure_1psid=cookies.get("__Secure-1PSID"),
        secure_1psidts=cookies.get(PSIDTS_COOKIE),
        warnings=warnings,
        browser_diagnostics=browser_diagnostics or [],
        rotation_attempted=rotation_attempted,
        rotation_succeeded=rotation_succeeded,
    )


def _can_rotate_psidts(snapshot: GoogleAuthCookieSnapshot) -> bool:
    cookie_names = set(snapshot.cookies)
    return (
        "SID" in cookie_names
        and "__Secure-1PSID" in cookie_names
        and PSIDTS_COOKIE in snapshot.missing
        and _has_valid_secondary_binding(cookie_names)
    )


def _merge_cookie_entries(
    current_entries: Iterable[GoogleCookie],
    rotated_entries: Iterable[GoogleCookie],
) -> list[GoogleCookie]:
    merged: dict[tuple[str, str, str], GoogleCookie] = {}
    for entry in current_entries:
        merged[(entry.name, _normalize_domain(entry.domain), entry.path or "/")] = entry
    for entry in rotated_entries:
        merged[(entry.name, _normalize_domain(entry.domain), entry.path or "/")] = entry
    return list(merged.values())


def _write_cookie_json(path: str, original_data: Any, entries: list[GoogleCookie]) -> None:
    dumped_entries = [entry.model_dump(exclude_none=True) for entry in entries]
    if isinstance(original_data, Mapping) and isinstance(original_data.get("cookies"), list):
        updated = dict(original_data)
        updated["cookies"] = dumped_entries
    elif isinstance(original_data, Mapping) and isinstance(original_data.get("cookies"), Mapping):
        updated = dict(original_data)
        cookies = dict(original_data["cookies"])
        cookies.update({entry.name: entry.value for entry in entries})
        updated["cookies"] = cookies
    elif isinstance(original_data, Mapping):
        updated = dict(original_data)
        updated.update({entry.name: entry.value for entry in entries})
    else:
        updated = {"cookies": dumped_entries}
    Path(path).write_text(json.dumps(updated, ensure_ascii=False), encoding="utf-8")


def _rotate_google_cookies(entries: list[GoogleCookie]) -> list[GoogleCookie] | None:
    try:
        from curl_cffi.requests import Session
    except ModuleNotFoundError:
        return None

    session = Session(impersonate="chrome", allow_redirects=True, timeout=8)
    try:
        for entry in entries:
            session.cookies.set(
                entry.name,
                entry.value,
                domain=entry.domain,
                path=entry.path or "/",
            )
        response = session.post(
            ROTATE_COOKIES_URL,
            headers=ROTATE_COOKIES_HEADERS,
            data=ROTATE_COOKIES_BODY,
        )
        if response.status_code == 401:
            return None
        response.raise_for_status()
        rotated: list[GoogleCookie] = []
        for cookie in session.cookies.jar:
            if cookie.is_expired():
                continue
            rotated.append(
                GoogleCookie(
                    name=str(cookie.name),
                    value=str(cookie.value),
                    domain=_normalize_domain(cookie.domain),
                    path=str(cookie.path or "/"),
                    expires=cookie.expires,
                )
            )
        return rotated
    except Exception:
        return None
    finally:
        session.close()


def _recover_psidts(
    *,
    path: str,
    original_data: Any,
    snapshot: GoogleAuthCookieSnapshot,
    rotate_cookies: RotateCookiesFn,
) -> GoogleAuthCookieSnapshot:
    if not _can_rotate_psidts(snapshot):
        return snapshot.model_copy(update={"rotation_attempted": PSIDTS_COOKIE in snapshot.missing})
    rotated_entries = rotate_cookies(snapshot.cookie_entries)
    if not rotated_entries:
        return snapshot.model_copy(update={"rotation_attempted": True, "rotation_succeeded": False})
    merged_entries = _merge_cookie_entries(snapshot.cookie_entries, rotated_entries)
    recovered = _snapshot_from_entries(
        merged_entries,
        source=snapshot.source,
        browser_diagnostics=snapshot.browser_diagnostics,
        rotation_attempted=True,
        rotation_succeeded=True,
    )
    if recovered.ok:
        _write_cookie_json(path, original_data, merged_entries)
    return recovered


def _recover_psidts_in_memory(
    *,
    snapshot: GoogleAuthCookieSnapshot,
    rotate_cookies: RotateCookiesFn,
) -> GoogleAuthCookieSnapshot:
    if not _can_rotate_psidts(snapshot):
        return snapshot.model_copy(update={"rotation_attempted": PSIDTS_COOKIE in snapshot.missing})
    rotated_entries = rotate_cookies(snapshot.cookie_entries)
    if not rotated_entries:
        return snapshot.model_copy(update={"rotation_attempted": True, "rotation_succeeded": False})
    return _snapshot_from_entries(
        _merge_cookie_entries(snapshot.cookie_entries, rotated_entries),
        source=snapshot.source,
        browser_diagnostics=snapshot.browser_diagnostics,
        rotation_attempted=True,
        rotation_succeeded=True,
    )


def _read_cookie_json(path: str | None) -> Any:
    if not path:
        return None
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _load_browser_cookie_entries() -> tuple[list[GoogleCookie], list[str]]:
    rookie_entries, rookie_diagnostics = _load_rookiepy_cookie_entries()
    if rookie_entries:
        return rookie_entries, rookie_diagnostics

    try:
        import browser_cookie3 as bc3
    except ModuleNotFoundError:
        return [], [*rookie_diagnostics, "browser-cookie3 indisponivel no ambiente Python."]

    entries: list[GoogleCookie] = []
    diagnostics: list[str] = [*rookie_diagnostics]
    dia_entries, dia_diagnostics = _load_dia_browser_cookie3_cookie_entries(bc3)
    entries.extend(dia_entries)
    diagnostics.extend(dia_diagnostics)
    browser_fns: list[Callable[..., Any]] = [
        bc3.chrome,
        bc3.chromium,
        bc3.opera,
        bc3.opera_gx,
        bc3.brave,
        bc3.edge,
        bc3.vivaldi,
        bc3.firefox,
        bc3.librewolf,
        bc3.safari,
    ]
    for cookie_fn in browser_fns:
        name = getattr(cookie_fn, "__name__", "browser")
        try:
            jar = cookie_fn(domain_name="google.com")
        except Exception as exc:  # pragma: no cover - depends on host browsers.
            diagnostics.append(f"{name}: {type(exc).__name__}")
            continue
        browser_entries = _coerce_cookiejar_entries(jar)
        entries.extend(browser_entries)
        diagnostics.append(f"{name}: {len(browser_entries)} cookie(s)")
    return entries, diagnostics


def load_google_auth_cookies(
    cookies_json: str | None,
    *,
    recover_psidts: bool = False,
    allow_browser_import: bool = False,
    rotate_cookies: RotateCookiesFn | None = None,
) -> GoogleAuthCookieSnapshot:
    """Load and preflight Google cookies without leaking secret values."""
    if cookies_json:
        data = _read_cookie_json(cookies_json)
        snapshot = _snapshot_from_entries(
            _coerce_cookie_entries(data),
            source="explicit_cookies_json",
        )
        if recover_psidts and not snapshot.ok and PSIDTS_COOKIE in snapshot.missing:
            return _recover_psidts(
                path=cookies_json,
                original_data=data,
                snapshot=snapshot,
                rotate_cookies=rotate_cookies or _rotate_google_cookies,
            )
        return snapshot

    if allow_browser_import:
        entries, diagnostics = _load_browser_cookie_entries()
        snapshot = _snapshot_from_entries(
            entries,
            source="browser_import",
            browser_diagnostics=diagnostics,
        )
        if recover_psidts and not snapshot.ok and PSIDTS_COOKIE in snapshot.missing:
            return _recover_psidts_in_memory(
                snapshot=snapshot,
                rotate_cookies=rotate_cookies or _rotate_google_cookies,
            )
        return snapshot

    return GoogleAuthCookieSnapshot(
        ok=False,
        source="none",
        code="google_auth_cookies_not_provided",
        message="Nenhum arquivo de cookies foi fornecido.",
    )
