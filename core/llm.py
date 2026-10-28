"""LLM 客户端：对 AstrBot Provider 的兼容适配。

AstrBot 不同版本的 Provider 获取接口有差异（同步/异步、ID 查找/默认查找），
这里统一做鸭子类型 + awaitable 探测，保证在多个 AstrBot 版本上都能工作：
优先使用配置里指定的 provider_id，找不到再回落到当前默认 Provider。
"""

from __future__ import annotations

import asyncio
import inspect
import random
from typing import Any

try:  # AstrBot 运行时
    from astrbot.api import logger
except Exception:  # 独立测试环境
    import logging

    logger = logging.getLogger("bigfish_starmemory")


async def _maybe_await(value: Any) -> Any:
    """如果对象是 awaitable 就等待它，否则原样返回。"""
    if inspect.isawaitable(value):
        return await value
    return value


async def resolve_llm_provider(context: Any, provider_id: str = "") -> Any:
    """按 配置ID -> 默认Provider 的顺序解析可用的 LLM Provider。"""
    # 1) 配置指定的 provider id
    if provider_id:
        getter = getattr(context, "get_provider_by_id", None)
        if callable(getter):
            try:
                provider = await _maybe_await(getter(provider_id))
                if provider:
                    return provider
            except Exception as exc:
                logger.debug(f"[StarMemory] 按 ID 获取 Provider 失败: {exc}")
        manager = getattr(context, "provider_manager", None)
        getter = getattr(manager, "get_provider_by_id", None)
        if callable(getter):
            try:
                provider = await _maybe_await(getter(provider_id))
                if provider:
                    return provider
            except Exception as exc:
                logger.debug(f"[StarMemory] 经 provider_manager 按 ID 获取失败: {exc}")

    # 2) 当前默认 Provider（异步接口优先）
    for name in ("get_using_provider_async", "get_using_provider"):
        getter = getattr(context, name, None)
        if callable(getter):
            try:
                provider = await _maybe_await(getter())
                if provider:
                    return provider
            except Exception as exc:
                logger.debug(f"[StarMemory] {name} 获取 Provider 失败: {exc}")

    manager = getattr(context, "provider_manager", None)
    for name in ("get_using_provider",):
        getter = getattr(manager, name, None)
        if callable(getter):
            try:
                provider = await _maybe_await(getter())
                if provider:
                    return provider
            except Exception as exc:
                logger.debug(f"[StarMemory] provider_manager.{name} 失败: {exc}")
    return None


class LLMClient:
    """带重试的对话补全封装。"""

    def __init__(self, context: Any, provider_id: str = "", max_retries: int = 3):
        self.context = context
        self.provider_id = (provider_id or "").strip()
        self.max_retries = max(1, int(max_retries))

    async def _provider(self) -> Any:
        return await resolve_llm_provider(self.context, self.provider_id)

    async def chat(self, system_prompt: str, user_prompt: str) -> str:
        """调用当前 Provider 生成补全文本；失败时指数退避重试。

        Raises:
            RuntimeError: Provider 不可用或重试耗尽。
        """
        last_error: Exception | None = None
        for attempt in range(self.max_retries):
            provider = await self._provider()
            if provider is None:
                raise RuntimeError("没有可用的 LLM Provider（请先在 AstrBot 中配置并启用）")
            try:
                response = await provider.text_chat(
                    prompt=user_prompt,
                    system_prompt=system_prompt,
                )
                text = getattr(response, "completion_text", "") or ""
                if text.strip():
                    return text
                raise RuntimeError("LLM 返回了空内容")
            except Exception as exc:
                last_error = exc
                if attempt < self.max_retries - 1:
                    wait = (2 ** attempt) + random.uniform(0.2, 1.0)
                    logger.warning(
                        f"[StarMemory] LLM 调用失败（{attempt + 1}/{self.max_retries}），"
                        f"{wait:.1f}s 后重试: {exc}"
                    )
                    await asyncio.sleep(wait)
        raise RuntimeError(f"LLM 调用失败: {last_error}")

    async def available(self) -> bool:
        try:
            return await self._provider() is not None
        except Exception:
            return False
