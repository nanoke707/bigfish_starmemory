"""数据模型：星星（记忆）与星云（心绪）。

一个"星星"就是一段**经历**。它不是一条静止的记录，而是一颗有生命的天体：

- ``event_time`` 事件**实际发生**的时间（与系统写入时间 ``created_at`` 严格区分）；
- ``half_life_days`` 这段经历的记忆半衰期 H_m（不同经历各不相同）；
- ``last_reinforced_at`` 最近一次**有效强化**的时间——遗忘曲线的锚点；
- ``importance`` 写入时的重要程度；
- ``valence`` / ``arousal`` 写入时情绪光晕的**原始**摘要（永不覆盖）。

一颗星星由四类实体共同描述：

===========  ========================================================
``Star``      经历主干：发生了什么、什么时候发生、多重要、遗忘多快
``Detail``    经历细节：主干之下的具体内容，**各自有独立半衰期**
``EmotionRecord`` 原始情绪：情绪类型 + 方向 + 强度，**独立半衰期**
``MemoryLink``  星星之间的关系：强化 / 补充 / 纠正 / 矛盾
===========  ========================================================

另有 ``Reactivation`` 记录"旧经历在本轮被重新唤起"的事件。

"星云"（Mood）是 bot 的当前心绪：愉悦(valence)、激动(arousal)、好感(affection)
三条轴，随时间自然回归基线，也会被 recalled 的星星轻轻牵引。
"""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Iterable

from .timeline import PRECISION_UNKNOWN, SOURCE_UNKNOWN


class MemoryStatus(str, Enum):
    """星星的生命周期：明亮 -> 变暗(faded) -> 熄灭归档(archived)。"""

    ACTIVE = "active"        # 明星：正常可被召回
    FADED = "faded"          # 暗星：几乎想不起来，偶有"灵光一现"
    ARCHIVED = "archived"    # 熄灭：已归档，不再参与召回


VALID_STATUSES = {s.value for s in MemoryStatus}

VALID_MEMORY_TYPES = {"fact", "event", "preference", "promise", "emotion", "skill"}

# ---- 回忆清晰度分级 ------------------------------------------------------

CLARITY_CLEAR = "clear"        # 可靠：可以当作事实陈述
CLARITY_VAGUE = "vague"        # 模糊：只能含糊其辞
CLARITY_FAINT = "faint"        # 几乎不记得：可以提"好像有过"
CLARITY_UNKNOWN = "unknown"    # 无法可靠回忆：不得断言，也不该提

VALID_CLARITY = {CLARITY_CLEAR, CLARITY_VAGUE, CLARITY_FAINT, CLARITY_UNKNOWN}

# ---- 关联关系 ------------------------------------------------------------

REL_REINFORCES = "reinforces"    # 新经历印证旧记忆
REL_SUPPLEMENTS = "supplements"  # 新经历补充旧记忆
REL_CONTRADICTS = "contradicts"  # 新经历与旧记忆矛盾
REL_RECALL = "recall"            # 本轮真正回想起旧记忆

VALID_RELATIONS = {REL_REINFORCES, REL_SUPPLEMENTS, REL_CONTRADICTS, REL_RECALL}


@dataclass
class Star:
    """一段经历的主干。"""

    id: int
    scope: str
    content: str
    content_hash: str = ""
    tags: list[str] = field(default_factory=list)
    memory_type: str = "fact"
    importance: float = 0.5      # 0~1 写入时的重要程度
    valence: float = 0.0         # -1~1 写入时的情绪愉悦度（原始摘要，永不覆盖）
    arousal: float = 0.35        # 0~1 写入时的情绪激动度（原始摘要，永不覆盖）
    # ---- 时间与遗忘 ------------------------------------------------
    event_time: float | None = None          # 事件实际发生时间（None=不详）
    event_time_precision: str = PRECISION_UNKNOWN
    event_time_source: str = SOURCE_UNKNOWN
    half_life_days: float = 7.0              # 记忆半衰期 H_m
    last_reinforced_at: float = 0.0          # 最近一次有效强化时间（遗忘锚点）
    # ---- 兼容字段 --------------------------------------------------
    stability: float = 1.2       # 稳定度 S = H_m / ln2（与 H_m 等价，保留兼容）
    last_review: float = field(default_factory=time.time)
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    review_count: int = 0        # 被有效强化（巩固）次数
    recall_count: int = 0        # 被检索到的次数（**不等于**强化）
    reactivate_count: int = 0    # 被重新唤起的次数
    pinned: bool = False         # 珍藏星：永不熄灭
    status: str = MemoryStatus.ACTIVE.value
    corrected: bool = False      # 已被新经历纠正（原始记录保留，仅标记）
    embedding: list[float] | None = None

    @staticmethod
    def now() -> float:
        return time.time()

    def to_row(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "scope": self.scope,
            "content": self.content,
            "content_hash": self.content_hash,
            "tags": json.dumps(self.tags, ensure_ascii=False),
            "memory_type": self.memory_type,
            "importance": self.importance,
            "valence": self.valence,
            "arousal": self.arousal,
            "event_time": self.event_time,
            "event_time_precision": self.event_time_precision,
            "event_time_source": self.event_time_source,
            "half_life_days": self.half_life_days,
            "last_reinforced_at": self.last_reinforced_at,
            "stability": self.stability,
            "last_review": self.last_review,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
            "review_count": self.review_count,
            "recall_count": self.recall_count,
            "reactivate_count": self.reactivate_count,
            "pinned": int(self.pinned),
            "status": self.status,
            "corrected": int(self.corrected),
        }

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Star":
        try:
            tags = json.loads(row.get("tags") or "[]")
            if not isinstance(tags, list):
                tags = []
        except (json.JSONDecodeError, TypeError):
            tags = []
        tags = [str(t) for t in tags if str(t).strip()][:12]
        status = str(row.get("status") or MemoryStatus.ACTIVE.value)
        if status not in VALID_STATUSES:
            status = MemoryStatus.ACTIVE.value
        mtype = str(row.get("memory_type") or "fact")
        event_time = row.get("event_time")
        try:
            event_time = float(event_time) if event_time not in (None, "") else None
        except (TypeError, ValueError):
            event_time = None
        return cls(
            id=int(row.get("id") or 0),
            scope=str(row.get("scope") or ""),
            content=str(row.get("content") or ""),
            content_hash=str(row.get("content_hash") or ""),
            tags=tags,
            memory_type=mtype if mtype in VALID_MEMORY_TYPES else "fact",
            importance=float(row.get("importance") or 0.5),
            valence=float(row.get("valence") or 0.0),
            arousal=float(row.get("arousal") or 0.35),
            event_time=event_time,
            event_time_precision=str(row.get("event_time_precision") or PRECISION_UNKNOWN),
            event_time_source=str(row.get("event_time_source") or SOURCE_UNKNOWN),
            half_life_days=float(row.get("half_life_days") or 7.0),
            last_reinforced_at=float(row.get("last_reinforced_at") or 0.0),
            stability=float(row.get("stability") or 1.2),
            last_review=float(row.get("last_review") or time.time()),
            created_at=float(row.get("created_at") or time.time()),
            updated_at=float(row.get("updated_at") or time.time()),
            review_count=int(row.get("review_count") or 0),
            recall_count=int(row.get("recall_count") or 0),
            reactivate_count=int(row.get("reactivate_count") or 0),
            pinned=bool(row.get("pinned")),
            status=status,
            corrected=bool(row.get("corrected")),
        )


@dataclass
class Detail:
    """经历的细节：主干之下的具体内容，拥有**独立的半衰期**。

    细节与主干用同一类指数遗忘函数，但参数不同——所以角色可能还记得
    "获得过奖励"，却已经想不起奖励是什么口味。
    """

    id: int = 0
    star_id: int = 0
    scope: str = ""
    text: str = ""
    detail_type: str = "detail"     # detail / quote / fact
    half_life_days: float = 3.0
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    last_reinforced_at: float = 0.0
    reinforce_count: int = 0
    corrected: bool = False

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Detail":
        try:
            return cls(
                id=int(row.get("id") or 0),
                star_id=int(row.get("star_id") or 0),
                scope=str(row.get("scope") or ""),
                text=str(row.get("text") or ""),
                detail_type=str(row.get("detail_type") or "detail"),
                half_life_days=float(row.get("half_life_days") or 3.0),
                created_at=float(row.get("created_at") or time.time()),
                updated_at=float(row.get("updated_at") or time.time()),
                last_reinforced_at=float(row.get("last_reinforced_at") or 0.0),
                reinforce_count=int(row.get("reinforce_count") or 0),
                corrected=bool(row.get("corrected")),
            )
        except (TypeError, ValueError):
            return cls()


@dataclass
class EmotionRecord:
    """事件发生时的**原始情绪**，拥有独立于记忆的半衰期。

    - ``intensity`` 原始强度 E0（不可被当前残留覆盖）；
    - ``direction`` +1 正向 / -1 负向 / 0 中性；
    - ``half_life_days`` 情绪半衰期 H_e；
    - ``event_time`` 情绪起始时间（默认继承事件时间）；
    - ``last_reinforced_at`` 最近一次**有效情绪强化**时间。
    """

    id: int = 0
    star_id: int = 0
    scope: str = ""
    emotion_type: str = "calm"
    direction: int = 0
    intensity: float = 0.0
    half_life_days: float = 2.0
    event_time: float | None = None
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    last_reinforced_at: float = 0.0
    reinforce_count: int = 0
    reinforce_reason: str = ""

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "EmotionRecord":
        try:
            event_time = row.get("event_time")
            event_time = float(event_time) if event_time not in (None, "") else None
            return cls(
                id=int(row.get("id") or 0),
                star_id=int(row.get("star_id") or 0),
                scope=str(row.get("scope") or ""),
                emotion_type=str(row.get("emotion_type") or "calm"),
                direction=int(row.get("direction") or 0),
                intensity=float(row.get("intensity") or 0.0),
                half_life_days=float(row.get("half_life_days") or 2.0),
                event_time=event_time,
                created_at=float(row.get("created_at") or time.time()),
                updated_at=float(row.get("updated_at") or time.time()),
                last_reinforced_at=float(row.get("last_reinforced_at") or 0.0),
                reinforce_count=int(row.get("reinforce_count") or 0),
                reinforce_reason=str(row.get("reinforce_reason") or ""),
            )
        except (TypeError, ValueError):
            return cls()


@dataclass
class MemoryLink:
    """星星之间的关系：强化 / 补充 / 纠正 / 矛盾 / 回忆。"""

    id: int = 0
    from_star_id: int = 0
    to_star_id: int = 0
    scope: str = ""
    relation: str = REL_REINFORCES
    reason: str = ""
    created_at: float = field(default_factory=time.time)

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "MemoryLink":
        try:
            return cls(
                id=int(row.get("id") or 0),
                from_star_id=int(row.get("from_star_id") or 0),
                to_star_id=int(row.get("to_star_id") or 0),
                scope=str(row.get("scope") or ""),
                relation=str(row.get("relation") or REL_REINFORCES),
                reason=str(row.get("reason") or ""),
                created_at=float(row.get("created_at") or time.time()),
            )
        except (TypeError, ValueError):
            return cls()


@dataclass
class Reactivation:
    """旧经历在本轮被重新唤起的记录。

    再激活 ≠ 强化：它会让旧经历重新进入注意范围，并在**本轮**放大情绪残留，
    但不会恢复已经模糊的细节，也不会改写原始情绪强度。
    """

    id: int = 0
    star_id: int = 0
    scope: str = ""
    ts: float = field(default_factory=time.time)
    trigger: str = ""
    score: float = 0.0
    effect: float = 0.0

    @classmethod
    def from_row(cls, row: dict[str, Any]) -> "Reactivation":
        try:
            return cls(
                id=int(row.get("id") or 0),
                star_id=int(row.get("star_id") or 0),
                scope=str(row.get("scope") or ""),
                ts=float(row.get("ts") or time.time()),
                trigger=str(row.get("trigger") or ""),
                score=float(row.get("score") or 0.0),
                effect=float(row.get("effect") or 0.0),
            )
        except (TypeError, ValueError):
            return cls()



@dataclass
class Mood:
    """星云心绪：bot 的当前情绪状态。"""

    valence: float = 0.0     # -1~1  愉悦 <-> 低落
    arousal: float = 0.2     # 0~1   平静 <-> 激动
    affection: float = 0.4   # 0~1   对当前对话者的好感/依恋
    updated_at: float = field(default_factory=time.time)

    @classmethod
    def from_row(cls, row: dict[str, Any] | None) -> "Mood":
        if not row:
            return cls()
        return cls(
            valence=float(row.get("valence") or 0.0),
            arousal=float(row.get("arousal") or 0.2),
            affection=float(row.get("affection") or 0.4),
            updated_at=float(row.get("updated_at") or time.time()),
        )


@dataclass
class ScoredStar:
    """召回阶段的候选：星星 + 检索得分 + 当前保持率 + 回忆清晰度。"""

    star: Star
    score: float = 0.0
    retention: float = 1.0          # 主干保持率 R
    glimmer: bool = False            # 是否触发了"灵光一现"
    matched_by: str = "hybrid"       # vector / keyword / hybrid / recent
    clarity: str = CLARITY_CLEAR     # 主干清晰度：clear/vague/faint/unknown
    detail_states: list[dict[str, Any]] = field(default_factory=list)  # 细节 + 各自清晰度
    emotion_states: list[Any] = field(default_factory=list)            # EmotionState 列表
    reactivated: bool = False        # 本轮是否构成"重新激活"
    event_time_label: str = ""       # 事件发生时间的人话描述


@dataclass
class ConsolidationOutcome:
    """一次记忆整理（巩固）的结果，用于日志与命令回显。"""

    added: list[str] = field(default_factory=list)
    reinforced: list[int] = field(default_factory=list)
    corrected: list[int] = field(default_factory=list)
    merged: int = 0
    mood_changed: bool = False
    mood_reason: str = ""
    skipped: str = ""          # 非空表示未整理的原因
