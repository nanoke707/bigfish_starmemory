"""配置读取封装。

AstrBot 会把 ``_conf_schema.json`` 中声明的配置以嵌套 dict 的形式传给插件，
这里提供一个带默认值兜底、类型钳位的只读访问层，避免任何一处配置缺失
导致插件崩溃——记忆系统必须比主人的记性更可靠。
"""

from __future__ import annotations

from typing import Any, Mapping


def _clamp(value: float, low: float, high: float) -> float:
    try:
        v = float(value)
    except (TypeError, ValueError):
        v = low
    return max(low, min(high, v))


class StarConfig:
    """点路径访问的配置视图：``cfg.get("forgetting.fade_threshold", 0.18)``。

    持有**活引用**（而非拷贝）：WebUI 设置页写回 AstrBotConfig 后，
    引擎无需重建即可读到新值。
    """

    def __init__(self, raw: Mapping[str, Any] | None = None):
        self.raw: Mapping[str, Any] = raw if isinstance(raw, Mapping) else {}

    # ---- 基础读取 -------------------------------------------------

    def get(self, path: str, default: Any = None) -> Any:
        """按 ``a.b.c`` 点路径读取配置，任意一层缺失即返回默认值。"""
        node: Any = self.raw
        for part in path.split("."):
            if not isinstance(node, Mapping) or part not in node:
                return default
            node = node[part]
        if node is None:
            return default
        return node

    def bool(self, path: str, default: bool = False) -> bool:
        value = self.get(path, default)
        if isinstance(value, bool):
            return value
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "yes", "on", "是")
        return bool(value) if value is not None else default

    def int(self, path: str, default: int, low: int | None = None, high: int | None = None) -> int:
        try:
            value = int(float(self.get(path, default)))
        except (TypeError, ValueError):
            value = default
        if low is not None:
            value = max(low, value)
        if high is not None:
            value = min(high, value)
        return value

    def float(self, path: str, default: float, low: float | None = None, high: float | None = None) -> float:
        try:
            value = float(self.get(path, default))
        except (TypeError, ValueError):
            value = default
        if low is not None:
            value = max(low, value)
        if high is not None:
            value = min(high, value)
        return value

    def str(self, path: str, default: str = "") -> str:
        value = self.get(path, default)
        return str(value).strip() if value is not None else default

    # ---- 语义化快捷读取（集中钳位，防止面板里填出灾难值） ----------

    @property
    def enabled(self) -> bool:
        return self.bool("general.enabled", True)

    @property
    def scope_mode(self) -> str:
        mode = self.str("general.scope_mode", "session").lower()
        return mode if mode in ("session", "user", "global") else "session"

    @property
    def recall_top_k(self) -> int:
        return self.int("recall.top_k", 5, low=1, high=30)

    @property
    def recall_min_score(self) -> float:
        return self.float("recall.min_score", 0.12, low=0.0, high=1.0)

    @property
    def injection_method(self) -> str:
        method = self.str("recall.injection_method", "system_prompt").lower()
        return method if method in ("system_prompt", "contexts", "off") else "system_prompt"

    @property
    def max_injection_chars(self) -> int:
        return self.int("recall.max_injection_chars", 900, low=200, high=8000)

    @property
    def hook_budget_seconds(self) -> float:
        return self.float("general.hook_budget_seconds", 0.0, low=0.0, high=60.0)

    @property
    def min_transcript_chars(self) -> int:
        return self.int("consolidation.min_transcript_chars", 6, low=1, high=2000)

    @property
    def consolidate_every_n_turns(self) -> int:
        return self.int("consolidation.every_n_turns", 1, low=1, high=50)

    @property
    def max_memories_per_turn(self) -> int:
        return self.int("consolidation.max_memories_per_turn", 3, low=1, high=10)

    @property
    def dedup_similarity(self) -> float:
        return self.float("consolidation.dedup_similarity", 0.88, low=0.5, high=1.0)

    @property
    def maintenance_hour(self) -> int:
        return self.int("forgetting.maintenance_hour", 4, low=0, high=23)

    @property
    def initial_stability_days(self) -> float:
        return self.float("forgetting.initial_stability_days", 1.2, low=0.1, high=60.0)

    @property
    def max_stability_days(self) -> float:
        return self.float("forgetting.max_stability_days", 120.0, low=1.0, high=3650.0)

    @property
    def fade_threshold(self) -> float:
        return self.float("forgetting.fade_threshold", 0.18, low=0.01, high=0.9)

    @property
    def forget_threshold(self) -> float:
        # forget_threshold 必须小于 fade_threshold，否则星星会跳过"变暗"直接熄灭
        threshold = self.float("forgetting.forget_threshold", 0.05, low=0.001, high=0.5)
        return min(threshold, self.fade_threshold * 0.6)

    @property
    def review_boost(self) -> float:
        return self.float("forgetting.review_boost", 0.8, low=0.0, high=10.0)

    @property
    def negative_fade_bonus(self) -> float:
        return self.float("forgetting.negative_fade_bonus", 0.12, low=0.0, high=0.8)

    @property
    def purge_archived(self) -> bool:
        return self.bool("forgetting.purge_archived", False)

    @property
    def purge_after_days(self) -> int:
        return self.int("forgetting.purge_after_days", 30, low=1, high=3650)

    @property
    def mood_enabled(self) -> bool:
        return self.bool("mood.enabled", True)

    @property
    def mood_inject(self) -> bool:
        return self.mood_enabled and self.bool("mood.inject_mood_hint", True)

    @property
    def mood_bias_strength(self) -> float:
        return self.float("mood.recall_bias_strength", 1.0, low=0.0, high=3.0)

    @property
    def mood_resonance(self) -> float:
        return self.float("mood.resonance_strength", 0.05, low=0.0, high=0.5)

    @property
    def glimmer_chance(self) -> float:
        return self.float("recall.glimmer_chance", 0.08, low=0.0, high=1.0)

    @property
    def reinforce_on_recall(self) -> bool:
        # 检索不等于强化，默认关闭
        return self.bool("recall.reinforce_on_recall", False)

    @property
    def capture_group_all(self) -> bool:
        return self.bool("group.capture_all_messages", True)

    @property
    def stardust_limit(self) -> int:
        return self.int("group.max_stardust_lines", 30, low=0, high=200)

    @property
    def min_stardust_chars(self) -> int:
        return self.int("group.min_line_chars", 4, low=0, high=200)

    @property
    def enable_recall_tool(self) -> bool:
        return self.bool("tools.enable_recall_tool", True)

    @property
    def enable_memorize_tool(self) -> bool:
        return self.bool("tools.enable_memorize_tool", False)

    @property
    def max_stars_per_scope(self) -> int:
        return self.int("general.max_stars_per_scope", 3000, low=10, high=100000)

    # ---- 记忆半衰期（第一性参数） ----------------------------------

    @property
    def base_half_life_days(self) -> float:
        """新写入经历的基准记忆半衰期 H_m（天）。"""
        return self.float("forgetting.base_half_life_days", 7.0, low=0.1, high=365.0)

    @property
    def min_half_life_days(self) -> float:
        return self.float("forgetting.min_half_life_days", 0.25, low=0.05, high=30.0)

    @property
    def max_half_life_days(self) -> float:
        return self.float("forgetting.max_half_life_days", 365.0, low=1.0, high=3650.0)

    @property
    def detail_half_life_ratio(self) -> float:
        """细节半衰期相对主干的默认比例（越小忘得越快）。"""
        return self.float("forgetting.detail_half_life_ratio", 0.45, low=0.05, high=1.0)

    @property
    def detail_half_life_min_days(self) -> float:
        return self.float("forgetting.detail_half_life_min_days", 0.2, low=0.05, high=30.0)

    @property
    def clear_threshold(self) -> float:
        """保持率 >= 该值视为"可靠"，可以当事实陈述。"""
        return self.float("forgetting.clear_threshold", 0.55, low=0.05, high=0.99)

    @property
    def vague_threshold(self) -> float:
        """保持率 >= 该值视为"模糊"，只能含糊其辞。"""
        vague = self.float("forgetting.vague_threshold", 0.20, low=0.001, high=0.95)
        return min(vague, self.clear_threshold * 0.9)

    @property
    def review_boost_days(self) -> float:
        """每次有效强化增加的半衰期（天）。"""
        return self.float("forgetting.review_boost_days", 2.0, low=0.0, high=60.0)

    # ---- 情绪独立半衰期 --------------------------------------------

    @property
    def emotion_enabled(self) -> bool:
        return self.bool("emotion.enabled", True)

    @property
    def emotion_base_half_life_days(self) -> float:
        """情绪半衰期的兜底值（未指定类型时使用）。"""
        return self.float("emotion.base_half_life_days", 2.0, low=0.05, high=365.0)

    @property
    def emotion_residual_floor(self) -> float:
        """残留强度低于该值时表现层可以忽略（原始记录仍保留）。"""
        return self.float("emotion.residual_floor", 0.002, low=0.0, high=0.5)

    @property
    def emotion_reactivate_boost(self) -> float:
        """重新激活时本轮临时放大情绪残留的比例（不改动原始强度）。"""
        return self.float("emotion.reactivate_boost", 0.5, low=0.0, high=3.0)

    @property
    def emotion_reinforce_enabled(self) -> bool:
        """是否允许在有明确新经历时强化旧记忆的情绪残留。"""
        return self.bool("emotion.reinforce_enabled", True)

    def emotion_half_life(self, emotion_type: str) -> float:
        """按情绪类型取半衰期（可逐项配置）。"""
        key = {
            "joy": "happy_days",
            "sadness": "sad_days",
            "anger": "anger_days",
            "disappointment": "disappointment_days",
            "gratitude": "gratitude_days",
            "trust": "trust_days",
            "fear": "fear_days",
            "surprise": "surprise_days",
            "calm": "calm_days",
        }.get(emotion_type, "")
        if not key:
            return self.emotion_base_half_life_days
        return self.float(f"emotion.{key}", self.emotion_base_half_life_days, low=0.05, high=3650.0)
