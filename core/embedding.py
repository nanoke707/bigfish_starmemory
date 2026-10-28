"""向量服务：AstrBot Embedding Provider 适配 + 纯本地降级。

向量不可用（未配置 Embedding Provider、接口异常、维度不稳定）时，
检索自动降级为 CJK bigram 关键词打分——星星不会因为缺一只望远镜
就从夜空里消失。
"""

from __future__ import annotations

import asyncio
import inspect
from typing import Any

try:  # AstrBot 运行时
    from astrbot.api import logger
except Exception:  # 独立测试环境
    import logging

    logger = logging.getLogger("bigfish_starmemory")


async def _maybe_await(value: Any) -> Any:
    if inspect.isawaitable(value):
        return await value
    return value


class EmbeddingService:
    """按需获取向量；任何异常都优雅降级（返回 None）。"""

    def __init__(self, context: Any, provider_id: str = ""):
        self.context = context
        self.provider_id = (provider_id or "").strip()
        self._provider: Any = None
        self._resolved = False
        self._dim: int | None = None
        self._failed_once = False

    async def _resolve(self) -> Any:
        if self._resolved:
            return self._provider
        self._resolved = True
        context = self.context
        if context is None:
            return None

        # 1) 配置指定的 Embedding Provider ID
        if self.provider_id:
            for getter_name in ("get_embedding_provider_by_id", "get_provider_by_id"):
                getter = getattr(context, getter_name, None)
                if callable(getter):
                    try:
                        provider = await _maybe_await(getter(self.provider_id))
                        if provider:
                            self._provider = provider
                            return provider
                    except Exception as exc:
                        logger.debug(f"[StarMemory] {getter_name}({self.provider_id}) 失败: {exc}")

        # 2) 第一个可用的 Embedding Provider
        getter = getattr(context, "get_all_embedding_providers", None)
        if callable(getter):
            try:
                providers = await _maybe_await(getter())
                if providers:
                    if isinstance(providers, dict):
                        providers = list(providers.values())
                    self._provider = next((p for p in providers if p), None)
                    if self._provider:
                        logger.info("[StarMemory] 未指定向量模型，已自动选用第一个可用的 Embedding Provider")
            except Exception as exc:
                logger.debug(f"[StarMemory] 列举 Embedding Provider 失败: {exc}")
        return self._provider

    def invalidate(self) -> None:
        """清除已解析的 Provider 缓存（配置切换后由插件层调用）。"""
        self._provider = None

    async def available(self) -> bool:
        provider = await self._resolve()
        return provider is not None

    async def embed(self, texts: list[str]) -> list[list[float]] | None:
        """批量向量化；不可用或失败时返回 None（调用方降级为关键词）。"""
        texts = [t for t in texts if t and t.strip()]
        if not texts:
            return None
        provider = await self._resolve()
        if provider is None:
            return None
        try:
            vectors = await self._embed_via(provider, texts)
        except Exception as exc:
            if not self._failed_once:
                self._failed_once = True
                logger.warning(f"[StarMemory] 向量化失败，本次检索将退回关键词匹配: {exc}")
            return None
        if not vectors or len(vectors) != len(texts):
            return None
        cleaned: list[list[float]] = []
        for vec in vectors:
            if not isinstance(vec, (list, tuple)) or not vec:
                return None
            # 维度不稳定说明后端换了模型，放弃本轮向量结果
            if self._dim is None:
                self._dim = len(vec)
            elif len(vec) != self._dim:
                logger.warning("[StarMemory] 向量维度发生变化，本轮放弃向量结果")
                return None
            cleaned.append([float(x) for x in vec])
        return cleaned

    @staticmethod
    async def _embed_via(provider: Any, texts: list[str]) -> list[list[float]] | None:
        # 优先批量接口
        batch = getattr(provider, "get_embeddings", None)
        if callable(batch):
            result = await _maybe_await(batch(texts))
            if isinstance(result, (list, tuple)):
                return list(result)
        single = getattr(provider, "get_embedding", None)
        if callable(single):
            vectors: list[list[float]] = []
            for text in texts:
                vec = await _maybe_await(single(text))
                if vec is None:
                    return None
                vectors.append(list(vec))
            return vectors
        return None
