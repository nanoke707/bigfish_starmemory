"""情绪衰减引擎：情绪有**自己独立的半衰期**，与记忆遗忘曲线完全解耦。

## 为什么单独一套

记忆会淡忘，不代表情绪跟着一起淡忘。角色可以已经记不清当时的原话，
却仍然为那件事耿耿于怀；也可以把事情忘得一干二净，提起时依然高兴。
所以这里不复用艾宾浩斯遗忘曲线的任何参数：

    E(t) = E0 · 2^(-t / H_e)

- ``E0``：事件发生时记录的**原始**情绪强度（永久保存，不可被当前残留覆盖）；
- ``H_e``：该情绪的半衰期（按情绪类型分别配置，可被配置覆盖）；
- ``t``：距情绪起始时间（或最近一次**有效**情绪强化）的时间差。

符号表示方向（正向/负向），衰减只作用于强度。例如原始愤怒 -0.8、
H_e = 2 天，一周后的未激活残留为 -0.8 × 2^(-3.5) ≈ -0.0707。

## 与记忆状态互不干扰

本模块不读写任何记忆保持率；记忆模块也不读取这里的任何函数结果。
两者唯一的交汇点是"表现层"：注入给 LLM 的文本里，记忆的清晰度与情绪的
残留强度是两条独立的描述。
"""

from __future__ import annotations

import time
from dataclasses import dataclass

from .models import EmotionRecord

# ln 2，用于在指数形式与半衰期形式之间换算
LN2 = 0.6931471805599453

# ---- 情绪类型 -----------------------------------------------------------

#: 支持的情绪类型（英文 key -> 中文名）
EMOTION_LABELS: dict[str, str] = {
    "joy": "开心",
    "sadness": "难过",
    "anger": "生气",
    "disappointment": "失望",
    "gratitude": "感激",
    "trust": "信任",
    "fear": "害怕",
    "surprise": "惊讶",
    "calm": "平静",
}

#: 情绪方向：+1 正向，-1 负向，0 中性
EMOTION_DIRECTION: dict[str, int] = {
    "joy": 1,
    "sadness": -1,
    "anger": -1,
    "disappointment": -1,
    "gratitude": 1,
    "trust": 1,
    "fear": -1,
    "surprise": 1,
    "calm": 0,
}

#: 每种情绪的默认半衰期（天）。可被插件配置逐项覆盖。
DEFAULT_TYPE_HALF_LIFE: dict[str, float] = {
    "joy": 3.0,
    "sadness": 4.0,
    "anger": 2.0,
    "disappointment": 2.5,
    "gratitude": 5.0,
    "trust": 14.0,
    "fear": 1.5,
    "surprise": 0.8,
    "calm": 6.0,
}

#: 兜底半衰期（类型未知时使用）
DEFAULT_HALF_LIFE_DAYS = 2.0

#: 低于该残留比例时，表现层可以忽略，但**绝不删除**原始情绪记录
RESIDUAL_FLOOR = 0.002


def normalize_type(raw: str | None) -> str:
    """把 LLM 输出的情绪词归一到受支持的类型。"""
    key = (raw or "").strip().lower()
    if key in EMOTION_LABELS:
        return key
    # 常见同义词
    alias = {
        "happy": "joy", "开心": "joy", "高兴": "joy", "愉快": "joy", "喜悦": "joy",
        "sad": "sadness", "难过": "sadness", "伤心": "sadness", "低落": "sadness",
        "angry": "anger", "愤怒": "anger", "生气": "anger", "恼火": "anger",
        "失望": "disappointment", "disappoint": "disappointment",
        "感激": "gratitude", "感谢": "gratitude", "grateful": "gratitude",
        "信任": "trust", "trust": "trust",
        "害怕": "fear", "恐惧": "fear", "fear": "fear", "担心": "fear",
        "惊讶": "surprise", "surprised": "surprise",
        "平静": "calm", "calm": "calm", "neutral": "calm",
    }
    return alias.get(key, "calm")


def direction_of(emotion_type: str) -> int:
    return EMOTION_DIRECTION.get(emotion_type, 0)


def default_half_life(emotion_type: str) -> float:
    return DEFAULT_TYPE_HALF_LIFE.get(emotion_type, DEFAULT_HALF_LIFE_DAYS)


# ---- 衰减计算 -----------------------------------------------------------


def residual_ratio(elapsed_days: float, half_life_days: float) -> float:
    """残留比例 ``2^(-t/H_e)``。

    - 负的时间差（时钟回拨等）按 0 处理；
    - ``half_life_days <= 0`` 视为情绪已经散尽（返回 0），不抛异常；
    - 结果恒在 [0, 1]。
    """
    if half_life_days is None or half_life_days <= 0:
        return 0.0
    dt = max(0.0, float(elapsed_days))
    try:
        return max(0.0, min(1.0, 2.0 ** (-dt / float(half_life_days))))
    except (OverflowError, ValueError):
        return 0.0


def elapsed_days(anchor: float | None, now: float | None = None) -> float:
    """距锚点的时间（天），锚点缺失时返回 0。"""
    if not anchor:
        return 0.0
    now = time.time() if now is None else now
    return max(0.0, (now - float(anchor)) / 86400.0)


def emotion_anchor(emotion: EmotionRecord) -> float:
    """情绪的时间锚点：最近一次有效情绪强化 > 情绪起始时间 > 记录创建时间。"""
    return (
        emotion.last_reinforced_at
        or emotion.event_time
        or emotion.created_at
        or 0.0
    )


def residual(emotion: EmotionRecord, now: float | None = None) -> float:
    """当前情绪残留**强度**（非负，0~1 之间的原始强度衰减结果）。"""
    dt = elapsed_days(emotion_anchor(emotion), now)
    return max(0.0, min(1.0, float(emotion.intensity or 0.0))) * residual_ratio(dt, emotion.half_life_days)


def signed_residual(emotion: EmotionRecord, now: float | None = None) -> float:
    """带符号的当前情绪残留（正=正向情绪，负=负向情绪）。"""
    return direction_of(emotion.emotion_type) * residual(emotion, now)


@dataclass
class EmotionState:
    """一颗星星当前的情绪快照（原始记录 + 动态残留）。"""

    emotion_type: str
    label: str
    original_intensity: float   # E0，永不覆盖
    half_life_days: float       # H_e
    residual: float             # 当前残留强度（非负）
    signed: float               # 当前残留强度（带方向）
    elapsed_days: float
    boosted: bool = False       # 本轮是否被重新激活临时放大

    def as_dict(self) -> dict:
        return {
            "type": self.emotion_type,
            "label": self.label,
            "original": round(self.original_intensity, 4),
            "half_life_days": round(self.half_life_days, 4),
            "residual": round(self.residual, 4),
            "signed": round(self.signed, 4),
            "elapsed_days": round(self.elapsed_days, 2),
            "boosted": self.boosted,
        }


def emotion_state(emotion: EmotionRecord, now: float | None = None) -> EmotionState:
    """计算一条情绪记录的当前状态。"""
    now = time.time() if now is None else now
    dt = elapsed_days(emotion_anchor(emotion), now)
    res = max(0.0, min(1.0, float(emotion.intensity or 0.0))) * residual_ratio(dt, emotion.half_life_days)
    etype = emotion.emotion_type if emotion.emotion_type in EMOTION_LABELS else normalize_type(emotion.emotion_type)
    return EmotionState(
        emotion_type=etype,
        label=EMOTION_LABELS.get(etype, etype),
        original_intensity=max(0.0, min(1.0, float(emotion.intensity or 0.0))),
        half_life_days=float(emotion.half_life_days or DEFAULT_HALF_LIFE_DAYS),
        residual=res,
        signed=direction_of(etype) * res,
        elapsed_days=dt,
    )


def emotion_profile(
    emotions: list[EmotionRecord],
    now: float | None = None,
    floor: float = RESIDUAL_FLOOR,
    boost: float = 0.0,
) -> list[EmotionState]:
    """整颗星星的情绪画像。

    ``boost`` 是**重新激活的临时增益**（本轮表现层用），只放大当前残留，
    不会写回原始强度 E0，也不会重置半衰期。
    """
    states: list[EmotionState] = []
    for em in emotions or []:
        st = emotion_state(em, now)
        if boost > 0 and st.residual > 0:
            boosted = min(st.original_intensity, st.residual * (1.0 + boost))
            if boosted > st.residual + 1e-9:
                st = EmotionState(
                    emotion_type=st.emotion_type,
                    label=st.label,
                    original_intensity=st.original_intensity,
                    half_life_days=st.half_life_days,
                    residual=boosted,
                    signed=(1 if st.signed >= 0 else -1) * boosted,
                    elapsed_days=st.elapsed_days,
                    boosted=True,
                )
        if st.residual >= floor:
            states.append(st)
    states.sort(key=lambda s: abs(s.signed), reverse=True)
    return states


# ---- 表现层 -------------------------------------------------------------


def _strength_word(value: float) -> str:
    if value >= 0.45:
        return "很强烈"
    if value >= 0.18:
        return "还比较明显"
    if value >= 0.06:
        return "淡淡的"
    return "几乎感觉不到"


def describe_emotions(states: list[EmotionState], limit: int = 2) -> str:
    """把情绪画像写成一句给 LLM 看的自然语言（不强制角色表达）。"""
    if not states:
        return ""
    parts: list[str] = []
    for st in states[:limit]:
        word = _strength_word(st.residual)
        if st.signed >= 0:
            parts.append(f"还留着一点{st.label}（{word}，残留约 {st.residual:.2f}）")
        else:
            parts.append(f"还留着一点{st.label}（{word}，残留约 {st.residual:.2f}）")
    return "、".join(parts)


def strongest(states: list[EmotionState]) -> EmotionState | None:
    return states[0] if states else None
