"""bigfish_starmemory 核心单元测试（不依赖 AstrBot，仅标准库）。

运行：python -m pytest tests/ -q
"""

from __future__ import annotations

import os
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from core import ebbinghaus, formatting, mood as mood_engine, text, emotion as emotion_engine, timeline
from core.config import StarConfig
from core.ebbinghaus import EbbinghausParams
from core.embedding import EmbeddingService
from core.engine import StarMemoryEngine
from core.llm import LLMClient
from core.models import CLARITY_CLEAR, CLARITY_VAGUE, MemoryStatus, Mood, ScoredStar, Star
from core.storage import StarStore
from core.text import parse_lenient_json


# ---------------------------------------------------------------------------
# 沙箱友好的临时目录（优先系统临时目录，被拒时回退到仓库根目录）
# ---------------------------------------------------------------------------


def scratch_dir() -> "Path":
    import sqlite3
    import uuid
    for base in (tempfile.gettempdir(), Path(__file__).resolve().parents[1]):
        d = Path(base) / f"bsm_test_{uuid.uuid4().hex[:8]}"
        try:
            d.mkdir(parents=True, exist_ok=True)
            probe = d / "probe.db"
            conn = sqlite3.connect(probe)
            conn.execute("CREATE TABLE t(a)")
            conn.commit()
            conn.close()
            probe.unlink()
            return d
        except Exception:
            continue
    raise RuntimeError("找不到可写的临时目录")


def cleanup_dir(d: "Path") -> None:
    import shutil
    shutil.rmtree(d, ignore_errors=True)


# ---------------------------------------------------------------------------
# 文本工具
# ---------------------------------------------------------------------------


class TestText:
    def test_content_hash_stable(self):
        assert text.content_hash("你好，世界！") == text.content_hash("你好 世界")
        assert text.content_hash("a") != text.content_hash("b")

    def test_tokenize_cjk_bigram(self):
        tokens = text.tokenize("橘猫馒头")
        assert "橘" in tokens and "橘猫" in tokens and "馒头" in tokens

    def test_keyword_score_prefers_tags(self):
        score = text.keyword_score("小黑的生日", "小黑的生日是三月五日", ["生日", "小黑"])
        assert score > 0.5

    def test_keyword_score_followup_paraphrase(self):
        """换说法的追问（那只猫 vs 小奶猫）也应通过标签单字锚点召回。"""
        score = text.keyword_score(
            "对了，那只猫后来怎么样了？",
            "小明捡到了一只小奶猫，取名馒头",
            ["小明", "小猫", "馒头"],
        )
        assert score >= 0.15, f"score={score}"

    def test_keyword_score_stopwords_do_not_leak(self):
        """纯虚词查询不应因为共享停用字而召回。"""
        score = text.keyword_score(
            "好的呢", "小黑养了只橘猫叫馒头", ["小黑", "馒头"]
        )
        assert score < 0.2, f"score={score}"

    def test_cosine(self):
        assert abs(text.cosine([1, 0], [1, 0]) - 1.0) < 1e-9
        assert text.cosine([1, 0], [0, 1]) == 0.0
        assert text.cosine(None, [1]) == 0.0

    def test_parse_lenient_json(self):
        assert parse_lenient_json('{"a": 1}') == {"a": 1}
        assert parse_lenient_json('```json\n{"a": 1,}\n```') == {"a": 1}
        assert parse_lenient_json('前置说明 {"a": {"b": [1,2]}} 后置说明') == {"a": {"b": [1, 2]}}
        assert parse_lenient_json("完全不是 JSON") is None

    def test_as_tag_list(self):
        assert text.as_tag_list(["小黑", " 生日 ", "", "小黑"]) == ["小黑", "生日"]
        assert text.as_tag_list("小黑,生日、礼物") == ["小黑", "生日", "礼物"]


# ---------------------------------------------------------------------------
# 艾宾浩斯遗忘曲线
# ---------------------------------------------------------------------------


class TestEbbinghaus:
    PARAMS = EbbinghausParams()

    @staticmethod
    def _star(**kw) -> Star:
        now = time.time()
        base = dict(
            id=1, scope="s", content="测试记忆", stability=1.2, last_review=now,
            created_at=now, importance=0.5, valence=0.0, arousal=0.35,
        )
        base.update(kw)
        return Star(**base)

    def test_retention_decays_over_time(self):
        now = time.time()
        star = self._star()
        r_now = ebbinghaus.retention(star, now, self.PARAMS)
        r_later = ebbinghaus.retention(star, now + 3 * 86400, self.PARAMS)
        assert 0.99 < r_now <= 1.0
        assert r_later < r_now

    def test_emotion_strengthens_memory_at_write_time(self):
        """情绪影响的是**写入时的半衰期**，不再是读取时的乘子。"""
        calm_h = ebbinghaus.half_life_for_new_memory(0.5, 0.0, self.PARAMS)
        intense_h = ebbinghaus.half_life_for_new_memory(0.5, 0.9, self.PARAMS)
        assert intense_h > calm_h

    def test_importance_raises_half_life(self):
        important_h = ebbinghaus.half_life_for_new_memory(0.9, 0.0, self.PARAMS)
        trivial_h = ebbinghaus.half_life_for_new_memory(0.1, 0.0, self.PARAMS)
        assert important_h > trivial_h

    def test_retention_uses_event_time_anchor(self):
        """事件发生时间作为遗忘锚点：上周发生的事，今天保留率应已衰减。"""
        now = time.time()
        star = self._star(half_life_days=7.0, last_reinforced_at=0.0,
                          event_time=now - 7 * 86400, created_at=now)
        r = ebbinghaus.retention(star, now, self.PARAMS)
        assert abs(r - 0.5) < 0.01, f"R={r}"

    def test_review_reinforces(self):
        now = time.time()
        star = self._star()
        s1 = ebbinghaus.reinforcement(star, now + 2 * 86400, self.PARAMS)
        assert s1 > star.stability
        # 间隔越久（未超 7 天），巩固越多
        s2 = ebbinghaus.reinforcement(star, now + 6 * 86400, self.PARAMS)
        assert s2 > s1

    def test_pinned_star_never_fully_fades(self):
        now = time.time()
        pinned = self._star(pinned=True, stability=0.05)
        pinned.last_reinforced_at = now - 100 * 86400
        assert ebbinghaus.retention(pinned, now, self.PARAMS) >= 0.5

    def test_maintenance_lifecycle(self):
        now = time.time()
        # 新鲜星星保持 active
        fresh = self._star(last_reinforced_at=now, created_at=now)
        status, _ = ebbinghaus.maintenance_update(fresh, now + 0.2 * 86400, self.PARAMS)
        assert status == MemoryStatus.ACTIVE.value
        # 很久没有强化的普通星星（半衰期 7 天，35 天前）-> 熄灭归档
        old = self._star(last_reinforced_at=now - 35 * 86400, created_at=now - 35 * 86400,
                         half_life_days=7.0)
        status, _ = ebbinghaus.maintenance_update(old, now, self.PARAMS)
        assert status == MemoryStatus.ARCHIVED.value
        # 珍藏星永远 active
        old_pinned = self._star(last_reinforced_at=now - 35 * 86400, pinned=True,
                                half_life_days=7.0)
        status, _ = ebbinghaus.maintenance_update(old_pinned, now, self.PARAMS)
        assert status == MemoryStatus.ACTIVE.value

    def test_happy_mood_fades_negative_mundane_faster(self):
        now = time.time()
        star = self._star(valence=-0.5, importance=0.2, stability=5.0)
        neutral = ebbinghaus.maintenance_update(star, now, self.PARAMS, mood=Mood(valence=0.0))
        happy = ebbinghaus.maintenance_update(star, now, self.PARAMS, mood=Mood(valence=0.8))
        assert happy[1] < neutral[1]  # 心情好时负面琐碎折旧更快

    def test_visibility_glimmer(self):
        now = time.time()
        faded = self._star(last_reinforced_at=now - 20 * 86400, created_at=now - 20 * 86400,
                           status=MemoryStatus.FADED.value)
        # 关闭灵光时，暗星可见度应明显低于 1
        mult_no_glimmer, glimmer = ebbinghaus.visibility(
            faded, now, EbbinghausParams(glimmer_chance=0.0), rng=lambda: 0.99
        )
        assert not glimmer
        assert mult_no_glimmer < 0.8


# ---------------------------------------------------------------------------
# 星云心绪
# ---------------------------------------------------------------------------


class TestMood:
    def test_decay_returns_to_baseline(self):
        excited = Mood(valence=0.8, arousal=0.9, affection=0.8)
        later = mood_engine.decay(excited, now=excited.updated_at + 48 * 3600)
        assert later.valence < excited.valence
        assert later.affection > Mood().affection  # 好感衰减很慢

    def test_apply_deltas_clamped(self):
        mood = Mood()
        new = mood_engine.apply_deltas(mood, {"valence": 5.0, "arousal": -9, "affection": 1})
        assert new.valence <= 0.45
        assert new.arousal >= 0.2 - 0.4 - 1e-9
        assert new.affection <= 0.4 + 0.15 + 1e-9

    def test_resonate_pulls_toward_memory(self):
        mood = Mood()
        star = Star(id=1, scope="s", content="开心的事", valence=0.9, arousal=0.6, importance=0.8)
        after = mood_engine.resonate(mood, [ScoredStar(star=star, retention=0.9)], strength=0.3)
        assert after.valence > mood.valence

    def test_describe(self):
        text_desc = mood_engine.describe(Mood(valence=0.8, arousal=0.9, affection=0.7))
        assert "开心" in text_desc or "很好" in text_desc


# ---------------------------------------------------------------------------
# 存储层
# ---------------------------------------------------------------------------


async def _store_roundtrip_flow():
    tmp = scratch_dir()
    store = StarStore(str(tmp / "t.db"))
    await store.initialize()
    try:
        now = time.time()
        star = Star(id=0, scope="s1", content="小黑养了只橘猫叫馒头",
                    tags=["小黑", "馒头"], importance=0.7, valence=0.3,
                    last_review=now, created_at=now)
        sid = await store.add_star(star, embedding=[0.1, 0.2, 0.3])
        assert sid
        # 同 scope 精确去重
        dup = Star(id=0, scope="s1", content="小黑养了只橘猫叫馒头", last_review=now, created_at=now)
        assert await store.add_star(dup) is None

        got = await store.get_star(sid, "s1")
        assert got is not None
        assert got.tags == ["小黑", "馒头"]
        assert got.embedding is not None and len(got.embedding) == 3

        stars = await store.scope_stars("s1")
        assert len(stars) == 1

        await store.update_star(sid, "s1", stability=9.9, pinned=True)
        got = await store.get_star(sid, "s1")
        assert got.stability == 9.9 and got.pinned

        # 心绪
        await store.set_mood("s1", Mood(valence=0.5, arousal=0.6, affection=0.7))
        mood = await store.get_mood("s1")
        assert mood.valence == 0.5

        # 星尘
        await store.add_stardust("s1", "路人", "今天天气不错")
        dust = await store.take_stardust("s1")
        assert len(dust) == 1 and dust[0]["sender"] == "路人"
        assert await store.take_stardust("s1") == []

        # scopes
        assert "s1" in await store.scopes()

        # 清理与统计
        stats = await store.scope_stats("s1")
        assert stats["total"] == 1 and stats["pinned"] == 1
    finally:
        await store.close()
        cleanup_dir(tmp)


def test_store_roundtrip():
    import asyncio

    asyncio.run(_store_roundtrip_flow())


# ---------------------------------------------------------------------------
# 引擎（伪造 LLM / 向量）
# ---------------------------------------------------------------------------


class FakeLLM(LLMClient):
    """固定输出的假 LLM。"""

    def __init__(self, payload: str):
        super().__init__(context=None)
        self.payload = payload
        self.calls = 0

    async def chat(self, system_prompt: str, user_prompt: str) -> str:
        self.calls += 1
        return self.payload


class NullEmbedder(EmbeddingService):
    """永远不可用的向量服务（走关键词降级）。"""

    def __init__(self):
        super().__init__(context=None)

    async def embed(self, texts):
        return None

    async def available(self):
        return False


def make_engine(payload: str, cfg: dict | None = None) -> StarMemoryEngine:
    config = StarConfig({"general": {"enabled": True}, **(cfg or {})})
    params = EbbinghausParams()
    return StarMemoryEngine(
        config, StarStore(":memory:"), FakeLLM(payload), NullEmbedder(), params
    )


async def _consolidate_flow(payload: str, transcript: list[str], tmpdir: str):
    engine = make_engine(payload)
    engine.store = StarStore(os.path.join(tmpdir, "t.db"))
    await engine.store.initialize()
    try:
        return engine, await engine.consolidate("s1", transcript)
    finally:
        await engine.store.close()


def test_consolidate_saves_stars_and_mood():
    import asyncio

    payload = (
        '{"memories": [{"content": "小黑养的橘猫叫馒头", "tags": ["小黑","馒头"],'
        ' "type": "fact", "importance": 0.8, "valence": 0.4, "arousal": 0.3, "pinned": false}],'
        ' "mood_delta": {"valence": 0.2, "arousal": 0.1, "affection": 0.05},'
        ' "mood_reason": "聊到猫很开心", "used_memory_ids": []}'
    )

    async def run():
        tmp = scratch_dir()
        e = make_engine(payload)
        e.store = StarStore(str(tmp / "t.db"))
        await e.store.initialize()
        try:
            outcome = await e.consolidate(
                "s1", ["[10-01 10:00] 小黑：我家猫叫馒头", "[10-01 10:00] Bot：好可爱的名字"]
            )
            stars = await e.store.scope_stars("s1")
            mood = await e.store.get_mood("s1")
        finally:
            await e.store.close()
            cleanup_dir(tmp)
        return outcome, stars, mood

    outcome, stars, mood = asyncio.run(run())
    assert len(outcome.added) == 1
    assert outcome.mood_changed
    assert stars[0].content == "小黑养的橘猫叫馒头"
    assert stars[0].half_life_days > 0
    assert mood.valence == pytest.approx(0.2)


def test_consolidate_skips_garbage():
    import asyncio

    async def run():
        tmp = scratch_dir()
        e = make_engine("这不是 JSON")
        e.store = StarStore(str(tmp / "t.db"))
        await e.store.initialize()
        try:
            return await e.consolidate("s1", ["[10-01 10:00] 小黑：你好呀，今天好累啊"])
        finally:
            await e.store.close()
            cleanup_dir(tmp)

    outcome = asyncio.run(run())
    assert outcome.skipped and not outcome.added


def test_recall_does_not_reinforce_by_default():
    """铁律：检索 ≠ 强化。"""
    import asyncio

    async def run():
        tmp = scratch_dir()
        e = make_engine('{"memories": [], "mood_delta": {}, "used_memory_ids": []}')
        e.store = StarStore(str(tmp / "t.db"))
        await e.store.initialize()
        try:
            now = time.time()
            star = Star(id=0, scope="s1", content="小黑的生日是三月五日",
                        tags=["小黑", "生日"], importance=0.9,
                        half_life_days=30.0,
                        last_reinforced_at=now - 10 * 86400, created_at=now)
            sid = await e.store.add_star(star)
            outcome = await e.recall("s1", "小黑生日是什么时候")
            after = await e.store.get_star(sid, "s1")
            # 显式强化一次（真正被想起）
            await e.reinforce_ids("s1", [sid])
            reinforced = await e.store.get_star(sid, "s1")
            return outcome, star, after, reinforced
        finally:
            await e.store.close()
            cleanup_dir(tmp)

    outcome, star, after, reinforced = asyncio.run(run())
    assert len(outcome.scored) == 1
    # 检索只加计数器，不改遗忘状态
    assert after.recall_count == 1
    assert after.review_count == 0
    assert abs(after.half_life_days - star.half_life_days) < 1e-9
    assert abs(after.last_reinforced_at - star.last_reinforced_at) < 1e-9
    # 真正被想起才强化
    assert reinforced.review_count == 1
    assert reinforced.half_life_days > star.half_life_days
    assert reinforced.last_reinforced_at > star.last_reinforced_at


# ---------------------------------------------------------------------------
# 格式化
# ---------------------------------------------------------------------------


class TestFormatting:
    def test_injection_block(self):
        star = Star(id=7, scope="s", content="小黑喜欢在雨天听歌", importance=0.6)
        scored = ScoredStar(star=star, retention=0.8, clarity=CLARITY_CLEAR)
        block = formatting.format_injection([scored], "心情不错，有点开心", include_mood=True)
        assert "星空记忆" in block and "小黑喜欢在雨天听歌" in block and "此刻心绪" in block
        assert "不要罗列" in block

    def test_injection_marks_vague_details(self):
        """模糊细节必须标注"不太确定"，不可靠细节完全不出现。"""
        star = Star(id=8, scope="s", content="小黑获得过老师的奖励",
                    event_time=time.time() - 86400)
        scored = ScoredStar(
            star=star, retention=0.9, clarity=CLARITY_CLEAR,
            detail_states=[
                {"id": 1, "text": "奖励是一根棒棒糖", "clarity": CLARITY_CLEAR,
                 "retention": 0.9, "half_life_days": 3},
                {"id": 2, "text": "口味是草莓", "clarity": CLARITY_VAGUE,
                 "retention": 0.3, "half_life_days": 3},
                {"id": 3, "text": "老师说的原话", "clarity": "unknown",
                 "retention": 0.05, "half_life_days": 3},
            ],
        )
        line = formatting.format_star_line(scored)
        assert "奖励是一根棒棒糖" in line
        assert "口味是草莓" in line and "不太确定" in line
        assert "老师说的原话" not in line

    def test_unknown_star_not_injected(self):
        """无法可靠回忆的星星不注入。"""
        star = Star(id=9, scope="s", content="很久以前的某件事")
        scored = ScoredStar(star=star, retention=0.02, clarity="unknown")
        assert formatting.format_star_line(scored) == ""

    def test_injection_char_budget(self):
        stars = [
            ScoredStar(star=Star(id=i, scope="s", content="内容" * 30), retention=0.9,
                       clarity=CLARITY_CLEAR)
            for i in range(20)
        ]
        block = formatting.format_injection(stars, "", include_mood=False, max_chars=400)
        assert len(block) <= 400 + 400  # 允许单个星星块的少量溢出

    def test_mood_banner(self):
        banner = formatting.mood_banner(Mood(valence=0.5, arousal=0.5, affection=0.5))
        assert "愉悦" in banner and "好感" in banner
