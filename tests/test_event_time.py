"""事件时间的正确性测试。

覆盖三件事：

1. **标签必须按真实年龄渲染**——精度只表示"多确定"，不表示"多旧"。
   （回归：approximate 档曾把 1 天前的事写成"大约一个月前"。）
2. **绝对时间解析要稳**——"YYYY-MM-DD HH:MM" 及各种中文/ISO 变体，
   且不受锚点影响。
3. **相对说法要锚定到对话时间**——三天前的对话里的"昨天"是四天前。
"""

from __future__ import annotations

import time
from datetime import datetime, timedelta

from core import ebbinghaus
from core import engine as engine_mod
from core import prompts, timeline

DAY = 86400.0


def _ts(days_ago: float = 0.0, *, hour: int = 12, minute: int = 0) -> float:
    """n 天前的某个时刻（本地时区）。"""
    dt = datetime.now().replace(hour=hour, minute=minute, second=0, microsecond=0)
    return (dt - timedelta(days=days_ago)).timestamp()


# ---------------------------------------------------------------------------
# 1) 标签渲染
# ---------------------------------------------------------------------------


class TestFormatEventTime:
    def test_approximate_recent_is_not_a_month_ago(self):
        """回归：一天前 / 今天的 approximate 时间不能被写成"大约一个月前"。"""
        now = time.time()
        assert timeline.format_event_time(_ts(0), "approximate", now) == "今天"
        assert timeline.format_event_time(_ts(1), "approximate", now) == "昨天"
        assert timeline.format_event_time(_ts(3), "approximate", now) == "大约 3 天前"

    def test_approximate_scales_with_real_age(self):
        now = time.time()
        assert timeline.format_event_time(_ts(40), "approximate", now) == "大约一个月前"
        assert timeline.format_event_time(_ts(100), "approximate", now) == "大约 3 个月前"
        assert timeline.format_event_time(_ts(400), "approximate", now) == "大约 1 年前"

    def test_day_precision(self):
        now = time.time()
        assert timeline.format_event_time(_ts(0), "day", now) == "今天"
        assert timeline.format_event_time(_ts(1), "day", now) == "昨天"
        assert timeline.format_event_time(_ts(5), "day", now) == "5 天前"
        # 超过 30 天给出具体日期
        assert timeline.format_event_time(_ts(60), "day", now) == time.strftime(
            "%Y-%m-%d", time.localtime(_ts(60))
        )

    def test_exact_precision_shows_full_timestamp(self):
        now = time.time()
        ts = _ts(0, hour=15, minute=47)
        assert timeline.format_event_time(ts, "exact", now) == time.strftime(
            "%Y-%m-%d %H:%M", time.localtime(ts)
        )

    def test_unknown_and_missing(self):
        assert timeline.format_event_time(None, "unknown") == "时间不详"
        assert timeline.format_event_time(0, "unknown") == "时间不详"

    def test_future_timestamp_does_not_go_negative(self):
        """未来时间不能渲染成负天数，要说成"将来"。"""
        now = time.time()
        assert timeline.format_event_time(now + 1 * DAY, "day", now) == "明天"
        assert timeline.format_event_time(now + 10 * DAY, "day", now) == "10 天后"
        assert timeline.format_event_time(now + 90 * DAY, "day", now) == "3 个月后"
        assert timeline.format_event_time(now + 400 * DAY, "day", now) == "1 年后"

    def test_exact_future_shows_absolute_date(self):
        now = time.time()
        ts = now + 30 * DAY
        assert timeline.format_event_time(ts, "exact", now) == time.strftime(
            "%Y-%m-%d %H:%M", time.localtime(ts)
        )


# ---------------------------------------------------------------------------
# 2) 绝对时间解析
# ---------------------------------------------------------------------------


class TestAbsoluteParsing:
    def test_iso_datetime(self):
        now = time.time()
        ts, prec, src = timeline.parse_event_time("2026-05-01 14:30", now=now)
        assert prec == "exact" and src == "stated"
        assert time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) == "2026-05-01 14:30"

    def test_iso_with_t_separator(self):
        ts, prec, _ = timeline.parse_event_time("2026-05-01T14:30")
        assert prec == "exact"
        assert time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) == "2026-05-01 14:30"

    def test_chinese_datetime(self):
        ts, prec, _ = timeline.parse_event_time("2026年5月1日 14点30分")
        assert prec == "exact"
        assert time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) == "2026-05-01 14:30"

    def test_slash_date(self):
        ts, prec, _ = timeline.parse_event_time("2026/5/1")
        assert prec == "day"
        assert time.strftime("%Y-%m-%d", time.localtime(ts)) == "2026-05-01"

    def test_month_day_only_uses_current_year(self):
        now = time.time()
        ts, prec, _ = timeline.parse_event_time("5月1日", now=now)
        assert prec == "day"
        assert time.strftime("%Y-%m-%d", time.localtime(ts)) == f"{now and datetime.now().year}-05-01"

    def test_month_day_in_future_falls_back_to_last_year(self):
        """只给月日时取"最近一次"；落在未来就退到去年。"""
        now = datetime.now().replace(month=3, day=2).timestamp()
        ts, prec, _ = timeline.parse_event_time("5月1日", now=now)
        assert prec == "day"
        assert datetime.fromtimestamp(ts).year == datetime.fromtimestamp(now).year - 1

    def test_absolute_is_independent_of_anchor(self):
        """绝对时间不受锚点影响：同一串文字在任何锚点下都解析成同一时刻。"""
        a = timeline.parse_event_time("2026-05-01 14:30", now=time.time())[0]
        b = timeline.parse_event_time("2026-05-01 14:30", now=time.time() - 400 * DAY)[0]
        assert a == b

    def test_garbage_is_unknown(self):
        ts, prec, src = timeline.parse_event_time("2026-13-45")
        assert ts is None and prec == "unknown" and src == "unknown"


# ---------------------------------------------------------------------------
# 3) 锚点：相对说法按对话时间换算
# ---------------------------------------------------------------------------


class TestAnchor:
    def test_relative_uses_anchor_not_wallclock(self):
        """三天前的对话里说"昨天" -> 那个对话的"前一天"，不是墙钟的昨天。"""
        anchor_dt = datetime.now().replace(hour=15, minute=47, second=0, microsecond=0)
        anchor = (anchor_dt - timedelta(days=3)).timestamp()
        ts, prec, _ = timeline.parse_event_time("昨天", now=anchor)
        assert prec == "day"
        # "昨天"取的是前一天 00:00（按自然日），所以落在锚点所在日的前一天
        got = datetime.fromtimestamp(ts)
        want = (anchor_dt - timedelta(days=3)).replace(hour=0, minute=0, second=0, microsecond=0)
        want = want - timedelta(days=1)
        assert got.date() == want.date()

    def test_transcript_reference_ts_picks_newest(self):
        lines = [
            "[2026-10-25 21:03] 用户：昨天我们去了公园",
            "[2026-10-28 15:47] Bot：好呀",
        ]
        ts = engine_mod._transcript_reference_ts(lines)
        assert ts is not None
        assert time.strftime("%Y-%m-%d %H:%M", time.localtime(ts)) == "2026-10-28 15:47"

    def test_transcript_reference_ts_none_when_no_timestamps(self):
        assert engine_mod._transcript_reference_ts(["没有时间戳的行"]) is None
        assert engine_mod._transcript_reference_ts([]) is None

    def test_old_format_timestamp_is_ignored(self):
        """旧格式 [10-01 10:00] 没有年份，不能当成锚点（否则会认错年份）。"""
        assert engine_mod._transcript_reference_ts(["[10-01 10:00] 用户：hi"]) is None


# ---------------------------------------------------------------------------
# 4) 提示词：要求输出绝对时间
# ---------------------------------------------------------------------------


class TestPrompt:
    def test_prompt_asks_for_absolute_datetime(self):
        system = prompts.EXTRACTION_SYSTEM
        assert "YYYY-MM-DD HH:MM" in system
        assert "时间戳" in system

    def test_prompt_example_uses_absolute_time(self):
        assert '"event_time": "2026-05-01 14:30"' in prompts.EXTRACTION_SYSTEM
        # 示例里不能再出现"上周三"这种相对写法
        assert '"event_time": "上周三"' not in prompts.EXTRACTION_SYSTEM


# ---------------------------------------------------------------------------
# 5) 遗忘锚点：不能落在未来
# ---------------------------------------------------------------------------


class TestAnchorNotInFuture:
    def _star(self, **kw):
        from core.models import Star

        base = dict(
            id=1, scope="s1", content="x", content_hash="h", tags=[], memory_type="fact",
            importance=0.5, valence=0.0, arousal=0.2, half_life_days=10.0, stability=1.0,
            created_at=time.time(), pinned=False, status="active",
        )
        base.update(kw)
        return Star(**base)

    def test_future_event_time_is_not_the_anchor(self):
        """未来的事件时间不能当锚点，否则这条记忆永远不会变暗。"""
        now = time.time()
        star = self._star(event_time=now + 30 * DAY, last_reinforced_at=now + 30 * DAY)
        assert ebbinghaus.memory_anchor(star, now) <= now

    def test_past_event_time_is_the_anchor(self):
        now = time.time()
        star = self._star(event_time=now - 5 * DAY, last_reinforced_at=now - 5 * DAY)
        assert abs(ebbinghaus.memory_anchor(star, now) - (now - 5 * DAY)) < 1

    def test_future_event_memory_still_fades(self):
        now = time.time()
        star = self._star(event_time=now + 30 * DAY, last_reinforced_at=now + 30 * DAY)
        r = ebbinghaus.retention(star, now + 10 * DAY, ebbinghaus.EbbinghausParams())
        assert r < 1.0
