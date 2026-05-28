"""Typed sidecar around the AGPL gemini_webapi dependency.

The TypeScript core never imports this module. MCP/infra calls it as a JSON
subprocess adapter so the dependency boundary stays explicit and replaceable.
"""

from __future__ import annotations

import asyncio
import json
import sys
from contextlib import suppress
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError


class AdapterRequest(BaseModel):
    action: Literal["read_chat"]
    chat_id: str
    title: str | None = None
    cookies_json: str | None = None
    limit: int = Field(default=200, ge=1, le=2000)
    timeout_ms: int = Field(default=45_000, ge=5_000, le=120_000)
    auto_refresh: bool = False


class AdapterAttachment(BaseModel):
    kind: str = "unknown"
    label: str = "Gemini asset"
    url: str | None = None


class AdapterTurn(BaseModel):
    role: Literal["user", "assistant"]
    markdown: str
    attachments: list[AdapterAttachment] = Field(default_factory=list)


class AdapterSuccess(BaseModel):
    ok: Literal[True] = True
    source: Literal["gemini_webapi_python"] = "gemini_webapi_python"
    chat_id: str
    private_chat_id: str
    title: str | None = None
    turns: list[AdapterTurn]
    warnings: list[str] = Field(default_factory=list)


class AdapterFailure(BaseModel):
    ok: Literal[False] = False
    source: Literal["gemini_webapi_python"] = "gemini_webapi_python"
    code: str
    message: str
    chat_id: str | None = None
    warnings: list[str] = Field(default_factory=list)


def _emit(payload: BaseModel) -> int:
    print(payload.model_dump_json(exclude_none=True))
    return 0 if getattr(payload, "ok", False) is True else 1


def _failure(code: str, message: str, chat_id: str | None = None) -> AdapterFailure:
    return AdapterFailure(code=code, message=message, chat_id=chat_id)


def _normalize_private_chat_id(value: str) -> str:
    text = value.strip()
    if text.startswith("c_"):
        return text
    if "/app/" in text:
        text = text.rsplit("/app/", 1)[1].split("?", 1)[0].split("#", 1)[0].split("/", 1)[0]
    return f"c_{text}"


def _strip_private_chat_id(value: str) -> str:
    return value[2:] if value.startswith("c_") else value


def _load_cookie_values(path: str | None) -> tuple[str | None, str | None, dict[str, str] | None]:
    if not path:
        return None, None, None
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and isinstance(data.get("cookies"), dict):
        data = data["cookies"]
    cookies: dict[str, str] = {}
    if isinstance(data, dict):
        cookies = {str(key): str(value) for key, value in data.items() if isinstance(value, str)}
    elif isinstance(data, list):
        for item in data:
            if isinstance(item, dict) and isinstance(item.get("name"), str):
                value = item.get("value")
                if isinstance(value, str):
                    cookies[item["name"]] = value
    return (
        cookies.get("__Secure-1PSID"),
        cookies.get("__Secure-1PSIDTS"),
        {k: v for k, v in cookies.items() if k not in {"__Secure-1PSID", "__Secure-1PSIDTS"}}
        or None,
    )


def _image_attachment(image: object) -> AdapterAttachment:
    type_name = type(image).__name__.lower()
    if "generated" in type_name:
        kind = "generated_image"
    elif "web" in type_name:
        kind = "web_image"
    else:
        kind = "image"
    return AdapterAttachment(
        kind=kind,
        label=str(getattr(image, "title", None) or getattr(image, "alt", None) or "Gemini image"),
        url=getattr(image, "url", None),
    )


def _turns_from_history(history: object) -> list[AdapterTurn]:
    turns = list(getattr(history, "turns", []) or [])
    output: list[AdapterTurn] = []
    # gemini_webapi returns newest-first; exporter snapshots use source order.
    for turn in reversed(turns):
        role = "assistant" if getattr(turn, "role", "") == "model" else "user"
        text = str(getattr(turn, "text", "") or "").strip()
        if not text:
            continue
        attachments: list[AdapterAttachment] = []
        model_output = getattr(turn, "model_output", None)
        if model_output is not None:
            images = getattr(model_output, "images", []) or []
            attachments.extend(_image_attachment(image) for image in images)
            attachments.extend(
                AdapterAttachment(
                    kind="generated_video",
                    label=str(getattr(video, "title", None) or "Gemini video"),
                    url=getattr(video, "url", None),
                )
                for video in getattr(model_output, "videos", []) or []
            )
            attachments.extend(
                AdapterAttachment(
                    kind="generated_media",
                    label=str(getattr(media, "title", None) or "Gemini media"),
                    url=getattr(media, "url", None),
                )
                for media in getattr(model_output, "media", []) or []
            )
        output.append(AdapterTurn(role=role, markdown=text, attachments=attachments))
    return output


async def _read_chat(request: AdapterRequest) -> AdapterSuccess | AdapterFailure:
    try:
        from gemini_webapi import GeminiClient, set_log_level
        from gemini_webapi.exceptions import AuthError
    except ModuleNotFoundError as exc:
        return _failure(
            "gemini_webapi_missing",
            f"Dependencia Python gemini_webapi ausente: {exc.name}",
            _strip_private_chat_id(_normalize_private_chat_id(request.chat_id)),
        )

    set_log_level("WARNING")
    private_chat_id = _normalize_private_chat_id(request.chat_id)
    chat_id = _strip_private_chat_id(private_chat_id)
    secure_1psid, secure_1psidts, extra_cookies = _load_cookie_values(request.cookies_json)

    try:
        if secure_1psid:
            client = GeminiClient(
                secure_1psid=secure_1psid,
                secure_1psidts=secure_1psidts or "",
                cookies=extra_cookies,
            )
        else:
            # gemini_webapi[browser] can import cookies from the local browser profile.
            client = GeminiClient()
        await client.init(
            timeout=max(5, request.timeout_ms / 1000),
            auto_close=False,
            auto_refresh=request.auto_refresh,
        )
    except AuthError as exc:
        return _failure("gemini_webapi_auth_failed", str(exc), chat_id)
    except Exception as exc:
        return _failure("gemini_webapi_init_failed", str(exc), chat_id)

    try:
        history = await client.read_chat(private_chat_id, limit=request.limit)
        if not history:
            return _failure(
                "gemini_webapi_empty_history",
                "gemini_webapi nao retornou turnos para este chat.",
                chat_id,
            )
        return AdapterSuccess(
            chat_id=chat_id,
            private_chat_id=private_chat_id,
            title=request.title,
            turns=_turns_from_history(history),
        )
    except Exception as exc:
        return _failure("gemini_webapi_read_failed", str(exc), chat_id)
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
    return _emit(await _read_chat(request))


def main() -> None:
    raise SystemExit(asyncio.run(_main()))


if __name__ == "__main__":
    main()
