"""艾宾浩斯遗忘曲线引擎——经历如何逐渐变淡。

## 数学骨架（半衰期形式）

一条经历（主干）的当前保留程度：

    R(t) = 2^(-t / H_m)        等价于 exp(-t / S)，其中 H_m = S · ln2

- ``t``：距**记忆锚点**的天数。锚点 = 最近一次**有效强化**时间；
  没有强化过则取事件发生时间；再没有则取记录创建时间。
- ``H_m``：这段经历的半衰期。**不同经历可以有不同的半衰期**——
  重要程度、当时的情绪强度都会在写入时折算进 H_m，之后只有强化才会让它变长。

举例：H_m = 7 天且此后没有强化时，第 0/7/14/21 天的保留程度分别是
1.0 / 0.5 / 0.25 / 0.125。

> 说明：艾宾浩斯遗忘曲线是记忆研究的经典模型，这里采用的是**可调整的工程近似**，
> 单一指数函数并不能精确模拟全部人类记忆。

## 细节也有自己的曲线

同一个事件的不同细节可以有不同的 H_m（见 ``detail_half_life_for``）。
角色可能还记得"拿到过奖励"，却已经想不起那是什么口味——
**数据库里还存着 ≠ 角色现在清楚地记得**。

## 情绪不归这里管

情绪有自己独立的半衰期，见 ``core/emotion.py``。本模块不读写任何情绪状态。

## 检索 ≠ 强化

- 检索（recall）：只是被找到，**不改变**任何遗忘状态，只增加计数器；
- 强化（reinforce）：必须是被"真正想起"或有新经历印证时才发生，
  会让 H_m 变长并把锚点推到当前时刻。

## 拟人化的生命周期

- R < fade_threshold   ：明星 -> 暗星（"有点想不起来了"）
- R < forget_threshold ：暗星 -> 熄灭归档（除非被 pin 珍藏）
- 珍藏星（pinned）的 R 永远不低于 ``pin_floor``。
"""

from __future__ import annotations

import math
import random
from dataclasses import dataclass

from .models import CLARITY_CLEAR, CLARITY_FAINT, CLARITY_UNKNOWN, CLARITY_VAGUE
from .models import MemoryStatus, Mood, Star

LN2 = math.log(2.0)

_EPS_DAYS = 1.0 / 86400.0  # 防止除零的最小间隔（秒 -> 天）


@dataclass(frozen=True)
class EbbinghausParams:
    """遗忘曲线的全部可调参数（来自插件配置）。"""

    # ---- 记忆半衰期 ------------------------------------------------
    base_half_life_days: float = 7.0      # 基准半衰期（天）
    min_half_life_days: float = 0.25
    max_half_life_days: float = 365.0
    importance_base: float = 0.6         # H_m = base × (importance_base + importance_span × importance)
    importance_span: float = 1.4
    emotion_gain: float = 0.6            # 情绪越浓烈，半衰期越长（写入时一次性折算）
    # ---- 细节 ------------------------------------------------------
    detail_half_life_ratio: float = 0.45  # 细节默认比主干遗忘更快
    detail_half_life_min_days: float = 0.2
    # ---- 阈值 ------------------------------------------------------
    fade_threshold: float = 0.18
    forget_threshold: float = 0.05
    clear_threshold: float = 0.55        # R >= 该值：可靠，可当事实陈述
    vague_threshold: float = 0.20        # R >= 该值：模糊，只能含糊其辞
    # ---- 强化 ------------------------------------------------------
    review_boost_days: float = 2.0       # 每次有效强化增加的半衰期（天）
    review_spacing_bonus: float = 0.6    # 间隔效应：越接近半衰期时想起，收益越大
    # ---- 其他 ------------------------------------------------------
    negative_fade_bonus: float = 0.12    # 心情好时放下不开心琐事的额外折旧
    glimmer_chance: float = 0.08
    pin_floor: float = 0.5               # 珍藏星的亮度下限


# ---------------------------------------------------------------------------
# 形式换算与基础曲线
# ---------------------------------------------------------------------------


def half_life_to_stability(half_life_days: float) -> float:
    """S = H_m / ln2（两种形式等价）。"""
    return max(1e-6, float(half_life_days or 0.0) / LN2)


def stability_to_half_life(stability: float) -> float:
    """H_m = S · ln2。"""
    return max(0.0, float(stability or 0.0) * LN2)


def retention_from_half_life(elapsed_days: float, half_life_days: float) -> float:
    """``R = 2^(-t/H_m)``，结果恒在 [0, 1]。

    - 负的时间差按 0 处理；
    - ``half_life_days <= 0`` 视为已经忘光（返回 0.0），不抛异常。
    """
    if half_life_days is None or half_life_days <= 0:
        return 0.0
    dt = max(0.0, float(elapsed_days))
    try:
        value = 2.0 ** (-dt / float(half_life_days))
    except (OverflowError, ValueError):
        return 0.0
    return max(0.0, min(1.0, value))


def memory_anchor(star: Star) -> float:
    """遗忘曲线的锚点：最近一次有效强化 > 事件发生时间 > 记录创建时间。"""
    return star.last_reinforced_at or star.event_time or star.created_at or 0.0


def star_half_life(star: Star) -> float:
    """读取星星的半衰期（兼容旧数据：没有就由 stability 换算）。"""
    if star.half_life_days and star.half_life_days > 0:
        return float(star.half_life_days)
    return stability_to_half_life(star.stability)


def emotional_intensity(star: Star) -> float:
    """写入时情绪光晕的浓烈程度（0~1），用于折算初始半衰期。"""
    return max(abs(float(star.valence or 0.0)), float(star.arousal or 0.0))


def half_life_for_new_memory(
    importance: float,
    emotion_intensity: float = 0.0,
    params: EbbinghausParams | None = None,
) -> float:
    """为**新写入**的经历计算初始半衰期。

    重要、情绪浓烈的瞬间天然记得更牢——但这是**写入时一次性**的折算，
    之后 H_m 只会被强化抬高，不会随时间自己变。
    """
    params = params or EbbinghausParams()
    imp = max(0.0, min(1.0, float(importance)))
    emo = max(0.0, min(1.0, float(emotion_intensity)))
    h = (
        params.base_half_life_days
        * (params.importance_base + params.importance_span * imp)
        * (1.0 + params.emotion_gain * emo)
    )
    return max(params.min_half_life_days, min(params.max_half_life_days, h))


def detail_half_life_for(
    trunk_half_life: float,
    detail_type: str = "detail",
    params: EbbinghausParams | None = None,
) -> float:
    """细节的半衰期：默认比主干短（原话略长一点）。"""
    params = params or EbbinghausParams()
    trunk = max(params.min_half_life_days, float(trunk_half_life or params.base_half_life_days))
    ratio = params.detail_half_life_ratio
    if detail_type == "quote":
        ratio = min(1.0, ratio * 1.25)
    h = trunk * ratio
    return max(params.detail_half_life_min_days, min(trunk, h))


# ---------------------------------------------------------------------------
# 保持率与清晰度
# ---------------------------------------------------------------------------


def retention(star: Star, now: float, params: EbbinghausParams) -> float:
    """当前保持率 R ∈ [0,1]，即这棵星星的亮度。"""
    dt = max(0.0, (now - memory_anchor(star)) / 86400.0)
    r = retention_from_half_life(dt, star_half_life(star))
    if star.pinned:
        r = max(r, params.pin_floor)
    return r


def detail_retention(detail: Any, now: float, params: EbbinghausParams) -> float:
    """单个细节的保持率（拥有自己的锚点与半衰期）。"""
    anchor = detail.last_reinforced_at or detail.created_at or 0.0
    dt = max(0.0, (now - anchor) / 86400.0)
    return retention_from_half_life(dt, detail.half_life_days)


def clarity_of(retention_value: float, params: EbbinghausParams) -> str:
    """把保持率映射成回忆清晰度分级。

    - ``clear``   可靠：可以当作事实陈述
    - ``vague``   模糊：只能含糊其辞
    - ``faint``   几乎不记得
    - ``unknown`` 无法可靠回忆
    """
    r = max(0.0, min(1.0, float(retention_value or 0.0)))
    if r >= params.clear_threshold:
        return CLARITY_CLEAR
    if r >= params.vague_threshold:
        return CLARITY_VAGUE
    if r > 0.0:
        return CLARITY_FAINT
    return CLARITY_UNKNOWN


# ---------------------------------------------------------------------------
# 召回阶段的可见度
# ---------------------------------------------------------------------------


def visibility(
    star: Star,
    now: float,
    params: EbbinghausParams,
    mood: Mood | None = None,
    bias_strength: float = 0.0,
    rng: random.Random | None = None,
) -> tuple[float, bool]:
    """召回时星星的可见度乘子与是否触发"灵光一现"。

    返回 (multiplier, glimmer)。multiplier 会乘在检索相似度上。
    """
    rng = rng or random.random
    r = retention(star, now, params)
    # 亮度对可召回性的影响是亚线性的：想不起来的事并非彻底消失
    mult = 0.35 + 0.65 * (r ** 0.45)

    glimmer = False
    if star.status == MemoryStatus.FADED.value:
        mult *= 0.4
        # 灵光一现：情绪浓烈或重要的暗星，有小概率突然清晰
        emotional = emotional_intensity(star)
        chance = params.glimmer_chance * (0.3 + emotional + star.importance)
        if rng() < min(chance, 0.6):
            glimmer = True
            mult = max(mult, 0.95)

    # 心境一致性：和现在心情"同频"的回忆更容易浮现，反频的则稍稍沉底
    if mood is not None and bias_strength > 0:
        product = mood.valence * star.valence
        if product > 0.10:
            mult *= 1.0 + 0.15 * bias_strength
        elif product < -0.10:
            mult *= max(0.6, 1.0 - 0.08 * bias_strength)

    return mult, glimmer


# ---------------------------------------------------------------------------
# 强化（真正的"想起来"）
# ---------------------------------------------------------------------------


def reinforced_half_life(
    star: Star,
    now: float,
    params: EbbinghausParams,
) -> float:
    """计算一次**有效强化**后的新半衰期（不修改传入对象）。

    间隔效应：距上次想起越久（尤其是刚好在快要忘记时），
    巩固收益越大——和间隔重复的经典结论一致。
    """
    h = star_half_life(star)
    dt = max(0.0, (now - memory_anchor(star)) / 86400.0)
    importance = max(0.0, min(1.0, star.importance))
    spacing = min(1.0, dt / max(_EPS_DAYS, h))
    gain = (
        params.review_boost_days
        * (0.6 + 0.8 * importance)
        * (1.0 + params.review_spacing_bonus * spacing)
    )
    new_h = h + gain
    return max(params.min_half_life_days, min(params.max_half_life_days, new_h))


def reinforcement(star: Star, now: float, params: EbbinghausParams) -> float:
    """兼容接口：返回强化后的**稳定度 S**（= H_m / ln2）。"""
    return half_life_to_stability(reinforced_half_life(star, now, params))


# ---------------------------------------------------------------------------
# 每日维护
# ---------------------------------------------------------------------------


def maintenance_update(
    star: Star,
    now: float,
    params: EbbinghausParams,
    mood: Mood | None = None,
    rng: random.Random | None = None,
) -> tuple[str, float]:
    """每日维护：返回 (新状态, 新半衰期天数)。

    只更新状态与半衰度，**不触碰** last_reinforced_at / event_time——
    保留率由真实时间差自然算出来。
    """
    rng = rng or random.Random()
    half_life = star_half_life(star)
    status = star.status

    # ---- 心情参与的拟人化调整 -------------------------------------
    if mood is not None and not star.pinned:
        if mood.valence > 0.25:
            if star.valence < -0.15 and star.importance < 0.35:
                # 心情好时，把不愉快又不重要的琐碎放下
                half_life *= 1.0 - params.negative_fade_bonus
            elif star.valence > 0.30:
                # 愉快的回忆被回味，轻微加固
                half_life = min(params.max_half_life_days, half_life * 1.02)

    half_life = max(params.min_half_life_days, half_life)

    # ---- 生命周期流转 ---------------------------------------------
    if star.pinned:
        status = MemoryStatus.ACTIVE.value
    else:
        r = retention(star, now, params)
        if r < params.forget_threshold:
            status = MemoryStatus.ARCHIVED.value
        elif r < params.fade_threshold:
            status = MemoryStatus.FADED.value
        else:
            status = MemoryStatus.ACTIVE.value

    return status, half_life
