"""枚举"运行中的那个 AstrBot"已保存的 LLM / Embedding 提供商。

给 WebUI 设置页的下拉框用。

三条硬规矩：
1. **不硬编码**：这里不出现任何具体的模型名、厂商名或 provider id。
   所有条目都来自运行时的 context，因此每个用户看到的都是他自己
   AstrBot 里保存好的提供商，换台电脑、换个 AstrBot 版本也一样。
2. **不越界**：只读 context，不改 AstrBot 的任何配置。
3. **不脆弱**：单个 provider 解析失败只影响它自己，不会让整张列表变空；
   AstrBot 各版本的 provider 元信息存放位置不同，这里逐个尝试。
"""

from __future__ import annotations

import inspect
from typing import Any

__all__ = ["list_providers", "provider_info"]


async def _call(fn, *args, **kwargs):
    """调用 fn 并兼容 awaitable；任何异常都吞掉返回 None。"""
    try:
        value = fn(*args, **kwargs)
        if inspect.isawaitable(value):
            value = await value
        return value
    except Exception:  # noqa: BLE001 - 枚举提供商时不允许有单个失败冒泡
        return None


def _meta_of(provider: Any) -> Any:
    """取 provider 的元信息对象（不同版本可能是方法、属性或 dict）。"""
    try:
        meta = getattr(provider, "meta", None)
        if callable(meta):
            meta = meta()
        return meta
    except Exception:  # noqa: BLE001
        return None


def _pick(provider: Any, meta: Any, name: str) -> str:
    """按 meta -> provider_config -> 属性的顺序取一个字符串字段。"""
    if meta is not None:
        try:
            value = meta.get(name) if isinstance(meta, dict) else getattr(meta, name, None)
        except Exception:  # noqa: BLE001
            value = None
        if isinstance(value, str) and value.strip():
            return value.strip()

    try:
        config = getattr(provider, "provider_config", None)
    except Exception:  # noqa: BLE001
        config = None
    if isinstance(config, dict):
        value = config.get(name)
        if isinstance(value, str) and value.strip():
            return value.strip()

    try:
        value = getattr(provider, name, None)
    except Exception:  # noqa: BLE001
        value = None
    if isinstance(value, str) and value.strip():
        return value.strip()
    return ""


def provider_info(provider: Any) -> dict[str, str]:
    """把一个 provider 实例压成 {id, model, type}；取不到 id 就返回空 id。"""
    meta = _meta_of(provider)
    info = {"id": "", "model": "", "type": ""}

    info["id"] = _pick(provider, meta, "id")
    if not info["id"]:
        for attr in ("provider_id", "provider"):
            try:
                value = getattr(provider, attr, None)
            except Exception:  # noqa: BLE001
                value = None
            if isinstance(value, str) and value.strip():
                info["id"] = value.strip()
                break

    info["model"] = _pick(provider, meta, "model")
    if not info["model"]:
        getter = getattr(provider, "get_model", None)
        if callable(getter):
            try:
                value = getter()
            except Exception:  # noqa: BLE001
                value = None
            if isinstance(value, str) and value.strip():
                info["model"] = value.strip()

    info["type"] = _pick(provider, meta, "type")
    return info


async def _collect(context: Any, getter_names: tuple[str, ...], attr_names: tuple[str, ...]) -> list[Any]:
    """从 context 拿到 provider 实例列表（兼容同步/异步入口与 manager 属性）。"""
    if context is None:
        return []

    for name in getter_names:
        getter = getattr(context, name, None)
        if not callable(getter):
            continue
        value = await _call(getter)
        if isinstance(value, (list, tuple)):
            return list(value)

    manager = getattr(context, "provider_manager", None)
    if manager is not None:
        for name in attr_names:
            value = getattr(manager, name, None)
            if isinstance(value, (list, tuple)):
                return list(value)
    return []


def _dedupe(items: list[dict[str, str]]) -> list[dict[str, str]]:
    """按 id 去重（保留先出现的），丢掉没有 id 的条目。"""
    seen: set[str] = set()
    out: list[dict[str, str]] = []
    for item in items:
        pid = item.get("id") or ""
        if not pid or pid in seen:
            continue
        seen.add(pid)
        out.append(item)
    return out


async def _default_id(context: Any, getter_names: tuple[str, ...]) -> str:
    """当前 AstrBot 实际在用的那个 provider 的 id（界面上标"当前默认"）。"""
    if context is None:
        return ""
    for name in getter_names:
        getter = getattr(context, name, None)
        if not callable(getter):
            continue
        provider = await _call(getter)
        if provider is None:
            continue
        info = provider_info(provider)
        if info.get("id"):
            return info["id"]
    return ""


async def list_providers(context: Any) -> dict[str, Any]:
    """返回 {"llm": [...], "embedding": [...], "default_llm": id, "default_embedding": id}。

    每个条目形如 {"id": ..., "model": ..., "type": ...}。
    """
    llm_raw = await _collect(context, ("get_all_providers",), ("provider_insts",))
    embedding_raw = await _collect(
        context, ("get_all_embedding_providers",), ("embedding_provider_insts",)
    )

    llm = _dedupe([provider_info(p) for p in llm_raw])
    embedding = _dedupe([provider_info(p) for p in embedding_raw])

    default_llm = await _default_id(context, ("get_using_provider", "get_using_provider_async"))
    if not default_llm and llm:
        # AstrBot 自己找不到默认时的兜底顺序也是第一个
        default_llm = llm[0]["id"]

    # AstrBot 没有"当前 embedding 默认"的概念，这里沿用插件的兜底：第一个可用的
    default_embedding = embedding[0]["id"] if embedding else ""

    return {
        "llm": llm,
        "embedding": embedding,
        "default_llm": default_llm,
        "default_embedding": default_embedding,
    }
