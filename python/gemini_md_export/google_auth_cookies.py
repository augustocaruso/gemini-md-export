"""Google cookie auth lifecycle helpers for Gemini private API adapters.

Portions of this module are adapted from `notebooklm-py`:
https://github.com/teng-lin/notebooklm-py

MIT License
Copyright (c) 2026 Teng Lin

The original project treats Google cookie auth as a product surface: validate
required cookies before RPC calls, explain incomplete browser extraction, and
rotate ``__Secure-1PSIDTS`` when the rest of the Google binding is present.
This adapter keeps the same discipline while returning redacted, structured
results for gemini-md-export.
"""

from __future__ import annotations

import json
import time
from collections.abc import Callable, Iterable, Mapping
from pathlib import Path
from typing import Any, Literal

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
    try:
        import browser_cookie3 as bc3
    except ModuleNotFoundError:
        return [], ["browser-cookie3 indisponivel no ambiente Python."]

    entries: list[GoogleCookie] = []
    diagnostics: list[str] = []
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
        count = 0
        for cookie in jar:
            if cookie.is_expired():
                continue
            count += 1
            entries.append(
                GoogleCookie(
                    name=str(cookie.name),
                    value=str(cookie.value),
                    domain=_normalize_domain(cookie.domain),
                    path=str(cookie.path or "/"),
                    expires=cookie.expires,
                )
            )
        diagnostics.append(f"{name}: {count} cookie(s)")
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
