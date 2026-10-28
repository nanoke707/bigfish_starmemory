"""星云心绪引擎：bot 的情绪状态机。

三条情绪轴（借鉴情绪心理学中效价-唤醒度模型的简化版，并加入陪伴场景
特有的"好感/依恋"轴）：

- ``valence``   愉悦度  -1~1   （低落 <-> 开心）
- ``arousal``   激动度   0~1   （平静 <-> 兴奋）
- ``affection`` 好感度   0~1   （对当前对话者的亲近程度）

特性：
1. **自然消退**：情绪会随时间回归基线（开心会淡、气会消、好感变化慢）；
2. **LLM 驱动更新**：每轮整理时由 LLM 给出增量，这里负责钳位与融合；
3. **记忆共鸣**：召回的旧星星会按其保持率与重要度轻轻牵引当前心绪；
4. **可描述**：``describe()`` 生成注入提示词用的自然语言心绪。
"""

from __future__ import annotations

import time

from .models import Mood
from .models import ScoredStar
from .text import clamp

# 各轴的回归基线与时间常数（单位：秒）。
# valence/arousal 是"一时心情"，几小时内消退；affection 是"长期态度"，变化很慢。
_BASELINES = {"valence": 0.0, "arousal": 0.2, "affection": 0.4}
_TAUS = {"valence": 8 * 3600.0, "arousal": 5 * 3600.0, "affection": 72 * 3600.0}

# LLM 每轮允许的最大增量（防止一言不合情绪坐过山车）
_MAX_DELTAS = {"valence": 0.45, "arousal": 0.40, "affection": 0.15}

_BOUNDS = {"valence": (-1.0, 1.0), "arousal": (0.0, 1.0), "affection": (0.0, 1.0)}


def decay(mood: Mood, now: float | None = None) -> Mood:
    """让心绪随时间回归基线，返回新的 Mood（不修改原对象）。"""
    now = time.time() if now is None else now
    elapsed = max(0.0, now - mood.updated_at)
    if elapsed <= 0:
        return Mood(mood.valence, mood.arousal, mood.affection, mood.updated_at)
    vals = {}
    for axis, baseline in _BASELINES.items():
        current = getattr(mood, axis)
        tau = _TAUS[axis]
        factor = 0.0 if tau <= 0 else 1.0 - pow(2.718281828, -elapsed / tau)
        vals[axis] = baseline + (current - baseline) * (1.0 - factor)
    return Mood(vals["valence"], vals["arousal"], vals["affection"], now)


def apply_deltas(mood: Mood, deltas: dict | None) -> Mood:
    """应用 LLM 给出的心绪增量（钳位后叠加），返回新的 Mood。"""
    deltas = deltas if isinstance(deltas, dict) else {}
    result = Mood(mood.valence, mood.arousal, mood.affection, time.time())
    for axis, limit in _MAX_DELTAS.items():
        raw = deltas.get(axis, 0)
        try:
            delta = float(raw)
        except (TypeError, ValueError):
            continue
        if delta != delta:  # NaN
            continue
        delta = max(-limit, min(limit, delta))
        low, high = _BOUNDS[axis]
        setattr(result, axis, clamp(getattr(result, axis) + delta, low, high))
    return result


def resonate(mood: Mood, scored_stars: list[ScoredStar], strength: float) -> Mood:
    """旧记忆牵动心绪：按保持率与重要度加权的情绪共鸣。

    想起的开心事让此刻更明亮，想起的遗憾让此刻蒙上薄雾。
    """
    if strength <= 0 or not scored_stars:
        return Mood(mood.valence, mood.arousal, mood.affection, mood.updated_at)
    total_weight = 0.0
    weighted_valence = 0.0
    weighted_arousal = 0.0
    for scored in scored_stars:
        star = scored.star
        weight = (0.3 + 0.7 * scored.retention) * (0.4 + star.importance)
        weighted_valence += star.valence * weight
        weighted_arousal += (star.arousal * 0.5 + abs(star.valence) * 0.5) * weight
        total_weight += weight
    if total_weight <= 0:
        return Mood(mood.valence, mood.arousal, mood.affection, mood.updated_at)
    target_valence = weighted_valence / total_weight
    target_arousal = weighted_arousal / total_weight
    new_valence = mood.valence + (target_valence - mood.valence) * strength
    new_arousal = mood.arousal + (target_arousal - mood.arousal) * strength * 0.5
    return Mood(clamp(new_valence, -1, 1), clamp(new_arousal, 0, 1), mood.affection, mood.updated_at)


def describe(mood: Mood) -> str:
    """把心绪写成一段给 LLM 看的自然语言描述。"""
    v = mood.valence
    a = mood.arousal
    parts: list[str] = []
    if v > 0.5:
        parts.append("很开心" if a > 0.55 else "心情很好")
    elif v > 0.15:
        parts.append("有点开心" if a > 0.55 else "心情不错")
    elif v > -0.15:
        parts.append("心情平静")
    elif v > -0.5:
        parts.append("有些低落" if a < 0.4 else "有点烦")
    else:
        parts.append("很难过" if a < 0.4 else "又气又难过")

    if a > 0.75:
        parts.append("情绪很激动")
    elif a < 0.2:
        parts.append("有些倦意")

    percent = int(round(mood.affection * 100))
    text = "，".join(parts)
    return f"{text}；对当前对话者的好感约 {percent}/100"
