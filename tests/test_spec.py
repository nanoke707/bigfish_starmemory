"""bigfish_starmemory 核心机制测试（规范 A~G）。

覆盖：
  A. 艾宾浩斯遗忘曲线（半衰期 7 天 -> 1.0 / 0.5 / 0.25 / 0.125）
  B. 情绪半衰期（强度 0.8、半衰期 2 天 -> 0.8 / 0.4 / 0.2 / 0.1）
  C. 两套曲线独立性（记忆 30 天 vs 情绪 2 天）
  D. 事件内部遗忘（主干与细节不同半衰期）
  E. 重新激活（相似情境可唤起，但不自动恢复细节、不等于强化）
  F. 持久化（重开插件后原始事件/时间/情绪/参数不变）
  G. 对话集成（记忆与情绪进入 LLM 上下文构建）

运行：python -m pytest tests/test_spec.py -q
"""

from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import pytest

from core import ebbinghaus, emotion as emotion_engine, formatting, timeline
from core.config import StarConfig
from core.ebbinghaus import EbbinghausParams
from core.embedding import EmbeddingService
from core.engine import StarMemoryEngine
from core.llm import LLMClient
from core.models import (
    CLARITY_CLEAR,
    CLARITY_FAINT,
    CLARITY_UNKNOWN,
    CLARITY_VAGUE,
    Detail,
    EmotionRecord,
    MemoryStatus,
    ScoredStar,
    Star,
)
from core.storage import StarStore

DAY = 86400.0


def scratch_dir() -> Path:
    """可写的临时目录（系统临时目录被拒时回退到仓库根）。"""
    import sqlite3
    import tempfile
    import uuid
    for base in (tempfile.gettempdir(), Path(__file__).resolve().parents[1]):
        d = Path(base) / f"bsm_scratch_{uuid.uuid4().hex[:8]}"
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


def cleanup_dir(d: Path) -> None:
    import shutil
    shutil.rmtree(d, ignore_errors=True)


class FakeLLM(LLMClient):
    def __init__(self, payload: str):
        super().__init__(context=None)
        self.payload = payload
        self.calls = 0
        self.last_system = ""
        self.last_user = ""

    async def chat(self, system_prompt: str, user_prompt: str) -> str:
        self.calls += 1
        self.last_system = system_prompt
        self.last_user = user_prompt
        return self.payload


class NullEmbedder(EmbeddingService):
    def __init__(self):
        super().__init__(context=None)

    async def embed(self, texts):
        return None

    async def available(self):
        return False


def make_engine(payload: str = '{"memories": []}', cfg: dict | None = None) -> StarMemoryEngine:
    config = StarConfig({"general": {"enabled": True}, **(cfg or {})})
    params = EbbinghausParams()
    return StarMemoryEngine(
        config, StarStore(":memory:"), FakeLLM(payload), NullEmbedder(), params
    )


async def fresh_engine(payload: str = '{"memories": []}', cfg: dict | None = None):
    tmp = scratch_dir()
    engine = make_engine(payload, cfg)
    engine.store = StarStore(str(tmp / "t.db"))
    await engine.store.initialize()
    return engine, tmp


# ---------------------------------------------------------------------------
# A. 艾宾浩斯遗忘曲线测试
# ---------------------------------------------------------------------------


class TestAEbbinghaus:
    """A. 记忆半衰期为 7 天时的理论保留程度。"""

    def test_half_life_seven_days(self):
        h = 7.0
        assert ebbinghaus.retention_from_half_life(0, h) == pytest.approx(1.0)
        assert ebbinghaus.retention_from_half_life(7, h) == pytest.approx(0.5)
        assert ebbinghaus.retention_from_half_life(14, h) == pytest.approx(0.25)
        assert ebbinghaus.retention_from_half_life(21, h) == pytest.approx(0.125)

    def test_star_retention_matches_half_life(self):
        """真实代码路径：星星的 R(t) 与半衰期公式一致。"""
        now = time.time()
        params = EbbinghausParams()
        star = Star(
            id=1, scope="s", content="拿到过奖励",
            half_life_days=7.0, last_reinforced_at=now - 7 * DAY,
            created_at=now - 7 * DAY,
        )
        r = ebbinghaus.retention(star, now, params)
        assert r == pytest.approx(0.5, abs=1e-9)

    def test_exp_and_half_life_forms_equivalent(self):
        """R=exp(-t/S) 与 R=2^(-t/H_m) 等价（H_m = S·ln2）。"""
        h = 12.0
        s = ebbinghaus.half_life_to_stability(h)
        assert s == pytest.approx(h / 0.6931471805599453)
        for days in (0, 3, 9, 30):
            by_half = ebbinghaus.retention_from_half_life(days, h)
            import math
            by_exp = math.exp(-days / s)
            assert by_half == pytest.approx(by_exp, abs=1e-12)

    def test_zero_and_negative_time_safe(self):
        assert ebbinghaus.retention_from_half_life(-5, 7.0) == pytest.approx(1.0)
        assert ebbinghaus.retention_from_half_life(5, 0) == 0.0
        assert ebbinghaus.retention_from_half_life(5, -1) == 0.0

    def test_different_memories_have_different_half_lives(self):
        """不允许所有记忆统一固定周期。"""
        params = EbbinghausParams()
        now = time.time()
        a = Star(id=1, scope="s", content="小事", half_life_days=2.0,
                 last_reinforced_at=now, created_at=now)
        b = Star(id=2, scope="s", content="大事", half_life_days=30.0,
                 last_reinforced_at=now, created_at=now)
        later = now + 10 * DAY
        assert ebbinghaus.retention(a, later, params) < ebbinghaus.retention(b, later, params)

    def test_event_time_is_anchor_not_creation_time(self):
        """事件发生时间 ≠ 记录时间：事件时间才是遗忘起点。"""
        now = time.time()
        params = EbbinghausParams()
        star = Star(
            id=1, scope="s", content="上周弄丢了伞",
            half_life_days=7.0,
            event_time=now - 7 * DAY,
            last_reinforced_at=now - 7 * DAY,
            created_at=now,          # 刚刚才写进数据库
        )
        r = ebbinghaus.retention(star, now, params)
        assert r == pytest.approx(0.5, abs=1e-9)

    def test_restart_recomputes_from_persisted_data(self):
        """重启后仅凭持久化数据 + 当前时间即可重算状态。"""
        now = time.time()
        params = EbbinghausParams()
        star = Star(id=1, scope="s", content="x", half_life_days=7.0,
                    last_reinforced_at=now - 7 * DAY, created_at=now - 7 * DAY)
        # 模拟重启：只保留原始记录，不保留任何"当前状态"
        restored = Star.from_row({
            "id": 1, "scope": "s", "content": "x", "half_life_days": 7.0,
            "last_reinforced_at": now - 7 * DAY, "created_at": now - 7 * DAY,
        })
        assert ebbinghaus.retention(restored, now, params) == pytest.approx(0.5, abs=1e-9)


# ---------------------------------------------------------------------------
# B. 情绪半衰期测试
# ---------------------------------------------------------------------------


class TestBEmotionHalfLife:
    """B. 情绪初始强度 0.8、半衰期 2 天 -> 0.8 / 0.4 / 0.2 / 0.1。"""

    def _emo(self, now: float) -> EmotionRecord:
        return EmotionRecord(
            id=1, star_id=1, scope="s", emotion_type="anger",
            direction=-1, intensity=0.8, half_life_days=2.0,
            event_time=now, created_at=now, last_reinforced_at=now,
        )

    def test_emotion_residual_sequence(self):
        now = time.time()
        emo = self._emo(now)
        assert emotion_engine.residual(emo, now) == pytest.approx(0.8)
        assert emotion_engine.residual(emo, now + 2 * DAY) == pytest.approx(0.4)
        assert emotion_engine.residual(emo, now + 4 * DAY) == pytest.approx(0.2)
        assert emotion_engine.residual(emo, now + 6 * DAY) == pytest.approx(0.1)

    def test_signed_residual_keeps_direction(self):
        """原始负向情绪 -0.8，一个半衰期后残留 -0.4。"""
        now = time.time()
        emo = self._emo(now)
        assert emotion_engine.signed_residual(emo, now) == pytest.approx(-0.8)
        assert emotion_engine.signed_residual(emo, now + 2 * DAY) == pytest.approx(-0.4)

    def test_emotion_does_not_touch_memory_state(self):
        """情绪衰减不得修改记忆遗忘状态。"""
        now = time.time()
        params = EbbinghausParams()
        star = Star(id=1, scope="s", content="x", half_life_days=30.0,
                    last_reinforced_at=now, created_at=now)
        emo = self._emo(now)
        r_before = ebbinghaus.retention(star, now, params)
        emotion_engine.residual(emo, now + 100 * DAY)
        r_after = ebbinghaus.retention(star, now + 100 * DAY, params)
        assert r_after == pytest.approx(r_before * 2 ** (-100 / 30))
        assert star.half_life_days == 30.0

    def test_original_intensity_never_overwritten(self):
        """残留衰减不会覆盖原始强度 E0。"""
        now = time.time()
        emo = self._emo(now)
        emotion_engine.residual(emo, now + 30 * DAY)
        assert emo.intensity == 0.8

    def test_zero_and_tiny_values_handled(self):
        now = time.time()
        zero = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="calm",
                             direction=0, intensity=0.0, half_life_days=2.0,
                             created_at=now, last_reinforced_at=now)
        assert emotion_engine.residual(zero, now + DAY) == 0.0
        tiny = EmotionRecord(id=2, star_id=1, scope="s", emotion_type="joy",
                             direction=1, intensity=1e-9, half_life_days=2.0,
                             created_at=now, last_reinforced_at=now)
        assert emotion_engine.residual(tiny, now + DAY) < 1e-9

    def test_different_emotions_have_different_half_lives(self):
        """不同情绪可用不同半衰期。"""
        now = time.time()
        trust = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="trust",
                              direction=1, intensity=0.8, half_life_days=14.0,
                              created_at=now, last_reinforced_at=now)
        fear = EmotionRecord(id=2, star_id=1, scope="s", emotion_type="fear",
                             direction=-1, intensity=0.8, half_life_days=1.5,
                             created_at=now, last_reinforced_at=now)
        later = now + 2 * DAY
        assert emotion_engine.residual(trust, later) > emotion_engine.residual(fear, later)

    def test_multiple_emotions_decay_independently(self):
        now = time.time()
        joy = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="joy",
                             direction=1, intensity=0.6, half_life_days=3.0,
                             created_at=now, last_reinforced_at=now)
        anger = EmotionRecord(id=2, star_id=1, scope="s", emotion_type="anger",
                              direction=-1, intensity=0.9, half_life_days=2.0,
                              created_at=now, last_reinforced_at=now)
        later = now + 4 * DAY
        states = emotion_engine.emotion_profile([joy, anger], now=later)
        by_type = {s.emotion_type: s for s in states}
        assert by_type["joy"].residual == pytest.approx(0.6 * 2 ** (-4 / 3))
        assert by_type["anger"].residual == pytest.approx(0.9 * 2 ** (-4 / 2))

    def test_reactivation_boost_is_transient_and_capped(self):
        """重新激活只放大当前残留，不改 E0、不超过 E0。"""
        now = time.time()
        emo = self._emo(now)
        later = now + 4 * DAY
        plain = emotion_engine.emotion_profile([emo], now=later)
        boosted = emotion_engine.emotion_profile([emo], now=later, boost=1.0)
        assert boosted[0].residual > plain[0].residual
        assert boosted[0].residual <= emo.intensity
        assert boosted[0].boosted is True
        assert emo.intensity == 0.8


# ---------------------------------------------------------------------------
# C. 两套曲线独立性测试
# ---------------------------------------------------------------------------


class TestCIndependence:
    """C. 记忆 30 天半衰期 + 情绪 2 天半衰期。"""

    def test_thirty_days_memory_half_and_emotion_tiny(self):
        now = time.time()
        params = EbbinghausParams()
        star = Star(id=1, scope="s", content="争吵", half_life_days=30.0,
                    last_reinforced_at=now, created_at=now)
        emo = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="anger",
                            direction=-1, intensity=0.8, half_life_days=2.0,
                            created_at=now, last_reinforced_at=now)
        later = now + 30 * DAY
        assert ebbinghaus.retention(star, later, params) == pytest.approx(0.5)
        # 未经强化的情绪残留比例 = 2^-15 ≈ 0.0000305
        assert emotion_engine.residual(emo, later) == pytest.approx(0.8 * 2 ** (-15))
        assert 2 ** (-15) == pytest.approx(0.0000305, abs=1e-7)

    def test_changing_emotion_half_life_does_not_change_memory(self):
        now = time.time()
        params = EbbinghausParams()
        star = Star(id=1, scope="s", content="x", half_life_days=30.0,
                    last_reinforced_at=now, created_at=now)
        later = now + 10 * DAY
        r = ebbinghaus.retention(star, later, params)
        for h in (0.5, 2.0, 30.0):
            emo = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="joy",
                                direction=1, intensity=0.8, half_life_days=h,
                                created_at=now, last_reinforced_at=now)
            emotion_engine.residual(emo, later)
        assert ebbinghaus.retention(star, later, params) == pytest.approx(r)

    def test_changing_memory_half_life_does_not_change_emotion(self):
        now = time.time()
        params = EbbinghausParams()
        emo = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="joy",
                            direction=1, intensity=0.8, half_life_days=2.0,
                            created_at=now, last_reinforced_at=now)
        later = now + 10 * DAY
        e = emotion_engine.residual(emo, later)
        for h in (1.0, 7.0, 90.0):
            star = Star(id=1, scope="s", content="x", half_life_days=h,
                        last_reinforced_at=now, created_at=now)
            ebbinghaus.retention(star, later, params)
        assert emotion_engine.residual(emo, later) == pytest.approx(e)

    def test_four_states_are_independent(self):
        """四种状态必须能彼此不同：记忆清晰/情绪消退、记忆模糊/情绪残留 等。"""
        now = time.time()
        params = EbbinghausParams()
        # 1) 记忆清晰，情绪已消退
        s1 = Star(id=1, scope="s", content="a", half_life_days=30.0,
                  last_reinforced_at=now, created_at=now)
        e1 = EmotionRecord(id=1, star_id=1, scope="s", emotion_type="anger",
                            direction=-1, intensity=0.8, half_life_days=2.0,
                            created_at=now, last_reinforced_at=now)
        later = now + 30 * DAY
        assert ebbinghaus.retention(s1, later, params) == pytest.approx(0.5)
        assert emotion_engine.residual(e1, later) < 0.01
        # 2) 记忆模糊，情绪仍有残留
        s2 = Star(id=2, scope="s", content="b", half_life_days=1.0,
                  last_reinforced_at=now, created_at=now)
        e2 = EmotionRecord(id=2, star_id=2, scope="s", emotion_type="joy",
                            direction=1, intensity=0.9, half_life_days=20.0,
                            created_at=now, last_reinforced_at=now)
        assert ebbinghaus.retention(s2, later, params) < 0.2
        assert emotion_engine.residual(e2, later) > 0.3

    def test_clarity_thresholds(self):
        params = EbbinghausParams(clear_threshold=0.55, vague_threshold=0.2)
        assert ebbinghaus.clarity_of(0.9, params) == CLARITY_CLEAR
        assert ebbinghaus.clarity_of(0.3, params) == CLARITY_VAGUE
        assert ebbinghaus.clarity_of(0.1, params) == CLARITY_FAINT
        assert ebbinghaus.clarity_of(0.0, params) == CLARITY_UNKNOWN


# ---------------------------------------------------------------------------
# D. 事件内部遗忘测试
# ---------------------------------------------------------------------------


class TestDDetailForgetting:
    """D. 主干与细节的不同遗忘速度。"""

    def test_details_have_independent_half_lives(self):
        now = time.time()
        params = EbbinghausParams()
        trunk = Star(id=1, scope="s", content="老师给了奖励",
                     half_life_days=30.0, last_reinforced_at=now, created_at=now)
        detail_a = Detail(star_id=1, scope="s", text="是一根棒棒糖",
                           half_life_days=30.0, created_at=now, last_reinforced_at=now)
        detail_b = Detail(star_id=1, scope="s", text="口味是草莓",
                           half_life_days=3.0, created_at=now, last_reinforced_at=now)
        later = now + 20 * DAY
        r_trunk = ebbinghaus.retention(trunk, later, params)
        r_a = ebbinghaus.detail_retention(detail_a, later, params)
        r_b = ebbinghaus.detail_retention(detail_b, later, params)
        assert r_trunk > 0.5
        assert r_a > r_b
        assert ebbinghaus.clarity_of(r_a, params) == CLARITY_CLEAR
        assert ebbinghaus.clarity_of(r_b, params) in (CLARITY_VAGUE, CLARITY_FAINT, CLARITY_UNKNOWN)

    def test_one_detail_fading_does_not_affect_others(self):
        params = EbbinghausParams()
        now = time.time()
        detail_a = Detail(star_id=1, scope="s", text="a", half_life_days=10.0,
                           created_at=now, last_reinforced_at=now)
        detail_b = Detail(star_id=2, scope="s", text="b", half_life_days=10.0,
                           created_at=now, last_reinforced_at=now)
        later = now + 12 * DAY
        r_a = ebbinghaus.detail_retention(detail_a, later, params)
        r_b = ebbinghaus.detail_retention(detail_b, later, params)
        assert r_a == pytest.approx(r_b)
        assert r_a < 0.5  # 两个细节都是各自淡忘，互不影响

    def test_detail_half_life_derived_from_trunk(self):
        params = EbbinghausParams(detail_half_life_ratio=0.45)
        h = ebbinghaus.detail_half_life_for(20.0, "detail", params)
        assert h == pytest.approx(9.0)
        quote_h = ebbinghaus.detail_half_life_for(20.0, "quote", params)
        assert quote_h > h  # 原话稍微记得久一点
        assert quote_h <= 20.0

    def test_injection_only_marks_reliable_or_vague_details(self):
        """无法可靠回忆的细节不得出现在注入文本里。"""
        star = Star(id=1, scope="s", content="老师给了奖励")
        scored = ScoredStar(
            star=star, retention=0.9, clarity=CLARITY_CLEAR,
            detail_states=[
                {"text": "是一根棒棒糖", "clarity": CLARITY_CLEAR, "retention": 0.9},
                {"text": "口味是草莓", "clarity": CLARITY_VAGUE, "retention": 0.3},
                {"text": "老师的原话", "clarity": CLARITY_UNKNOWN, "retention": 0.01},
            ],
        )
        line = formatting.format_star_line(scored)
        assert "棒棒糖" in line
        assert "草莓" in line and "不太确定" in line
        assert "原话" not in line


# ---------------------------------------------------------------------------
# E. 重新激活测试
# ---------------------------------------------------------------------------


class TestEReactivation:
    """E. 相似情境可唤起旧记忆，但不自动恢复细节、不等于强化。"""

    def _star(self, now: float, **kw) -> Star:
        base = dict(
            id=1, scope="s1", content="小黑养了只橘猫叫馒头",
            tags=["小黑", "馒头", "猫"], importance=0.8,
            half_life_days=7.0,
            last_reinforced_at=now - 30 * DAY,   # 已经淡忘
            created_at=now - 30 * DAY,
        )
        base.update(kw)
        return Star(**base)

    def test_similar_context_triggers_reactivation(self):
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = self._star(now)
            sid = asyncio.run(engine.store.add_star(star))
            outcome = asyncio.run(engine.recall("s1", "那只猫馒头现在怎么样了"))
            assert outcome.scored, "相似情境应当能检索到旧记忆"
            assert sid in outcome.reactivated, "已经淡忘的记忆应被标记为重新激活"
            reacts = asyncio.run(engine.store.star_reactivations(sid))
            assert len(reacts) == 1
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)

    def test_reactivation_does_not_restore_details(self):
        """再激活不会凭空恢复已经模糊的细节。"""
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = self._star(now)
            sid = asyncio.run(engine.store.add_star(star))
            asyncio.run(engine.store.add_detail(
                Detail(star_id=sid, scope="s1", text="馒头的品种是中华田园猫",
                       half_life_days=1.0, created_at=now - 30 * DAY,
                       last_reinforced_at=now - 30 * DAY)
            ))
            outcome = asyncio.run(engine.recall("s1", "那只猫馒头"))
            assert outcome.scored
            assert sid in outcome.reactivated
            # 细节依然模糊
            states = outcome.scored[0].detail_states
            assert states[0]["clarity"] != CLARITY_CLEAR
            # 且半衰期没有被恢复
            after = asyncio.run(engine.store.get_star(sid, "s1"))
            assert after.half_life_days == pytest.approx(7.0)
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)

    def test_retrieval_is_not_reinforcement(self):
        """每次检索都算强化 -> 记忆永远停在高位，这是错误的。"""
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = self._star(now)
            sid = asyncio.run(engine.store.add_star(star))
            for _ in range(5):
                asyncio.run(engine.recall("s1", "那只猫馒头"))
            after = asyncio.run(engine.store.get_star(sid, "s1"))
            assert after.recall_count == 5
            assert after.review_count == 0
            assert after.half_life_days == pytest.approx(7.0)
            assert after.last_reinforced_at == pytest.approx(star.last_reinforced_at)
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)

    def test_genuine_recall_does_reinforce(self):
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = self._star(now)
            sid = asyncio.run(engine.store.add_star(star))
            asyncio.run(engine.reinforce_ids("s1", [sid]))
            after = asyncio.run(engine.store.get_star(sid, "s1"))
            assert after.review_count == 1
            assert after.half_life_days > 7.0
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)

    def test_reactivation_does_not_overwrite_original_emotion(self):
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = self._star(now)
            sid = asyncio.run(engine.store.add_star(star))
            asyncio.run(engine.store.add_emotion(
                EmotionRecord(star_id=sid, scope="s1", emotion_type="anger",
                              direction=-1, intensity=0.8, half_life_days=2.0,
                              event_time=now - 30 * DAY, created_at=now,
                              last_reinforced_at=now - 30 * DAY)
            ))
            asyncio.run(engine.recall("s1", "那只猫馒头"))
            emos = asyncio.run(engine.store.star_emotions(sid))
            assert emos[0].intensity == 0.8      # E0 未被改写
            assert emos[0].half_life_days == 2.0  # 半衰期未被重置
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)


# ---------------------------------------------------------------------------
# F. 持久化测试
# ---------------------------------------------------------------------------


class TestFPersistence:
    """F. 关闭并重新初始化插件后，原始记录保持正确。"""

    def test_persisted_experience_survives_restart(self):
        engine, tmp = asyncio.run(fresh_engine())
        db = str(tmp / "t.db")
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = Star(
                id=0, scope="s1", content="老师给了小黑一根棒棒糖",
                tags=["小黑", "老师"], importance=0.7, valence=-0.2, arousal=0.4,
                event_time=now - 3 * DAY,
                event_time_precision="day", event_time_source="stated",
                half_life_days=9.0,
                last_reinforced_at=now - 3 * DAY,
                created_at=now,
            )
            sid = asyncio.run(engine.store.add_star(star))
            asyncio.run(engine.store.add_detail(
                Detail(star_id=sid, scope="s1", text="口味是草莓",
                       detail_type="detail", half_life_days=2.5,
                       created_at=now, last_reinforced_at=now)
            ))
            asyncio.run(engine.store.add_emotion(
                EmotionRecord(star_id=sid, scope="s1", emotion_type="gratitude",
                              direction=1, intensity=0.6, half_life_days=5.0,
                              event_time=now - 3 * DAY, created_at=now,
                              last_reinforced_at=now - 3 * DAY)
            ))
            asyncio.run(engine.store.close())

            # ---- 重新初始化（模拟 AstrBot 重启）----
            store2 = StarStore(db)
            asyncio.run(store2.initialize())
            try:
                got = asyncio.run(store2.get_star(sid, "s1"))
                details = asyncio.run(store2.star_details(sid, "s1"))
                emotions = asyncio.run(store2.star_emotions(sid, "s1"))
                assert got is not None
                assert got.content == "老师给了小黑一根棒棒糖"
                assert got.event_time == pytest.approx(now - 3 * DAY)
                assert got.event_time_precision == "day"
                assert got.event_time_source == "stated"
                assert got.half_life_days == pytest.approx(9.0)
                assert got.last_reinforced_at == pytest.approx(now - 3 * DAY)
                assert got.created_at == pytest.approx(now)
                assert got.valence == pytest.approx(-0.2)
                assert details[0].text == "口味是草莓"
                assert details[0].half_life_days == pytest.approx(2.5)
                assert emotions[0].emotion_type == "gratitude"
                assert emotions[0].intensity == pytest.approx(0.6)
                assert emotions[0].half_life_days == pytest.approx(5.0)
            finally:
                asyncio.run(store2.close())
        finally:
            cleanup_dir(tmp)

    def test_migration_from_v1_database_keeps_data(self):
        """v1 老库升级到 v2：老数据不丢，且能算出新状态。"""
        import sqlite3
        tmp = scratch_dir()
        db = str(tmp / "legacy.db")
        try:
            conn = sqlite3.connect(db)
            conn.executescript(
                """
                CREATE TABLE stars (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    scope TEXT NOT NULL, content TEXT NOT NULL, content_hash TEXT NOT NULL,
                    tags TEXT NOT NULL DEFAULT '[]', memory_type TEXT NOT NULL DEFAULT 'fact',
                    importance REAL NOT NULL DEFAULT 0.5, valence REAL NOT NULL DEFAULT 0.0,
                    arousal REAL NOT NULL DEFAULT 0.35, stability REAL NOT NULL DEFAULT 1.2,
                    last_review REAL NOT NULL, created_at REAL NOT NULL, updated_at REAL NOT NULL,
                    review_count INTEGER NOT NULL DEFAULT 0, recall_count INTEGER NOT NULL DEFAULT 0,
                    pinned INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'active',
                    embedding BLOB
                );
                """
            )
            now = time.time()
            conn.execute(
                "INSERT INTO stars (scope, content, content_hash, tags, memory_type, importance,"
                " valence, arousal, stability, last_review, created_at, updated_at, status)"
                " VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                ("s1", "老记忆", "hash1", "[]", "fact", 0.5, 0.6, 0.4, 1.2,
                 now - 10 * DAY, now - 10 * DAY, now - 10 * DAY, "active"),
            )
            conn.commit()
            conn.close()

            store = StarStore(db)
            asyncio.run(store.initialize())
            try:
                star = asyncio.run(store.get_star(1, "s1"))
                assert star is not None and star.content == "老记忆"
                assert star.event_time == pytest.approx(now - 10 * DAY)
                assert star.half_life_days == pytest.approx(1.2 * 0.6931471805599453)
                assert star.last_reinforced_at == pytest.approx(now - 10 * DAY)
                emos = asyncio.run(store.star_emotions(1, "s1"))
                assert len(emos) == 1 and emos[0].emotion_type == "joy"
            finally:
                asyncio.run(store.close())
        finally:
            cleanup_dir(tmp)


# ---------------------------------------------------------------------------
# G. 对话集成测试
# ---------------------------------------------------------------------------


class TestGConversationIntegration:
    """G. 旧记忆与情绪状态进入 LLM 上下文构建流程。

    说明：这里使用**模拟 LLM**（FakeLLM）验证上下文构建，属于模拟集成测试，
    不代表真实模型质量；真实模型链路在 AstrBot 实例中另行验证。
    """

    def test_injection_contains_memory_and_emotion(self):
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = Star(
                id=0, scope="s1", content="小黑和 TA 的猫吵架了",
                tags=["小黑", "猫", "吵架"], importance=0.8,
                half_life_days=30.0, event_time=now - 20 * DAY,
                event_time_precision="day", event_time_source="stated",
                last_reinforced_at=now - 20 * DAY, created_at=now,
            )
            sid = asyncio.run(engine.store.add_star(star))
            asyncio.run(engine.store.add_detail(
                Detail(star_id=sid, scope="s1", text="是因为把鱼干藏起来了",
                       half_life_days=20.0, created_at=now, last_reinforced_at=now)
            ))
            asyncio.run(engine.store.add_emotion(
                EmotionRecord(star_id=sid, scope="s1", emotion_type="anger",
                              direction=-1, intensity=0.8, half_life_days=14.0,
                              event_time=now - 20 * DAY, created_at=now,
                              last_reinforced_at=now - 20 * DAY)
            ))
            outcome = asyncio.run(engine.recall("s1", "小黑和那只猫吵架"))
            block = engine.render_injection(outcome)
            assert "小黑和 TA 的猫吵架了" in block
            assert "鱼干" in block
            assert "生气" in block          # 情绪残留进入上下文
            assert "此刻心绪" in block      # bot 当前心绪
            # 记忆清晰度与情绪强度是两条独立的信息
            # 事件时间一律用绝对时间显示（不出现"20 天前"这类相对说法）
            stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(now - 20 * DAY))
            assert stamp in block
            assert "天前" not in block
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)

    def test_vague_memory_is_marked_not_asserted(self):
        """记忆模糊时，注入文本必须带"不太确定"，不能当作事实。"""
        engine, tmp = asyncio.run(fresh_engine())
        try:
            now = time.time()
            asyncio.run(engine.store.initialize())
            star = Star(
                id=0, scope="s1", content="小黑好像养过一只猫",
                tags=["小黑", "猫"], importance=0.4,
                half_life_days=7.0, event_time=now - 30 * DAY,
                last_reinforced_at=now - 30 * DAY, created_at=now,
            )
            asyncio.run(engine.store.add_star(star))
            outcome = asyncio.run(engine.recall("s1", "小黑的猫"))
            block = engine.render_injection(outcome)
            assert "记得不太清" in block or "只剩一点印象" in block
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)

    def test_extraction_prompt_requests_details_time_emotions(self):
        """提取提示词必须要求主干/细节/事件时间/情绪/关系。"""
        engine, _tmp = asyncio.run(fresh_engine())
        try:
            payload = json.dumps({
                "memories": [{
                    "content": "小黑弄丢了伞",
                    "details": ["是一把透明长柄伞", "在图书馆丢的"],
                    "tags": ["小黑", "伞"],
                    "type": "event",
                    "importance": 0.6,
                    "valence": -0.4,
                    "arousal": 0.5,
                    "emotions": [{"type": "disappointment", "intensity": 0.6}],
                    "event_time": "上周三",
                    "event_time_precision": "day",
                    "pinned": False,
                }],
                "mood_delta": {"valence": -0.1, "arousal": 0.1, "affection": 0.0},
                "mood_reason": "丢了东西有点沮丧",
                "used_memory_ids": [],
                "relations": [],
                "emotion_updates": [],
            }, ensure_ascii=False)
            engine.llm.payload = payload
            outcome = asyncio.run(engine.consolidate(
                "s1", ["[10-01 10:00] 小黑：我上周三在图书馆弄丢了伞"]))
            assert len(outcome.added) == 1
            stars = asyncio.run(engine.store.scope_stars("s1"))
            star = stars[0]
            details = asyncio.run(engine.store.star_details(star.id))
            emotions = asyncio.run(engine.store.star_emotions(star.id))
            assert len(details) == 2
            assert details[0].half_life_days < star.half_life_days
            assert len(emotions) == 1
            assert emotions[0].emotion_type == "disappointment"
            assert emotions[0].intensity == pytest.approx(0.6)
            # 事件时间被解析成真实时间戳（而不是"现在"）
            assert star.event_time is not None
            assert star.event_time < time.time()
            assert star.event_time_precision == "day"
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(engine_tmp) if False else None

    def test_unknown_event_time_is_not_fabricated(self):
        """对话没提时间 -> 事件时间保持未知，不编造。"""
        engine, tmp = asyncio.run(fresh_engine())
        try:
            payload = json.dumps({
                "memories": [{
                    "content": "小黑喜欢喝柠檬水",
                    "details": [],
                    "tags": ["小黑"],
                    "type": "preference",
                    "importance": 0.4,
                    "valence": 0.2,
                    "arousal": 0.2,
                    "emotions": [],
                    "event_time": "",
                    "event_time_precision": "unknown",
                    "pinned": False,
                }],
                "mood_delta": {}, "mood_reason": "",
                "used_memory_ids": [], "relations": [], "emotion_updates": [],
            }, ensure_ascii=False)
            engine.llm.payload = payload
            asyncio.run(engine.consolidate("s1", ["[10-01 10:00] 小黑：我喜欢柠檬水"]))
            stars = asyncio.run(engine.store.scope_stars("s1"))
            assert stars[0].event_time is None
            assert stars[0].event_time_precision == "unknown"
        finally:
            asyncio.run(engine.store.close())
            cleanup_dir(tmp)


# ---------------------------------------------------------------------------
# 时间解析
# ---------------------------------------------------------------------------


class TestTimeline:
    def test_relative_and_absolute(self):
        now = time.time()
        ts, prec, src = timeline.parse_event_time("昨天", now=now)
        assert prec == "day" and ts is not None
        ts2, prec2, _ = timeline.parse_event_time("2024-05-01", now=now)
        assert prec2 == "day"
        assert time.strftime("%Y-%m-%d", time.localtime(ts2)) == "2024-05-01"

    def test_unknown_stays_unknown(self):
        ts, prec, src = timeline.parse_event_time("不知道什么时候")
        assert ts is None and prec == "unknown" and src == "unknown"
        ts, prec, src = timeline.parse_event_time("")
        assert ts is None and prec == "unknown"

    def test_three_days_ago(self):
        now = time.time()
        ts, prec, _ = timeline.parse_event_time("3天前", now=now)
        assert prec == "day"
        assert abs((now - ts) - 3 * DAY) < 2 * DAY
