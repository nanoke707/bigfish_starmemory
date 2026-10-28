"""WebUI 调试控制台的后端路由（AstrBot 插件拓展页 WebAPI）。

设计约束：
- core 包保持零 astrbot 依赖：本模块只输出"路由表"，
  由 main.py（适配层）负责真正的 context.register_web_api。
- handler 只依赖 path 参数（AstrBot 以 ``handler(**path_params)`` 方式调用），
  返回 ``{"status": "success", "data": ...}``，桥接 SDK 会自动解包 ``data``。
"""

from __future__ import annotations

import base64
import binascii
import inspect
import math
import time
from collections.abc import Awaitable, Callable
from typing import Any

from . import ebbinghaus, emotion as emotion_engine, mood as mood_engine, timeline
from .config import StarConfig
from .engine import StarMemoryEngine
from .models import MemoryStatus, Star

ROUTE_PREFIX = "/bigfish_starmemory/ui"

Handler = Callable[..., Awaitable[Any]]
Route = tuple[str, Handler, list[str], str]


class SettingsContext:
    """设置页的后端依赖：AstrBotConfig（带 schema 与 save_config）、热应用与提供商枚举。"""

    def __init__(
        self,
        config: Any,
        apply: Callable[[str], Awaitable[list[str]] | list[str]],
        providers: Callable[[], dict[str, list[dict[str, Any]]]],
    ):
        self.config = config
        self.apply = apply
        self.providers = providers

    # ---- schema 访问 ------------------------------------------------

    def _schema(self) -> dict[str, Any]:
        schema = getattr(self.config, "schema", None)
        return schema if isinstance(schema, dict) else {}

    def sections(self) -> list[tuple[str, dict[str, Any], dict[str, Any]]]:
        """[(节名, 节内 items, 节字段的 description)]，按 schema 顺序。"""
        result: list[tuple[str, dict[str, Any], dict[str, Any]]] = []
        for name, spec in self._schema().items():
            if not isinstance(spec, dict) or spec.get("type") != "object":
                continue
            items = spec.get("items")
            if not isinstance(items, dict):
                continue
            result.append((str(name), items, spec))
        return result

    def _field_spec(self, section: str, key: str) -> dict[str, Any] | None:
        for name, items, _spec in self.sections():
            if name == section and key in items and isinstance(items[key], dict):
                return items[key]
        return None

    def _raw_section(self, section: str) -> dict[str, Any]:
        value = self.config.get(section) if hasattr(self.config, "get") else None
        if value is None and isinstance(self.config, dict):
            value = self.config.get(section)
        return value if isinstance(value, dict) else {}

    # ---- 值读写 -----------------------------------------------------

    def get_value(self, section: str, key: str, spec: dict[str, Any]) -> Any:
        raw_section = self._raw_section(section)
        if key in raw_section:
            return raw_section[key]
        return spec.get("default")

    def set_value(self, section: str, key: str, value: Any) -> None:
        raw_section = self._raw_section(section)
        if not raw_section and isinstance(self.config, dict):
            self.config[section] = {}
            raw_section = self.config[section]
        raw_section[key] = value
        save = getattr(self.config, "save_config", None)
        if callable(save):
            save()

    def reset_section(self, section: str) -> int:
        count = 0
        for _name, items, _spec in self.sections():
            if _name != section:
                continue
            for key, spec in items.items():
                if isinstance(spec, dict) and spec.get("type") != "object":
                    self.set_value(section, key, spec.get("default"))
                    count += 1
        return count


def _b64url_decode(data: str) -> str:
    """base64url 解码（容忍缺省 padding），用于在 path 参数里安全传任意字符串。"""
    text = (data or "").strip()
    if not text:
        return ""
    padded = text.replace("-", "+").replace("_", "/")
    padded += "=" * (-len(padded) % 4)
    try:
        return base64.b64decode(padded.encode("ascii")).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError) as exc:
        raise ValueError("值不是合法的 base64url 编码") from exc


def _cast_by_schema(value_text: str, spec: dict[str, Any]) -> Any:
    """按 schema 类型转换字符串值；slider 存在时按 min/max 钳位。"""
    ftype = str(spec.get("type") or "string").lower()
    if ftype == "bool":
        return str(value_text).strip().lower() in ("1", "true", "yes", "on", "是")
    if ftype in ("int", "float"):
        try:
            num = float(value_text)
        except (TypeError, ValueError) as exc:
            raise ValueError(f"{value_text!r} 不是数字") from exc
        slider = spec.get("slider")
        if isinstance(slider, dict):
            try:
                num = max(float(slider.get("min", num)), min(float(slider.get("max", num)), num))
            except (TypeError, ValueError):
                pass
        return int(round(num)) if ftype == "int" else round(num, 6)
    if ftype == "string":
        text = str(value_text)
        options = spec.get("options")
        if isinstance(options, list) and options and text not in options:
            raise ValueError(f"{text!r} 不在允许的选项里")
        return text
    raise ValueError(f"不支持修改类型为 {ftype} 的字段")


def _ok(data: Any = None, **extra: Any) -> dict[str, Any]:
    payload = {"status": "success"}
    if data is not None:
        payload["data"] = data
    if extra:
        payload.update(extra)
    return payload


def _err(message: str) -> dict[str, Any]:
    return {"status": "error", "message": message}


def _parse_star_id(raw: str) -> int | None:
    try:
        return int(str(raw).strip())
    except (TypeError, ValueError):
        return None


def _status_filter(status: str) -> tuple[str, ...] | None:
    """把页面传入的状态转为存储层过滤；pinned 单独处理。"""
    status = (status or "all").strip().lower()
    if status in ("", "all"):
        return None
    if status == "pinned":
        return ("active", "faded", "archived")
    mapping = {
        "bright": ("active",),
        "active": ("active",),
        "faded": ("faded",),
        "dim": ("faded",),
        "archived": ("archived",),
        "gone": ("archived",),
    }
    return mapping.get(status)


def _star_card(star: Star, params: ebbinghaus.EbbinghausParams, now: float | None = None) -> dict[str, Any]:
    """星星卡片：把关键状态摊平给前端。"""
    now = now or time.time()
    r = ebbinghaus.retention(star, now, params)
    half_life = ebbinghaus.star_half_life(star)
    anchor = ebbinghaus.memory_anchor(star)
    return {
        "id": star.id,
        "scope": star.scope,
        "content": star.content,
        "tags": list(star.tags),
        "type": star.memory_type,
        "importance": round(star.importance, 3),
        "valence": round(star.valence, 3),
        "arousal": round(star.arousal, 3),
        "pinned": bool(star.pinned),
        "corrected": bool(star.corrected),
        "status": star.status.value if isinstance(star.status, MemoryStatus) else str(star.status),
        "created_at": star.created_at,
        "last_review": star.last_review,
        "review_count": star.review_count,
        "recall_count": star.recall_count,
        "reactivate_count": star.reactivate_count,
        # ---- 遗忘与情绪状态 ----
        "retention": round(max(0.0, min(1.0, r)), 4),
        "clarity": ebbinghaus.clarity_of(r, params),
        "half_life_days": round(half_life, 3),
        "event_time": star.event_time,
        "event_time_label": timeline.format_event_time(
            star.event_time, star.event_time_precision, now
        ),
        "event_time_precision": star.event_time_precision,
        "event_time_source": star.event_time_source,
        "last_reinforced_at": star.last_reinforced_at,
        "days_since_anchor": round(max(0.0, (now - anchor) / 86400.0), 2),
    }


def build_routes(
    engine: StarMemoryEngine,
    config: StarConfig,
    manual_consolidate: Callable[[str], Awaitable[dict[str, Any]]],
    settings: SettingsContext | None = None,
) -> list[Route]:
    """构建全部调试路由。``manual_consolidate(scope)`` 由插件层提供。"""
    store = engine.store
    params = engine.params

    # ---------- 总览 ----------
    async def api_overview() -> dict[str, Any]:
        scopes = await store.scopes()
        scope_infos: list[dict[str, Any]] = []
        totals = {"active": 0, "faded": 0, "archived": 0, "pinned": 0, "all": 0}
        for scope in scopes:
            stats = await store.scope_stats(scope)
            for key in ("active", "faded", "archived"):
                totals[key] += int(stats.get(key) or 0)
            totals["all"] += int(stats.get("total") or 0)
            mood = mood_engine.decay(await store.get_mood(scope))
            scope_infos.append({
                "scope": scope,
                "stats": stats,
                "mood": {
                    "valence": round(mood.valence, 3),
                    "arousal": round(mood.arousal, 3),
                    "affection": round(mood.affection, 3),
                    "desc": mood_engine.describe(mood) if config.mood_enabled else "（心绪系统未开启）",
                },
            })
        # pinned 是跨状态标记，单独统计
        pinned = 0
        for star in await store.list_stars(statuses=("active", "faded", "archived"), limit=10000):
            if star.pinned:
                pinned += 1
        totals["pinned"] = pinned
        scope_infos.sort(key=lambda s: -(s["stats"].get("total") or 0))
        last_day = await store.get_meta("last_maintenance_day", "")
        return _ok({
            "totals": totals,
            "scope_count": len(scopes),
            "scopes": scope_infos[:50],
            "last_maintenance_day": last_day,
            "params": {
                "base_half_life_days": params.base_half_life_days,
                "max_half_life_days": params.max_half_life_days,
                "detail_half_life_ratio": params.detail_half_life_ratio,
                "clear_threshold": params.clear_threshold,
                "vague_threshold": params.vague_threshold,
                "review_boost_days": params.review_boost_days,
                "fade_threshold": config.fade_threshold,
                "archive_threshold": config.forget_threshold,
                "emotion_base_half_life_days": config.emotion_base_half_life_days,
                "emotion_residual_floor": config.emotion_residual_floor,
                "min_score": config.recall_min_score,
                "consolidate_every_n_turns": config.consolidate_every_n_turns,
                "scope_mode": config.scope_mode,
            },
        })

    # ---------- 星星列表 ----------
    async def api_stars(status: str = "all", page: str = "1") -> dict[str, Any]:
        try:
            page_no = max(1, int(str(page).strip() or "1"))
        except (TypeError, ValueError):
            page_no = 1
        size = 20
        statuses = _status_filter(status)
        kwargs: dict[str, Any] = {"limit": size + 1, "offset": (page_no - 1) * size}
        if statuses:
            kwargs["statuses"] = statuses
        stars = await store.list_stars(**kwargs)
        has_more = len(stars) > size
        stars = stars[:size]
        now = time.time()
        if status == "pinned":
            stars = [s for s in stars if s.pinned]
        cards = [_star_card(s, params, now) for s in stars]
        return _ok({"stars": cards, "page": page_no, "has_more": has_more, "status": status})

    # ---------- 星星详情（含遗忘曲线与情绪衰减调试参数） ----------
    async def api_star_detail(star_id: str = "0") -> dict[str, Any]:
        sid = _parse_star_id(star_id)
        if sid is None:
            return _err("无效的星星 id")
        star = await store.get_star(sid)
        if star is None:
            return _err(f"找不到星星 #{sid}")
        card = _star_card(star, params)
        now = time.time()
        half_life = card["half_life_days"]
        gain = ebbinghaus.reinforced_half_life(star, now, params)
        details = await store.star_details(sid, star.scope)
        emotions = await store.star_emotions(sid, star.scope)
        links = await store.links_for_stars([sid])
        profile = emotion_engine.emotion_profile(
            emotions, now=now, floor=config.emotion_residual_floor
        )
        card["debug"] = {
            "retention_formula": (
                f"R = 2^(-Δt / H_m) = 2^(-{card['days_since_anchor']}d / {half_life:.2f}d)"
            ),
            "anchor": (
                "最近一次有效强化"
                if star.last_reinforced_at
                else ("事件发生时间" if star.event_time else "记录创建时间")
            ),
            "half_life_days": round(half_life, 2),
            "half_life_after_recall": round(gain, 2),
            "will_fade_at_r": config.fade_threshold,
            "will_archive_at_r": config.forget_threshold,
            "clear_threshold": params.clear_threshold,
            "vague_threshold": params.vague_threshold,
        }
        card["details"] = [
            {
                "id": d.id,
                "text": d.text,
                "type": d.detail_type,
                "half_life_days": round(d.half_life_days, 2),
                "retention": round(
                    ebbinghaus.detail_retention(d, now, params), 4),
                "clarity": ebbinghaus.clarity_of(
                    ebbinghaus.detail_retention(d, now, params), params),
                "corrected": bool(d.corrected),
            }
            for d in details
        ]
        card["emotions"] = [s.as_dict() for s in profile]
        card["links"] = [
            {
                "relation": link.relation,
                "reason": link.reason,
                "from_star_id": link.from_star_id,
                "created_at": link.created_at,
            }
            for link in links.get(sid, [])
        ]
        card["reactivations"] = [
            {"ts": r.ts, "trigger": r.trigger, "score": round(r.score, 4)}
            for r in await store.star_reactivations(sid, limit=10)
        ]
        return _ok(card)

    # ---------- 检索调试（跨 scope，低阈值展示原始得分） ----------
    async def api_search(query: str = "") -> dict[str, Any]:
        query = (query or "").strip()
        if not query:
            return _err("请输入检索词")
        scopes = await store.scopes()
        debug_min = min(0.05, max(0.02, config.recall_min_score / 3))
        merged: list[dict[str, Any]] = []
        for scope in scopes:
            try:
                outcome = await engine.recall(
                    scope, query, top_k=6, use_resonance=False, reinforce=False
                )
            except Exception:
                continue
            for scored in outcome.scored:
                item = _star_card(scored.star, params)
                item.update({
                    "score": round(scored.score, 4),
                    "retention": round(scored.retention, 4),
                    "matched_by": scored.matched_by,
                    "glimmer": scored.glimmer,
                })
                merged.append(item)
        merged.sort(key=lambda s: -s["score"])
        return _ok({"query": query, "debug_min_score": debug_min, "results": merged[:12]})

    # ---------- scope 列表 ----------
    async def api_scopes() -> dict[str, Any]:
        scopes = await store.scopes()
        infos = []
        for scope in scopes:
            stats = await store.scope_stats(scope)
            infos.append({"scope": scope, "total": stats.get("total") or 0})
        infos.sort(key=lambda s: -s["total"])
        return _ok({"scopes": infos})

    # ---------- 生命周期操作 ----------
    async def _load(star_id: str) -> Star | None:
        sid = _parse_star_id(star_id)
        if sid is None:
            return None
        return await store.get_star(sid)

    async def api_pin(star_id: str = "0") -> dict[str, Any]:
        star = await _load(star_id)
        if star is None or star.id is None:
            return _err("找不到星星")
        await store.update_star(star.id, star.scope, pinned=True)
        return _ok({"id": star.id, "pinned": True})

    async def api_unpin(star_id: str = "0") -> dict[str, Any]:
        star = await _load(star_id)
        if star is None or star.id is None:
            return _err("找不到星星")
        await store.update_star(star.id, star.scope, pinned=False)
        return _ok({"id": star.id, "pinned": False})

    async def api_forget(star_id: str = "0") -> dict[str, Any]:
        star = await _load(star_id)
        if star is None or star.id is None:
            return _err("找不到星星")
        await store.update_star(star.id, star.scope, status=MemoryStatus.ARCHIVED.value)
        return _ok({"id": star.id, "status": "archived"})

    async def api_revive(star_id: str = "0") -> dict[str, Any]:
        star = await _load(star_id)
        if star is None or star.id is None:
            return _err("找不到星星")
        now = time.time()
        half_life = max(
            ebbinghaus.star_half_life(star),
            params.base_half_life_days,
        )
        await store.update_star(
            star.id, star.scope,
            status=MemoryStatus.ACTIVE.value,
            last_review=now,
            last_reinforced_at=now,
            half_life_days=half_life,
            stability=ebbinghaus.half_life_to_stability(half_life),
        )
        return _ok({"id": star.id, "status": "active", "message": "已重新点亮并把强化时间拨到现在"})

    async def api_delete(star_id: str = "0") -> dict[str, Any]:
        star = await _load(star_id)
        if star is None or star.id is None:
            return _err("找不到星星")
        done = await store.delete_star(star.id, star.scope)
        return _ok({"id": star.id, "deleted": bool(done)})

    # ---------- 引擎操作 ----------
    async def api_maintain() -> dict[str, Any]:
        summary = await engine.maintain_all()
        await store.set_meta("last_maintenance_day", time.strftime("%Y-%m-%d"))
        return _ok(summary)

    async def api_consolidate(scope: str = "") -> dict[str, Any]:
        scope = (scope or "").strip()
        if not scope:
            return _err("缺少 scope")
        try:
            result = await manual_consolidate(scope)
        except Exception as exc:  # noqa: BLE001 - 调试接口要把异常带出去
            return _err(f"凝星失败: {exc}")
        if not result.get("ok"):
            return _err(str(result.get("message") or "没有可凝的内容"))
        return _ok(result)

    # ---------- 设置页（LLM / Embedding / 全部参数） ----------
    _HOT_NOTE = {
        "general": "基本设置已保存并即时生效（调度器按需重启）",
        "llm": "LLM 提供商已切换，下一次对话开始使用",
        "embedding": "Embedding 提供商已切换并清除缓存",
        "recall": "召回参数已保存并即时生效（检索默认不再自动强化）",
        "forgetting": "遗忘曲线参数已热更新（半衰期 / 清晰度阈值）",
        "mood": "心绪参数已保存并即时生效",
        "emotion": "情绪半衰期参数已热更新（每种情绪独立衰减）",
        "consolidation": "凝星参数已保存并即时生效",
        "group": "群聊旁听设置已保存并即时生效",
        "tools": "Agent 工具开关已保存并即时生效",
    }

    async def api_settings() -> dict[str, Any]:
        if settings is None:
            return _err("设置功能不可用（插件未拿到 AstrBotConfig）")
        try:
            providers = settings.providers()
            if inspect.isawaitable(providers):
                providers = await providers
            providers = providers or {"llm": [], "embedding": []}
        except Exception as exc:  # noqa: BLE001
            providers = {"llm": [], "embedding": []}
            providers["_error"] = str(exc)
        sections_out: list[dict[str, Any]] = []
        for name, items, spec in settings.sections():
            fields: list[dict[str, Any]] = []
            for key, fspec in items.items():
                if not isinstance(fspec, dict) or fspec.get("type") == "object":
                    continue
                value = settings.get_value(name, key, fspec)
                if isinstance(value, (dict, list)):
                    value = json.dumps(value, ensure_ascii=False)
                fields.append({
                    "key": key,
                    "path": f"{name}.{key}",
                    "type": fspec.get("type", "string"),
                    "desc": fspec.get("description", key),
                    "hint": fspec.get("hint", ""),
                    "options": fspec.get("options"),
                    "slider": fspec.get("slider"),
                    "special": fspec.get("_special", ""),
                    "value": value,
                    "default": fspec.get("default"),
                })
            sections_out.append({
                "name": name,
                "title": (spec.get("description") or name).split("（")[0],
                "note": _HOT_NOTE.get(name, "已保存"),
                "fields": fields,
            })
        return _ok({"sections": sections_out, "providers": providers})

    async def api_setting_set(section: str = "", key: str = "", value64: str = "") -> dict[str, Any]:
        if settings is None:
            return _err("设置功能不可用")
        spec = settings._field_spec(section, key)
        if spec is None:
            return _err(f"配置项不存在: {section}.{key}")
        try:
            value_text = _b64url_decode(value64)
        except ValueError as exc:
            return _err(str(exc))
        try:
            value = _cast_by_schema(value_text, spec)
        except ValueError as exc:
            return _err(f"{section}.{key}: {exc}")
        try:
            settings.set_value(section, key, value)
        except Exception as exc:  # noqa: BLE001
            return _err(f"保存失败: {exc}")
        applied: list[str] = []
        try:
            result = settings.apply(section)
            if getattr(result, "__await__", None) is not None:
                applied = list(await result)
            elif isinstance(result, list):
                applied = result
        except Exception as exc:  # noqa: BLE001
            return _ok({
                "value": value, "path": f"{section}.{key}",
                "note": f"已保存，但热应用失败（重载插件后生效）: {exc}",
            })
        return _ok({
            "value": value,
            "path": f"{section}.{key}",
            "note": applied[0] if applied else _HOT_NOTE.get(section, "已保存并生效"),
        })

    async def api_setting_reset(section: str = "") -> dict[str, Any]:
        if settings is None:
            return _err("设置功能不可用")
        names = [name for name, _items, _spec in settings.sections()]
        if section not in names:
            return _err(f"配置节不存在: {section}")
        count = settings.reset_section(section)
        try:
            result = settings.apply(section)
            if getattr(result, "__await__", None):
                await result
        except Exception:  # noqa: BLE001
            pass
        return _ok({"section": section, "reset": count, "note": _HOT_NOTE.get(section, "已恢复默认")})

    return [
        (f"{ROUTE_PREFIX}/overview", api_overview, ["GET"], "星空总览与心绪"),
        (f"{ROUTE_PREFIX}/stars/<status>/<page>", api_stars, ["GET"], "星星列表（分页）"),
        (f"{ROUTE_PREFIX}/stars/<status>", api_stars, ["GET"], "星星列表"),
        (f"{ROUTE_PREFIX}/star/<star_id>", api_star_detail, ["GET"], "星星详情与遗忘曲线参数"),
        (f"{ROUTE_PREFIX}/search/<query>", api_search, ["GET"], "检索调试（低阈值原始得分）"),
        (f"{ROUTE_PREFIX}/scopes", api_scopes, ["GET"], "会话列表"),
        (f"{ROUTE_PREFIX}/star/<star_id>/pin", api_pin, ["POST"], "珍藏星星"),
        (f"{ROUTE_PREFIX}/star/<star_id>/unpin", api_unpin, ["POST"], "取消珍藏"),
        (f"{ROUTE_PREFIX}/star/<star_id>/forget", api_forget, ["POST"], "手动熄灭星星"),
        (f"{ROUTE_PREFIX}/star/<star_id>/revive", api_revive, ["POST"], "重新点亮星星"),
        (f"{ROUTE_PREFIX}/star/<star_id>/delete", api_delete, ["POST"], "删除星星"),
        (f"{ROUTE_PREFIX}/maintain", api_maintain, ["POST"], "立即执行遗忘维护"),
        (f"{ROUTE_PREFIX}/consolidate/<scope>", api_consolidate, ["POST"], "手动凝星（消化缓冲对话）"),
        (f"{ROUTE_PREFIX}/settings", api_settings, ["GET"], "读取全部配置（schema + 当前值 + 提供商列表）"),
        (f"{ROUTE_PREFIX}/settings/set/<section>/<key>/<value64>", api_setting_set, ["POST"], "修改单个配置项（base64url 传值）"),
        (f"{ROUTE_PREFIX}/settings/reset/<section>", api_setting_reset, ["POST"], "恢复某节配置为默认值"),
    ]
