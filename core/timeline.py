"""事件时间解析：把对话里出现的"事情发生时间"解析成时间戳。

**为什么需要它**：系统写入记忆的时刻（``created_at``）和事件真正发生的
时刻（``event_time``）是两回事。用户说"上周我弄丢了伞"，如果把"现在"
当作事件时间，这条记忆的衰减起点就错了——它应该从"上周"开始淡忘。

本模块只做**解析**，不做编造：解析不出来就返回 ``None``，
由调用方把时间精度标记为 ``unknown``。宁可承认不知道，也不填一个假时间。

支持的写法（中文为主，兼顾英文）：

- 绝对时间：``2024-05-01`` / ``2024/5/1`` / ``2024年5月1日`` / ``2024-05-01 14:30``
  / ``2024-05-01T14:30`` / ``5月1日``（只给月日时按当前年份算，落在未来就退一年）
- 相对今天：``今天`` / ``昨天`` / ``前天`` / ``大前天``
- 相对偏移：``3天前`` / ``两天前`` / ``一周前`` / ``半小时前`` / ``10分钟前``
- 星期：``上周三`` / ``本周五`` / ``星期二``
- 粗粒度：``上个月`` / ``去年`` / ``前阵子``（只能定位到月/年的起点）
- 英文：``yesterday`` / ``3 days ago`` / ``last Monday``

**锚点（anchor）**：相对说法必须相对于**这段对话发生的时间**换算，而不是相对于
"现在"。一段三天前的对话里说"昨天"，指的是三天前的前一天。因此调用方应把对话
时间作为 ``now`` 传进来（见 :func:`parse_event_time`）；绝对时间不受锚点影响。
"""

from __future__ import annotations

import re
import time
from datetime import datetime, timedelta

# 时间精度
PRECISION_EXACT = "exact"          # 精确到分/秒
PRECISION_DAY = "day"              # 精确到天
PRECISION_APPROX = "approximate"   # 只能定位到大致时段
PRECISION_UNKNOWN = "unknown"      # 无法确定

# 时间来源
SOURCE_STATED = "stated"           # 对话中明确提到
SOURCE_INFERRED = "inferred"       # 由"昨天/上周"等相对词推断
SOURCE_UNKNOWN = "unknown"

_CN_NUM = {
    "零": 0, "一": 1, "两": 2, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6,
    "七": 7, "八": 8, "九": 9, "十": 10, "十一": 11, "十二": 12, "两半": 0,
}

_WEEKDAY_CN = {
    "一": 0, "二": 1, "三": 2, "四": 3, "五": 4, "六": 5, "日": 6, "天": 6,
}


def _cn_number(text: str) -> int | None:
    """把中文数字转成 int（支持 1~99 的常见写法）。"""
    text = (text or "").strip()
    if not text:
        return None
    if text.isdigit():
        return int(text)
    if text in _CN_NUM:
        return _CN_NUM[text]
    if text.startswith("十"):
        rest = text[1:]
        if not rest:
            return 10
        if len(rest) == 1 and rest in _CN_NUM:
            return 10 + _CN_NUM[rest]
    if len(text) == 3 and text[1] == "十":
        a, b = text[0], text[2]
        if a in _CN_NUM and b in _CN_NUM:
            return _CN_NUM[a] * 10 + _CN_NUM[b]
    if len(text) == 2 and text[0] in _CN_NUM and text[1] in _CN_NUM:
        return _CN_NUM[text[0]] * 10 + _CN_NUM[text[1]]
    return None


def _start_of_day(dt: datetime) -> datetime:
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def _to_ts(dt: datetime) -> float:
    return dt.timestamp()


# 带年份的绝对时间：2024-05-01 / 2024/5/1 / 2024年5月1日 / 2024-05-01 14:30 / 2024-05-01T14:30
_ABS_DATETIME_RE = re.compile(
    r"(\d{4})\s*[-/.年]\s*(\d{1,2})\s*[-/.月]\s*(\d{1,2})\s*[日号]?"
    r"(?:\s*[T\s]?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?)?"
)
# 只给月日：5月1日 / 5月1日 14:30
_ABS_MONTH_DAY_RE = re.compile(
    r"(?<!\d)(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]?"
    r"(?:\s*[T\s]?\s*(\d{1,2})\s*[:：点时]\s*(\d{1,2})?)?"
)


def _make_datetime(
    year: int, month: int, day: int, hour: int | None, minute: int | None
) -> datetime | None:
    """组装一个本地时区的 datetime；非法日期返回 None。"""
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return None
    if hour is not None and not (0 <= hour <= 23):
        hour = None
    if minute is not None and not (0 <= minute <= 59):
        minute = None
    try:
        return datetime(year, month, day, hour if hour is not None else 12,
                        minute if minute is not None else 0)
    except ValueError:
        return None


def _parse_absolute(
    text: str, base: datetime, now: float
) -> tuple[float, str, str] | None:
    """解析绝对时间。解析不出来返回 None。

    只给月日时按 ``base`` 所在年份补全；如果补出来落在未来，说明说的是去年。
    """
    m = _ABS_DATETIME_RE.search(text)
    if m:
        dt = _make_datetime(
            int(m.group(1)), int(m.group(2)), int(m.group(3)),
            int(m.group(4)) if m.group(4) else None,
            int(m.group(5)) if m.group(5) else None,
        )
        if dt is None:
            return None
        precision = PRECISION_EXACT if m.group(4) else PRECISION_DAY
        source = SOURCE_STATED
        # 未来的日期多半是口误/相对表达，视为不确定
        if dt.timestamp() > now + 86400:
            precision = PRECISION_APPROX
        return _to_ts(dt), precision, source

    m = _ABS_MONTH_DAY_RE.search(text)
    if m:
        month, day = int(m.group(1)), int(m.group(2))
        hour = int(m.group(3)) if m.group(3) else None
        minute = int(m.group(4)) if m.group(4) else None
        dt = _make_datetime(base.year, month, day, hour, minute)
        if dt is None:
            return None
        if dt.timestamp() > now + 86400:
            # 只给月日却落在未来 —— 说的是去年
            dt = _make_datetime(base.year - 1, month, day, hour, minute)
            if dt is None:
                return None
        precision = PRECISION_EXACT if hour is not None else PRECISION_DAY
        return _to_ts(dt), precision, SOURCE_STATED

    return None


def parse_event_time(
    raw: str | None,
    now: float | None = None,
) -> tuple[float | None, str, str]:
    """解析事件时间。

    返回 ``(timestamp | None, precision, source)``。

    - 无法解析时返回 ``(None, PRECISION_UNKNOWN, SOURCE_UNKNOWN)``；
    - 永远不返回"现在"来冒充事件时间（除非原文明确写着"刚才/刚刚"）；
    - ``now`` 是**锚点**：相对说法（"昨天""三天前"）按它换算。调用方应传这段
      对话发生的时间，而不是墙钟时间——三天前的对话里的"昨天"是四天前。
      绝对时间（"2024-05-01 14:30"）不受锚点影响。
    """
    text = (raw or "").strip()
    if not text:
        return None, PRECISION_UNKNOWN, SOURCE_UNKNOWN

    now = time.time() if now is None else now
    base = datetime.fromtimestamp(now)

    # ---- 1) 绝对时间 ------------------------------------------------
    absolute = _parse_absolute(text, base, now)
    if absolute is not None:
        return absolute

    # ---- 2) 今天 / 昨天 / 前天 --------------------------------------
    if "大前天" in text:
        return _to_ts(_start_of_day(base) - timedelta(days=3)), PRECISION_DAY, SOURCE_INFERRED
    if "前天" in text:
        return _to_ts(_start_of_day(base) - timedelta(days=2)), PRECISION_DAY, SOURCE_INFERRED
    if "昨天" in text or "昨日" in text or re.search(r"\byesterday\b", text, re.I):
        return _to_ts(_start_of_day(base) - timedelta(days=1)), PRECISION_DAY, SOURCE_INFERRED
    if "今天" in text or "今日" in text or "今早" in text or "今晚" in text or re.search(r"\btoday\b", text, re.I):
        return _to_ts(_start_of_day(base)), PRECISION_DAY, SOURCE_INFERRED
    if "刚才" in text or "刚刚" in text or "刚" == text.strip()[-1:]:
        return now, PRECISION_EXACT, SOURCE_INFERRED

    # ---- 3) N 天/周/月/年前 -----------------------------------------
    m = re.search(r"(\d+|[一两二三四五六七八九十]+)\s*(天|日|周|星期|个月|月|年|小时|分钟)\s*(前|以前|之前)", text)
    if not m:
        m = re.search(r"(\d+)\s*(days?|weeks?|months?|years?|hours?|minutes?)\s+ago", text, re.I)
        if m:
            unit = m.group(2).lower()
            unit = {"days": "天", "day": "天", "weeks": "周", "week": "周",
                    "months": "个月", "month": "个月", "years": "年", "year": "年",
                    "hours": "小时", "hour": "小时",
                    "minutes": "分钟", "minute": "分钟"}[unit]
            m = re.match(r"(\d+)", m.group(1))
            if m:
                amount = int(m.group(1))
                return _relative(amount, unit, base)
    if m:
        amount = _cn_number(m.group(1))
        if amount is None:
            amount = 0
        unit = m.group(2)
        return _relative(amount, unit, base)

    # ---- 4) 星期几 --------------------------------------------------
    m = re.search(r"(上|本|这|下)?\s*(?:周|星期|礼拜)\s*([一二三四五六日天])", text)
    if m:
        prefix = m.group(1) or ""
        target = _WEEKDAY_CN.get(m.group(2))
        if target is not None:
            monday = _start_of_day(base) - timedelta(days=base.weekday())
            if prefix == "上":
                monday -= timedelta(days=7)
            elif prefix == "下":
                monday += timedelta(days=7)
            return _to_ts(monday + timedelta(days=target)), PRECISION_DAY, SOURCE_INFERRED

    # ---- 5) 粗粒度：上个月 / 去年 / 前阵子 --------------------------
    if "上个月" in text:
        first = (base.replace(day=1) - timedelta(days=1)).replace(day=1)
        return _to_ts(first), PRECISION_APPROX, SOURCE_INFERRED
    if "这个月" in text or "本月" in text:
        return _to_ts(base.replace(day=1)), PRECISION_APPROX, SOURCE_INFERRED
    if "去年" in text:
        return _to_ts(base.replace(year=base.year - 1, month=1, day=1, hour=0, minute=0)), PRECISION_APPROX, SOURCE_INFERRED
    if "今年" in text:
        return _to_ts(base.replace(month=1, day=1, hour=0, minute=0)), PRECISION_APPROX, SOURCE_INFERRED
    if "前阵子" in text or "前段时间" in text or "以前" in text or "那会儿" in text or "那阵子" in text:
        # 只能定位到"大约"
        return _to_ts(base - timedelta(days=30)), PRECISION_APPROX, SOURCE_INFERRED
    if "很久以前" in text or "小时候" in text or "童年" in text:
        return _to_ts(base - timedelta(days=365 * 5)), PRECISION_APPROX, SOURCE_INFERRED

    return None, PRECISION_UNKNOWN, SOURCE_UNKNOWN


def _relative(amount: int, unit: str, base: datetime) -> tuple[float, str, str]:
    """相对时间换算。"""
    if unit in ("天", "日"):
        dt = _start_of_day(base) - timedelta(days=amount)
    elif unit in ("周", "星期"):
        dt = _start_of_day(base) - timedelta(weeks=amount)
    elif unit == "个月":
        month = base.month - amount
        year = base.year
        while month <= 0:
            month += 12
            year -= 1
        dt = base.replace(year=year, month=month, day=1, hour=0, minute=0)
    elif unit == "年":
        dt = base.replace(year=base.year - amount, month=1, day=1, hour=0, minute=0)
    elif unit == "小时":
        dt = base - timedelta(hours=amount)
    elif unit == "分钟":
        dt = base - timedelta(minutes=amount)
    else:
        dt = base
    return _to_ts(dt), PRECISION_DAY, SOURCE_INFERRED


def format_event_time(
    ts: float | None,
    precision: str = PRECISION_UNKNOWN,
    now: float | None = None,
) -> str:
    """把事件时间渲染成人话（供 WebUI 与注入文本使用）。

    **一律显示绝对时间** ``YYYY-MM-DD HH:MM``。

    精度只表示"这个时间有多确定"，不表示"它有多旧"——两者都不该影响显示成什么。
    相对说法（"今天""大约一个月前"）让人没法自己核对，也正是把今天写成
    "一个月前"的那类 bug 的温床。所以显示一律用绝对时间；"多久以前"由
    ``days_since_anchor`` 这类字段去说。

    - 没有时间戳时返回"时间不详"；
    - 未来的时间同样显示绝对时间（它就是将来要发生的事）。
    """
    if not ts:
        return "时间不详"
    return datetime.fromtimestamp(ts).strftime("%Y-%m-%d %H:%M")
