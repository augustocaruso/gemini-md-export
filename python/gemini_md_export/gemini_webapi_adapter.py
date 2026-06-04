"""Typed sidecar around the AGPL gemini_webapi dependency.

The TypeScript core never imports this module. MCP/infra calls it as a JSON
subprocess adapter so the dependency boundary stays explicit and replaceable.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import mimetypes
import re
import sys
from collections.abc import Awaitable, Callable
from contextlib import suppress
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Literal, cast

from pydantic import BaseModel, Field, ValidationError

from .google_auth_cookies import GoogleAuthCookieSnapshot, load_google_auth_cookies


class AdapterRequest(BaseModel):
    action: Literal["read_chat", "list_chats", "session_status"]
    chat_id: str | None = None
    title: str | None = None
    cookies_json: str | None = None
    download_assets: bool = False
    assets_dir: str | None = None
    assets_rel_dir: str | None = None
    limit: int = Field(default=200, ge=1, le=2000)
    timeout_ms: int = Field(default=45_000, ge=5_000, le=120_000)
    auto_refresh: bool = False


class AdapterAssetFile(BaseModel):
    path: str
    filename: str
    relative_path: str
    bytes: int
    sha256: str
    content_type: str | None = None


class AdapterAssetReceipt(BaseModel):
    asset_id: str
    kind: str
    label: str
    status: Literal["downloaded", "failed", "metadata_only"]
    original_url: str | None = None
    files: list[AdapterAssetFile] = Field(default_factory=list)
    error: str | None = None


class AdapterAttachment(BaseModel):
    kind: str = "unknown"
    label: str = "Gemini asset"
    url: str | None = None
    original_url: str | None = None
    asset_id: str | None = None
    sha256: str | None = None
    bytes: int | None = None
    download_status: str | None = None
    download_error: str | None = None


class AdapterTurn(BaseModel):
    role: Literal["user", "assistant"]
    markdown: str
    attachments: list[AdapterAttachment] = Field(default_factory=list)
    created_at: str | None = None


class AdapterSuccess(BaseModel):
    ok: Literal[True] = True
    source: Literal["gemini_webapi_python"] = "gemini_webapi_python"
    chat_id: str
    private_chat_id: str
    title: str | None = None
    date_created: str | None = None
    date_last_message: str | None = None
    turns: list[AdapterTurn]
    asset_receipts: list[AdapterAssetReceipt] = Field(default_factory=list)
    warnings: list[str] = Field(default_factory=list)


class AdapterFailure(BaseModel):
    ok: Literal[False] = False
    source: Literal["gemini_webapi_python"] = "gemini_webapi_python"
    code: str
    message: str
    chat_id: str | None = None
    warnings: list[str] = Field(default_factory=list)


class AdapterChatInfo(BaseModel):
    chat_id: str
    private_chat_id: str
    title: str | None = None
    url: str
    is_pinned: bool = False
    updated_at: str | None = None


class AdapterListChatsSuccess(BaseModel):
    ok: Literal[True] = True
    source: Literal["gemini_webapi_python"] = "gemini_webapi_python"
    chats: list[AdapterChatInfo]
    count: int
    warnings: list[str] = Field(default_factory=list)


class AdapterSessionStatusSuccess(BaseModel):
    ok: Literal[True] = True
    source: Literal["gemini_webapi_python"] = "gemini_webapi_python"
    authenticated: bool = True
    chat_count: int | None = None
    warnings: list[str] = Field(default_factory=list)


def _emit(payload: BaseModel) -> int:
    print(payload.model_dump_json(exclude_none=True))
    return 0 if getattr(payload, "ok", False) is True else 1


def _failure(
    code: str,
    message: str,
    chat_id: str | None = None,
    *,
    warnings: list[str] | None = None,
) -> AdapterFailure:
    return AdapterFailure(code=code, message=message, chat_id=chat_id, warnings=warnings or [])


def _normalize_private_chat_id(value: str) -> str:
    text = value.strip()
    if text.startswith("c_"):
        return text
    if "/app/" in text:
        text = text.rsplit("/app/", 1)[1].split("?", 1)[0].split("#", 1)[0].split("/", 1)[0]
    return f"c_{text}"


def _strip_private_chat_id(value: str) -> str:
    return value[2:] if value.startswith("c_") else value


def _chat_url(chat_id: str) -> str:
    return f"https://gemini.google.com/app/{chat_id}"


def _nested_value(value: object, path: list[int], default: object = None) -> object:
    current = value
    for index in path:
        if not isinstance(current, list) or index >= len(current):
            return default
        current = current[index]
    return current


def _iso_from_epoch(value: object) -> str | None:
    if not isinstance(value, int | float) or isinstance(value, bool):
        return None
    for divisor in (1, 1_000, 1_000_000):
        seconds = value / divisor
        if 946684800 <= seconds <= 4102444800:
            return datetime.fromtimestamp(seconds, UTC).replace(microsecond=0).isoformat().replace(
                "+00:00", "Z"
            )
    return None


def _safe_filename_part(value: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._-]+", "-", value.strip())[:80].strip(".-")
    return text or "asset"


def _asset_kind(asset: object) -> str:
    type_name = type(asset).__name__.lower()
    if "generatedvideo" in type_name:
        return "generated_video"
    if "generatedmedia" in type_name:
        return "generated_media"
    if "generatedimage" in type_name:
        return "generated_image"
    if "webimage" in type_name:
        return "web_image"
    if "image" in type_name:
        return "image"
    return "unknown"


def _asset_url(asset: object) -> str | None:
    for field in ("url", "mp3_url", "thumbnail", "mp3_thumbnail"):
        value = getattr(asset, field, None)
        if isinstance(value, str) and value:
            return value
    return None


def _asset_label(asset: object, kind: str) -> str:
    return str(
        getattr(asset, "title", None)
        or getattr(asset, "alt", None)
        or kind.replace("_", " ").title()
        or "Gemini asset"
    )


def _asset_file(path: Path, assets_root: Path, assets_rel_dir: str) -> AdapterAssetFile:
    resolved = path.resolve()
    try:
        inner = resolved.relative_to(assets_root.resolve())
    except ValueError:
        inner = Path(resolved.name)
    content = resolved.read_bytes()
    relative_path = "/".join([assets_rel_dir.strip("/"), *inner.parts])
    content_type = mimetypes.guess_type(resolved.name)[0]
    return AdapterAssetFile(
        path=str(resolved),
        filename=resolved.name,
        relative_path=relative_path,
        bytes=len(content),
        sha256=hashlib.sha256(content).hexdigest(),
        content_type=content_type,
    )


def _saved_paths(value: object) -> list[Path]:
    if isinstance(value, str) and value and value != "206":
        return [Path(value)]
    if isinstance(value, dict):
        paths: list[Path] = []
        for item in value.values():
            if isinstance(item, str) and item and item != "206":
                paths.append(Path(item))
        return paths
    return []


async def _download_asset(
    asset: object,
    *,
    assets_root: Path | None,
    assets_rel_dir: str,
    asset_id: str,
    kind: str,
    label: str,
) -> AdapterAssetReceipt:
    original_url = _asset_url(asset)
    if assets_root is None:
        return AdapterAssetReceipt(
            asset_id=asset_id,
            kind=kind,
            label=label,
            status="metadata_only",
            original_url=original_url,
            error="asset_download_disabled",
        )

    try:
        assets_root.mkdir(parents=True, exist_ok=True)
        save = getattr(asset, "save", None)
        if not callable(save):
            return AdapterAssetReceipt(
                asset_id=asset_id,
                kind=kind,
                label=label,
                status="failed",
                original_url=original_url,
                error="asset_save_unavailable",
            )
        base_name = _safe_filename_part(f"{asset_id}-{kind}")
        save_asset = cast(Callable[..., Awaitable[object]], save)
        saved = await save_asset(path=str(assets_root), filename=base_name, verbose=False)
        files = [_asset_file(path, assets_root, assets_rel_dir) for path in _saved_paths(saved)]
        if not files:
            return AdapterAssetReceipt(
                asset_id=asset_id,
                kind=kind,
                label=label,
                status="failed",
                original_url=original_url,
                error="asset_save_returned_no_files",
            )
        return AdapterAssetReceipt(
            asset_id=asset_id,
            kind=kind,
            label=label,
            status="downloaded",
            original_url=original_url,
            files=files,
        )
    except Exception as exc:
        return AdapterAssetReceipt(
            asset_id=asset_id,
            kind=kind,
            label=label,
            status="failed",
            original_url=original_url,
            error=str(exc),
        )


def _cookie_failure(
    snapshot: GoogleAuthCookieSnapshot,
    chat_id: str | None = None,
) -> AdapterFailure:
    return _failure(
        snapshot.code or "google_auth_cookies_unavailable",
        snapshot.message or "Nao encontrei uma sessao Google utilizavel para a API privada.",
        chat_id,
        warnings=[*snapshot.warnings, *snapshot.browser_diagnostics],
    )


def _auth_snapshot_for_request(request: AdapterRequest) -> GoogleAuthCookieSnapshot:
    return load_google_auth_cookies(
        request.cookies_json,
        recover_psidts=True,
        allow_browser_import=not request.cookies_json,
    )


def _account_status_failure(client: Any, chat_id: str | None) -> AdapterFailure | None:
    status = getattr(client, "account_status", None)
    name = str(getattr(status, "name", "") or "").strip()
    if not name or name == "AVAILABLE":
        return None
    description = str(getattr(status, "description", "") or "").strip()
    detail = f"Account status: {name}"
    if description:
        detail = f"{detail} - {description}"
    return _failure(
        "gemini_webapi_auth_failed",
        detail,
        chat_id,
        warnings=[f"account_status:{name}"],
    )


async def _init_client(request: AdapterRequest) -> tuple[Any | None, AdapterFailure | None]:
    try:
        from gemini_webapi import GeminiClient, set_log_level
        from gemini_webapi.exceptions import AuthError
    except ModuleNotFoundError as exc:
        chat_id = _strip_private_chat_id(_normalize_private_chat_id(request.chat_id or ""))
        return None, _failure(
            "gemini_webapi_missing",
            f"Dependencia Python gemini_webapi ausente: {exc.name}",
            chat_id,
        )

    set_log_level("WARNING")
    auth_snapshot = _auth_snapshot_for_request(request)
    chat_id = _strip_private_chat_id(_normalize_private_chat_id(request.chat_id or ""))
    if request.cookies_json and not auth_snapshot.ok:
        return None, _cookie_failure(auth_snapshot, chat_id)

    try:
        if auth_snapshot.ok and auth_snapshot.secure_1psid:
            client = GeminiClient(
                secure_1psid=auth_snapshot.secure_1psid,
                secure_1psidts=auth_snapshot.secure_1psidts or "",
            )
            client.cookies = auth_snapshot.cookies
        else:
            # gemini_webapi[browser] can import cookies from the local browser profile.
            client = GeminiClient()
        await client.init(
            timeout=max(5, request.timeout_ms / 1000),
            auto_close=False,
            auto_refresh=request.auto_refresh,
        )
        account_failure = _account_status_failure(client, chat_id)
        if account_failure is not None:
            with suppress(Exception):
                await client.close()
            return None, account_failure
        return client, None
    except AuthError as exc:
        if not request.cookies_json and not auth_snapshot.ok:
            return None, _cookie_failure(auth_snapshot, chat_id)
        return None, _failure("gemini_webapi_auth_failed", str(exc), chat_id)
    except Exception as exc:
        return None, _failure("gemini_webapi_init_failed", str(exc), chat_id)


def _attachment_from_asset(
    *,
    kind: str,
    label: str,
    asset_id: str,
    receipt: AdapterAssetReceipt,
) -> AdapterAttachment:
    first_file = receipt.files[0] if receipt.files else None
    return AdapterAttachment(
        kind=kind,
        label=label,
        url=first_file.relative_path if first_file else receipt.original_url,
        original_url=receipt.original_url,
        asset_id=asset_id,
        sha256=first_file.sha256 if first_file else None,
        bytes=first_file.bytes if first_file else None,
        download_status=receipt.status,
        download_error=receipt.error,
    )


async def _raw_turn_dates_latest_first(
    client: Any, private_chat_id: str, limit: int
) -> tuple[list[str | None], list[str]]:
    warnings: list[str] = []
    try:
        from gemini_webapi.client import GRPC, RPCData, extract_json_from_response, get_nested_value
    except Exception as exc:
        return [], [f"raw_date_import_unavailable:{type(exc).__name__}"]

    try:
        response = await client._batch_execute(
            [
                RPCData(
                    rpcid=GRPC.READ_CHAT,
                    payload=json.dumps([private_chat_id, limit, None, 1, [1], [4], None, 1]),
                ),
            ]
        )
        response_json = extract_json_from_response(response.text)
    except Exception as exc:
        return [], [f"raw_date_rpc_failed:{type(exc).__name__}"]

    for part in response_json:
        part_body_str = get_nested_value(part, [2])
        if not part_body_str:
            continue
        try:
            part_body = json.loads(part_body_str)
        except Exception:
            warnings.append("raw_date_part_invalid_json")
            continue
        turns_data = get_nested_value(part_body, [0])
        if not turns_data:
            continue

        turn_dates: list[str | None] = []
        for conv_turn in turns_data:
            date = _iso_from_epoch(_nested_value(conv_turn, [4, 0]))
            candidates_list = get_nested_value(conv_turn, [3, 0])
            if candidates_list:
                has_model_turn = False
                for candidate_data in candidates_list:
                    if get_nested_value(candidate_data, [0]):
                        has_model_turn = True
                        break
                if has_model_turn:
                    turn_dates.append(date)
            user_text = get_nested_value(conv_turn, [2, 0, 0], "")
            if user_text:
                turn_dates.append(date)
        if turn_dates:
            return turn_dates, warnings

    return [], warnings or ["raw_date_turns_missing"]


async def _turns_from_history(
    history: object,
    turn_dates_latest_first: list[str | None] | None = None,
    *,
    download_assets: bool = False,
    assets_dir: str | None = None,
    assets_rel_dir: str,
) -> tuple[list[AdapterTurn], list[AdapterAssetReceipt]]:
    turns = list(getattr(history, "turns", []) or [])
    dates = list(reversed(turn_dates_latest_first or []))
    assets_root = Path(assets_dir).resolve() if download_assets and assets_dir else None
    output: list[AdapterTurn] = []
    receipts: list[AdapterAssetReceipt] = []
    # gemini_webapi returns newest-first; exporter snapshots use source order.
    for index, turn in enumerate(reversed(turns)):
        role = "assistant" if getattr(turn, "role", "") == "model" else "user"
        text = str(getattr(turn, "text", "") or "").strip()
        attachments: list[AdapterAttachment] = []
        model_output = getattr(turn, "model_output", None)
        if model_output is not None:
            assets = [
                *(getattr(model_output, "images", []) or []),
                *(getattr(model_output, "videos", []) or []),
                *(getattr(model_output, "media", []) or []),
            ]
            for asset_index, asset in enumerate(assets):
                kind = _asset_kind(asset)
                label = _asset_label(asset, kind)
                asset_id = f"turn-{index:04d}-asset-{asset_index:02d}"
                receipt = await _download_asset(
                    asset,
                    assets_root=assets_root,
                    assets_rel_dir=assets_rel_dir,
                    asset_id=asset_id,
                    kind=kind,
                    label=label,
                )
                receipts.append(receipt)
                attachments.append(
                    _attachment_from_asset(
                        kind=kind,
                        label=label,
                        asset_id=asset_id,
                        receipt=receipt,
                    )
                )
        if not text and attachments:
            text = "Anexo gerado pelo Gemini."
        if not text:
            continue
        output.append(
            AdapterTurn(
                role=role,
                markdown=text,
                attachments=attachments,
                created_at=dates[index] if index < len(dates) else None,
            )
        )
    return output, receipts


def _chat_dates_from_turns(turns: list[AdapterTurn]) -> tuple[str | None, str | None]:
    dates = [turn.created_at for turn in turns if turn.created_at]
    if not dates:
        return None, None
    return min(dates), max(dates)


async def _read_chat(request: AdapterRequest) -> AdapterSuccess | AdapterFailure:
    if not request.chat_id:
        return _failure("invalid_request", "chat_id e obrigatorio para read_chat")

    private_chat_id = _normalize_private_chat_id(request.chat_id)
    chat_id = _strip_private_chat_id(private_chat_id)
    client, init_failure = await _init_client(request)
    if init_failure is not None:
        init_failure.chat_id = chat_id
        return init_failure
    assert client is not None

    try:
        history = await client.read_chat(private_chat_id, limit=request.limit)
        if not history:
            return _failure(
                "gemini_webapi_empty_history",
                "gemini_webapi nao retornou turnos para este chat.",
                chat_id,
            )
        raw_turn_dates, date_warnings = await _raw_turn_dates_latest_first(
            client, private_chat_id, request.limit
        )
        assets_rel_dir = request.assets_rel_dir or f"assets/{chat_id}"
        turns, asset_receipts = await _turns_from_history(
            history,
            raw_turn_dates,
            download_assets=request.download_assets,
            assets_dir=request.assets_dir,
            assets_rel_dir=assets_rel_dir,
        )
        date_created, date_last_message = _chat_dates_from_turns(turns)
        asset_warnings = [
            f"asset_{receipt.status}:{receipt.asset_id}:{receipt.error}"
            for receipt in asset_receipts
            if receipt.status != "downloaded"
        ]
        return AdapterSuccess(
            chat_id=chat_id,
            private_chat_id=private_chat_id,
            title=request.title,
            date_created=date_created,
            date_last_message=date_last_message,
            turns=turns,
            asset_receipts=asset_receipts,
            warnings=[*date_warnings, *asset_warnings],
        )
    except Exception as exc:
        return _failure("gemini_webapi_read_failed", str(exc), chat_id)
    finally:
        with suppress(Exception):
            await client.close()


def _iso_from_chat_timestamp(value: object) -> str | None:
    if not isinstance(value, int | float) or isinstance(value, bool) or value <= 0:
        return None
    return datetime.fromtimestamp(float(value), UTC).replace(microsecond=0).isoformat().replace(
        "+00:00", "Z"
    )


async def _list_chats(request: AdapterRequest) -> AdapterListChatsSuccess | AdapterFailure:
    client, init_failure = await _init_client(request)
    if init_failure is not None:
        return init_failure
    assert client is not None

    try:
        fetch_recent = getattr(client, "_fetch_recent_chats", None)
        if callable(fetch_recent):
            fetch_recent_async = cast(Callable[[int], Awaitable[object]], fetch_recent)
            await fetch_recent_async(request.limit)
        raw_chats = client.list_chats() or []
        chats: list[AdapterChatInfo] = []
        seen: set[str] = set()
        for item in raw_chats:
            private_chat_id = str(getattr(item, "cid", "") or "").strip()
            if not private_chat_id:
                continue
            chat_id = _strip_private_chat_id(private_chat_id)
            if not chat_id or chat_id in seen:
                continue
            seen.add(chat_id)
            chats.append(
                AdapterChatInfo(
                    chat_id=chat_id,
                    private_chat_id=private_chat_id,
                    title=str(getattr(item, "title", "") or "") or None,
                    url=_chat_url(chat_id),
                    is_pinned=bool(getattr(item, "is_pinned", False)),
                    updated_at=_iso_from_chat_timestamp(getattr(item, "timestamp", None)),
                )
            )
        return AdapterListChatsSuccess(chats=chats, count=len(chats))
    except Exception as exc:
        return _failure("gemini_webapi_list_chats_failed", str(exc))
    finally:
        with suppress(Exception):
            await client.close()


async def _session_status(request: AdapterRequest) -> AdapterSessionStatusSuccess | AdapterFailure:
    client, init_failure = await _init_client(request)
    if init_failure is not None:
        return init_failure
    assert client is not None
    try:
        raw_chats = client.list_chats()
        return AdapterSessionStatusSuccess(
            authenticated=True,
            chat_count=len(raw_chats) if isinstance(raw_chats, list) else None,
        )
    finally:
        with suppress(Exception):
            await client.close()


async def _main() -> int:
    try:
        request = AdapterRequest.model_validate_json(sys.stdin.read())
    except ValidationError as exc:
        return _emit(_failure("invalid_request", exc.errors()[0]["msg"]))
    except Exception as exc:
        return _emit(_failure("invalid_request", str(exc)))
    if request.action == "read_chat":
        return _emit(await _read_chat(request))
    if request.action == "list_chats":
        return _emit(await _list_chats(request))
    return _emit(await _session_status(request))


def main() -> None:
    raise SystemExit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
