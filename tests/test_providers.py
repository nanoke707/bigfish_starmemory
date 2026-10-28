"""提供商枚举的单元测试（不依赖 AstrBot 运行时，仅标准库）。

关注点：
- 各版本 AstrBot 里 provider 元信息存放位置不同，都要能读出 id / model；
- 单个 provider 出错不能拖垮整张列表；
- 结果必须完全来自运行中的 context（不硬编码任何模型名）。

运行：python -m pytest tests/ -q
"""

from __future__ import annotations

import asyncio
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from core import providers as provider_enum


# ---------------------------------------------------------------------------
# 各种 provider 形态的仿生体
# ---------------------------------------------------------------------------


@dataclass
class FakeProviderMeta:
    """仿 AstrBot 的 ProviderMeta（dataclass，不是 dict）。"""

    id: str
    model: str | None = None
    type: str = "openai_chat_completion"
    provider_type: str = "chat_completion"


class AstrBotLikeProvider:
    """仿 AstrBot 的 AbstractProvider：id 只存在于 provider_config 与 meta() 里。"""

    def __init__(self, provider_config: dict, model: str = ""):
        self.provider_config = provider_config
        self._model = model

    def get_model(self) -> str:
        return self._model

    def meta(self) -> FakeProviderMeta:
        return FakeProviderMeta(
            id=self.provider_config.get("id", "default"),
            model=self.get_model(),
            type=self.provider_config.get("type", "openai_chat_completion"),
        )


class LegacyProvider:
    """老风格：id 直接挂在实例属性上。"""

    def __init__(self, pid: str, model: str = ""):
        self.id = pid
        self.model = model


class DictMetaProvider:
    """meta 是 dict 属性而不是方法。"""

    def __init__(self, pid: str, model: str = ""):
        self.meta = {"id": pid, "model": model, "type": "ollama"}


class BrokenMetaProvider:
    """meta() 直接抛异常：不能影响其它条目。"""

    def meta(self):
        raise ValueError("Provider type not registered")


class FakeContext:
    def __init__(self, llm=None, embedding=None, default=None):
        self._llm = llm or []
        self._embedding = embedding or []
        self._default = default

    def get_all_providers(self):
        return list(self._llm)

    def get_all_embedding_providers(self):
        return list(self._embedding)

    def get_using_provider(self):
        return self._default


class AsyncContext:
    """异步入口的 context。"""

    def __init__(self, llm=None, embedding=None, default=None):
        self._llm = llm or []
        self._embedding = embedding or []
        self._default = default

    async def get_all_providers(self):
        return list(self._llm)

    async def get_all_embedding_providers(self):
        return list(self._embedding)

    async def get_using_provider_async(self):
        return self._default


class ManagerContext:
    """没有 get_all_*、只有 provider_manager 的 context。"""

    def __init__(self, llm=None, embedding=None):
        self.provider_manager = type(
            "PM", (), {"provider_insts": llm or [], "embedding_provider_insts": embedding or []}
        )()


# ---------------------------------------------------------------------------
# 用例
# ---------------------------------------------------------------------------


def run(coro):
    return asyncio.run(coro)


def test_reads_id_from_meta_dataclass():
    """AstrBot 现状：id 在 meta() 返回的 dataclass 里。"""
    p = AstrBotLikeProvider({"id": "vendor/model-x"}, model="model-x")
    ctx = FakeContext(llm=[p])
    out = run(provider_enum.list_providers(ctx))
    assert out["llm"] == [
        {"id": "vendor/model-x", "model": "model-x", "type": "openai_chat_completion"}
    ]


def test_reads_id_from_provider_config_only():
    """没有 meta() 时退回 provider_config。"""

    class OnlyConfig:
        def __init__(self):
            self.provider_config = {"id": "cfg-only", "model": "m"}

    out = run(provider_enum.list_providers(FakeContext(llm=[OnlyConfig()])))
    assert out["llm"][0]["id"] == "cfg-only"
    assert out["llm"][0]["model"] == "m"


def test_reads_legacy_attribute():
    out = run(provider_enum.list_providers(FakeContext(llm=[LegacyProvider("old-style", "m2")])))
    assert out["llm"][0]["id"] == "old-style"


def test_reads_dict_meta_property():
    out = run(provider_enum.list_providers(FakeContext(llm=[DictMetaProvider("dict-meta", "m3")])))
    assert out["llm"][0]["id"] == "dict-meta"
    assert out["llm"][0]["type"] == "ollama"


def test_broken_provider_does_not_break_list():
    good = AstrBotLikeProvider({"id": "good-one"}, model="g")
    out = run(provider_enum.list_providers(FakeContext(llm=[BrokenMetaProvider(), good])))
    assert [item["id"] for item in out["llm"]] == ["good-one"]


def test_dedupe_by_id_keeps_first():
    a = AstrBotLikeProvider({"id": "dup"}, model="first")
    b = AstrBotLikeProvider({"id": "dup"}, model="second")
    out = run(provider_enum.list_providers(FakeContext(llm=[a, b])))
    assert len(out["llm"]) == 1
    assert out["llm"][0]["model"] == "first"


def test_entries_without_id_are_dropped():
    class NoId:
        provider_config = {}

    out = run(provider_enum.list_providers(FakeContext(llm=[NoId()])))
    assert out["llm"] == []


def test_async_context_supported():
    p = AstrBotLikeProvider({"id": "async-one"}, model="a")
    out = run(provider_enum.list_providers(AsyncContext(llm=[p])))
    assert out["llm"][0]["id"] == "async-one"


def test_provider_manager_fallback():
    p = AstrBotLikeProvider({"id": "via-manager"}, model="m")
    out = run(provider_enum.list_providers(ManagerContext(llm=[p])))
    assert out["llm"][0]["id"] == "via-manager"


def test_embedding_providers_listed_separately():
    emb = AstrBotLikeProvider({"id": "emb-1", "type": "openai_embedding"}, model="e")
    llm = AstrBotLikeProvider({"id": "llm-1"}, model="l")
    out = run(provider_enum.list_providers(FakeContext(llm=[llm], embedding=[emb])))
    assert out["llm"][0]["id"] == "llm-1"
    assert out["embedding"][0]["id"] == "emb-1"


def test_default_provider_is_marked():
    a = AstrBotLikeProvider({"id": "a"}, model="a")
    b = AstrBotLikeProvider({"id": "b"}, model="b")
    out = run(provider_enum.list_providers(FakeContext(llm=[a, b], default=b)))
    assert out["default_llm"] == "b"


def test_default_falls_back_to_first():
    a = AstrBotLikeProvider({"id": "a"}, model="a")
    out = run(provider_enum.list_providers(FakeContext(llm=[a])))
    assert out["default_llm"] == "a"


def test_empty_context_is_safe():
    out = run(provider_enum.list_providers(FakeContext()))
    assert out["llm"] == []
    assert out["embedding"] == []
    assert out["default_llm"] == ""
    assert out["default_embedding"] == ""


def test_none_context_is_safe():
    out = run(provider_enum.list_providers(None))
    assert out["llm"] == []


def test_payload_shape_matches_webui_expectation():
    """前端 app.js 依赖的字段名不能变。"""
    out = run(provider_enum.list_providers(FakeContext()))
    assert set(out.keys()) == {"llm", "embedding", "default_llm", "default_embedding"}
    assert isinstance(out["llm"], list)
    assert isinstance(out["embedding"], list)


def test_ids_come_only_from_context():
    """枚举结果必须完全来自 context，不得混入任何硬编码 id。"""
    ctx = FakeContext(llm=[AstrBotLikeProvider({"id": "only-this-one"}, model="m")])
    out = run(provider_enum.list_providers(ctx))
    assert [item["id"] for item in out["llm"]] == ["only-this-one"]
    # 模块源码里不应出现具体厂商/模型字面量
    source = Path(provider_enum.__file__).read_text(encoding="utf-8")
    for literal in ("deepseek", "openai", "minimax", "gemini", "claude", "gpt-"):
        assert literal not in source.lower(), f"providers.py 不应硬编码 {literal}"


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
