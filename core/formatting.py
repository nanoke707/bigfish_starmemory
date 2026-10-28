"""格式化：把召回结果与心绪渲染成注入文本 / 命令回显。

注入块的设计目标：让 LLM 自然地把旧事当作"自己想起来的"来使用，
而不是复述一个检索结果。

**关键设计：按回忆清晰度分级表达。**

数据库里还存着 ≠ 角色现在清楚地记得。所以每条注入都要区分：

============  ==========================================
``clear``     可靠——可以当作事实陈述
``vague``     模糊——只能含糊其辞（"好像…吧"）
``faint``     几乎不记得——可以提"好像有过"
``unknown``   无法可靠回忆——**不注入**，更不能断言
============  ==========================================

情绪残留则**独立**于记忆清晰度呈现：记得清楚的事，情绪可能早已消退；
记忆模糊的事，情绪可能还留着一点。
"""

from __future__ import annotations

import time
from datetime import datetime

from .emotion import describe_emotions
from .models import CLARITY_CLEAR, CLARITY_FAINT, CLARITY_UNKNOWN, CLARITY_VAGUE
from .models import Mood, ScoredStar
from .text import truncate_line

HEADER = "〖星空记忆〗以下是你在过去的对话里凝下的星星，此刻被夜风轻轻吹亮。"
FOOTER = (
    "（想起这些时请自然一点：像自己回忆起来的那样使用它们，不要罗列，"
    "也不要提到任何\"记忆\"\"系统\"之类的字眼。"
    "标注了「不太确定」的内容只能含糊地说，别当成确定的事实；情绪残留只是隐约的感觉，不必每次都表达出来）"
)

# 亮度图标：5 档
_BRIGHT_ICONS = ("✧", "✧✧", "✧✧✧", "★✧✧", "★★✧", "★★★")

# 清晰度 -> 注入时的措辞
_CLARITY_TAG = {
    CLARITY_CLEAR: "",
    CLARITY_VAGUE: "（记得不太清）",
    CLARITY_FAINT: "（只剩一点印象）",
    CLARITY_UNKNOWN: "",
}


def _bright_icon(retention: float) -> str:
    level = max(0, min(5, int(round(retention * 5))))
    return _BRIGHT_ICONS[level]


def _emotion_hint(valence: float, arousal: float) -> str:
    if valence > 0.45:
        base = "带着温暖明亮的光"
    elif valence > 0.1:
        base = "微微发亮，有些愉快"
    elif valence > -0.1:
        base = "安安静静"
    elif valence > -0.45:
        base = "泛着一点黯淡的蓝"
    else:
        base = "像一颗湿漉漉的星，想起来会有点沉"
    if arousal > 0.7:
        base += "（当时情绪很强烈）"
    return base


def _fmt_time(ts: float) -> str:
    try:
        return datetime.fromtimestamp(ts).strftime("%Y-%m-%d")
    except (OverflowError, OSError, ValueError):
        return "很久以前"


def _detail_line(state: dict) -> str:
    """渲染单条细节；无法可靠回忆的细节直接不出现。"""
    clarity = state.get("clarity") or CLARITY_UNKNOWN
    text = truncate_line(str(state.get("text") or ""), 60)
    if not text:
        return ""
    if clarity == CLARITY_CLEAR:
        return f"↳ {text}"
    if clarity == CLARITY_VAGUE:
        return f"↳ {text}（好像是这么回事，不太确定）"
    if clarity == CLARITY_FAINT:
        return f"↳ {text}（只剩一点印象，具体的已经想不起了）"
    return ""


def format_star_line(scored: ScoredStar) -> str:
    """把一颗星星渲染成注入行（含清晰度标记、可靠细节、情绪残留）。"""
    star = scored.star
    clarity = scored.clarity or CLARITY_CLEAR
    if clarity == CLARITY_UNKNOWN:
        return ""

    icon = _bright_icon(scored.retention)
    time_label = scored.event_time_label or _fmt_time(star.event_time or star.created_at)
    tag = _CLARITY_TAG.get(clarity, "")
    lines = [f"{icon} [{time_label}] {truncate_line(star.content, 120)}{tag}"]

    # 细节：只呈现可靠与模糊两级，无法可靠回忆的不给
    for state in scored.detail_states or []:
        line = _detail_line(state)
        if line:
            lines.append("   " + line)

    # 情绪残留：与记忆清晰度独立计算
    emotion_text = describe_emotions(scored.emotion_states or [])
    if emotion_text:
        lines.append(f"   ↳ 情绪：{emotion_text}")
    elif star.valence != 0.0:
        lines.append(f"   ↳ 情绪：{_emotion_hint(star.valence, star.arousal)}")

    return "\n".join(lines)


def format_injection(
    scored_stars: list[ScoredStar],
    mood_desc: str,
    include_mood: bool = True,
    max_chars: int = 0,
) -> str:
    """渲染注入块。stars 为空且无心情注入时返回空串；max_chars>0 时按预算裁剪星星块。"""
    lines: list[str] = []
    blocks: list[str] = []
    for scored in scored_stars:
        block = format_star_line(scored)
        if block:
            blocks.append(block)
    if blocks:
        lines.append(HEADER)
        used = len(HEADER) + len(FOOTER) + (len(mood_desc) + 20 if include_mood else 0)
        for block in blocks:
            if max_chars > 0 and used + len(block) > max_chars:
                continue
            lines.append(block)
            used += len(block)
        if len(lines) > 1:
            lines.append(FOOTER)
        else:
            lines = []
    if include_mood and mood_desc:
        lines.append(f"〖此刻心绪〗{mood_desc}（让它自然地融进你的语气，不要直接复述这行字）")
    return "\n".join(lines)


def format_star_detail(scored: ScoredStar, now: float | None = None) -> str:
    """命令回显用的详细信息。"""
    now = time.time() if now is None else now
    star = scored.star
    status_icon = {"active": "★", "faded": "✧", "archived": "·"}.get(star.status, "·")
    tags = " ".join(f"#{t}" for t in star.tags[:6])
    pin = " 📌" if star.pinned else ""
    corrected = " ⚠️已被纠正" if star.corrected else ""
    half_life = star.half_life_days or 0.0
    lines = [
        f"{status_icon} #{star.id}{pin} 亮度{int(round(scored.retention * 100))}% | "
        f"半衰期{half_life:.1f}天 | 重要度{star.importance:.2f} | "
        f"事件{scored.event_time_label or _fmt_time(star.event_time or star.created_at)} | "
        f"{star.memory_type}{corrected}",
        f"  {truncate_line(star.content, 160)}",
    ]
    if tags:
        lines.append(f"  {tags}")
    for state in scored.detail_states or []:
        clarity = state.get("clarity") or CLARITY_UNKNOWN
        mark = {"clear": "清楚", "vague": "模糊", "faint": "几乎不记得"}.get(clarity, "不可靠")
        lines.append(
            f"  ↳ [{mark}] {truncate_line(str(state.get('text') or ''), 80)}"
            f"（半衰期{float(state.get('half_life_days') or 0):.1f}天）"
        )
    for st in scored.emotion_states or []:
        lines.append(
            f"  ↳ 情绪 {st.label}：原始 {st.original_intensity:.2f} → 残留 {st.residual:.3f}"
            f"（半衰期{st.half_life_days:.1f}天）"
        )
    return "\n".join(lines)


def mood_banner(mood: Mood) -> str:
    """状态页的心绪横幅。"""
    bar_len = 10

    def bar(value: float, low: float, high: float) -> str:
        span = high - low
        ratio = max(0.0, min(1.0, (value - low) / span if span else 0.0))
        filled = int(round(ratio * bar_len))
        return "●" * filled + "○" * (bar_len - filled)

    return (
        f"愉悦 {bar(mood.valence, -1, 1)} {mood.valence:+.2f}\n"
        f"激动 {bar(mood.arousal, 0, 1)} {mood.arousal:.2f}\n"
        f"好感 {bar(mood.affection, 0, 1)} {mood.affection:.2f}"
    )
