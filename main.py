"""bigfish_starmemory · 咸鱼星空记忆

以艾宾浩斯遗忘曲线为骨架、以 bot 情绪状态为血肉的拟人化长期记忆系统。

- 一条记忆 = 一段**经历**：主干内容 + 若干细节 + 发生时间 + 原始情绪 + 各自的遗忘状态；
- 记忆遗忘用**半衰期**表达：R(t) = 2^(-t/H_m)，H_m 在写入时由重要度与情绪浓淡决定，
  只在真正被想起（强化）时才变长，绝不"所有记忆统一一个周期"；
- 情绪有**自己的**半衰期：E(t) = E0·2^(-t/H_e)，每种情绪可单独配置，衰减与记忆清晰度完全独立；
- 细节是经历内部的一层：细节半衰期短于主干，可以可靠、模糊、几乎不记得；
- 被想起（召回）只是"检索"，不等于"强化"；相似情境可以让旧经历**重新激活**，
  但不会凭空恢复已经模糊的细节，也不会改写原始情绪强度。

AstrBot 接入层：本文件只负责把 AstrBot 的事件钩子、命令、LLM 工具
桥接到 core 包的无依赖实现上。
"""

from __future__ import annotations

import asyncio
import json
import time
from typing import Any

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.event.filter import PermissionType, permission_type
from astrbot.api.provider import LLMResponse, ProviderRequest
from astrbot.api.star import Context, Star as AstrBotStar, StarTools

from .core import ebbinghaus
from .core import emotion as emotion_engine
from .core import formatting
from .core import mood as mood_engine
from .core import providers
from .core import webui
from .core.config import StarConfig
from .core.ebbinghaus import EbbinghausParams
from .core.embedding import EmbeddingService
from .core.engine import StarMemoryEngine
from .core.llm import LLMClient
from .core.models import Detail, EmotionRecord, Mood, ScoredStar, Star
from .core.scheduler import DailyScheduler
from .core.storage import StarStore
from .core.text import truncate_line
from .core.timeline import parse_event_time

PLUGIN_VERSION = "0.1.2"
PLUGIN_NAME = "bigfish_starmemory"
CTX_KEY = "bigfish_starmemory"


def _pick(obj: Any, *names: str, default: Any = None) -> Any:
    """按顺序取第一个可调用成功/存在的属性值（鸭子类型兼容层）。"""
    for name in names:
        getter = getattr(obj, name, None)
        if getter is None:
            continue
        try:
            value = getter() if callable(getter) else getter
        except Exception:
            continue
        if value:
            return value
    return default


def _parse_int(text: str) -> int | None:
    try:
        return int(str(text).strip())
    except (TypeError, ValueError):
        return None


class BigfishStarMemory(AstrBotStar):
    """咸鱼星空记忆插件主类。"""

    def __init__(self, context: Context, config: dict | None = None):
        super().__init__(context)
        self.context = context
        # AstrBotConfig 原始实例（dict 子类，带 schema 与 save_config），设置页用它读写
        self._astrbot_config = config
        self.cfg = StarConfig(config)
        self.version = PLUGIN_VERSION

        # 数据目录（失败时退回相对目录，保证插件可运行）
        try:
            data_dir = str(StarTools.get_data_dir(PLUGIN_NAME))
        except Exception as exc:
            logger.warning(f"[StarMemory] 获取数据目录失败，使用相对目录: {exc}")
            data_dir = "./data/bigfish_starmemory"

        self.store = StarStore(data_dir.rstrip("/\\") + "/starmemory.db")
        self.llm = LLMClient(
            context,
            provider_id=self.cfg.str("llm.provider_id", ""),
            max_retries=self.cfg.int("llm.max_retries", 3, low=1, high=10),
        )
        self.embedder = EmbeddingService(context, self.cfg.str("embedding.provider_id", ""))
        self.params = self._build_params()
        self.engine = StarMemoryEngine(
            self.cfg, self.store, self.llm, self.embedder, self.params,
            bot_name=self.cfg.str("general.bot_name", "Bot"),
        )
        self.scheduler: DailyScheduler | None = None

        # 运行期状态
        self._background_tasks: set[asyncio.Task] = set()
        self._pending_transcript: dict[str, list[str]] = {}
        self._turn_counter: dict[str, int] = {}
        self._ready = False

        logger.info(
            f"[StarMemory] 咸鱼星空记忆 v{PLUGIN_VERSION} 已加载，数据目录: {data_dir}"
        )

    # ------------------------------------------------------------------
    # 生命周期
    # ------------------------------------------------------------------

    def _build_params(self) -> EbbinghausParams:
        """从配置构造遗忘曲线参数（半衰期是第一性参数）。"""
        return EbbinghausParams(
            base_half_life_days=self.cfg.base_half_life_days,
            min_half_life_days=self.cfg.min_half_life_days,
            max_half_life_days=self.cfg.max_half_life_days,
            importance_base=0.6,
            importance_span=1.4,
            emotion_gain=0.6,
            detail_half_life_ratio=self.cfg.detail_half_life_ratio,
            detail_half_life_min_days=self.cfg.detail_half_life_min_days,
            fade_threshold=self.cfg.fade_threshold,
            forget_threshold=self.cfg.forget_threshold,
            clear_threshold=self.cfg.clear_threshold,
            vague_threshold=self.cfg.vague_threshold,
            review_boost_days=self.cfg.review_boost_days,
            review_spacing_bonus=0.6,
            negative_fade_bonus=self.cfg.negative_fade_bonus,
            glimmer_chance=self.cfg.glimmer_chance,
        )

    async def initialize(self):
        """AstrBot 事件循环就绪后调用：初始化存储并启动遗忘调度器。"""
        try:
            await self.store.initialize()
            self._ready = True
        except Exception as exc:
            logger.error(f"[StarMemory] 数据库初始化失败，插件将以休眠模式运行: {exc}")
            return
        if self.cfg.enabled:
            self._scheduler_hour = self.cfg.maintenance_hour
            self.scheduler = DailyScheduler(self.engine, self.cfg.maintenance_hour)
            await self.scheduler.start()
        self._register_webui()
        logger.info("[StarMemory] 星空已点亮，开始凝星与追忆。")

    def _register_webui(self):
        """把调试控制台的 API 挂到 AstrBot WebUI（插件详情页可见）。"""
        try:
            register = getattr(self.context, "register_web_api", None)
            if not callable(register):
                logger.info("[StarMemory] 当前 AstrBot 版本不支持插件 WebAPI，跳过 WebUI 注册")
                return
            settings_ctx = None
            if self._astrbot_config is not None:
                settings_ctx = webui.SettingsContext(
                    config=self._astrbot_config,
                    apply=self._apply_settings,
                    providers=self._list_providers,
                )
            routes = webui.build_routes(
                self.engine, self.cfg, self._manual_consolidate_scope,
                settings=settings_ctx,
            )
            for route, handler, methods, desc in routes:
                register(route, handler, methods, desc)
            logger.info(
                f"[StarMemory] 调试控制台已注册 {len(routes)} 个 WebAPI 路由，"
                "可在 AstrBot WebUI 的插件详情页打开"
            )
        except Exception as exc:
            logger.warning(f"[StarMemory] WebUI 注册失败（不影响主功能）: {exc}")

    # ------------------------------------------------------------------
    # WebUI 设置页：提供商枚举 + 配置热应用
    # ------------------------------------------------------------------

    async def _list_providers(self) -> dict:
        """枚举可用的 LLM / Embedding 提供商，供设置页下拉选择。

        完全来自运行中的 AstrBot（每个用户看到的是他自己保存的提供商），
        不含任何硬编码的模型名，也不修改 AstrBot 的任何配置。
        """
        try:
            return await providers.list_providers(self.context)
        except Exception as exc:  # noqa: BLE001
            logger.debug(f"[StarMemory] 枚举提供商失败: {exc}")
            return {"llm": [], "embedding": [], "default_llm": "", "default_embedding": ""}

    def _apply_settings(self, section: str) -> list[str]:
        """配置保存后的热应用：把新值同步到运行中的引擎组件。"""
        notes: list[str] = []
        try:
            if section == "forgetting":
                self.params = self._build_params()
                self.engine.params = self.params
                notes.append("遗忘曲线参数已热更新")
            elif section == "llm":
                self.llm.provider_id = self.cfg.str("llm.provider_id", "")
                notes.append("LLM 提供商已切换，下一次对话生效")
            elif section == "embedding":
                self.embedder.provider_id = self.cfg.str("embedding.provider_id", "")
                self.embedder.invalidate()
                notes.append("Embedding 提供商已切换并清除缓存")
            elif section == "general":
                self.engine.bot_name = self.cfg.str("general.bot_name", "Bot")
                notes.append("基本设置已生效")
            # 调度器：开关或维护时刻变化时对齐
            self._sync_scheduler()
        except Exception as exc:  # noqa: BLE001
            logger.warning(f"[StarMemory] 配置热应用失败（{section}）: {exc}")
            notes.append(f"热应用部分失败: {exc}")
        return notes

    def _sync_scheduler(self):
        """保证调度器与 enabled / maintenance_hour 配置一致。"""
        want_running = self.cfg.enabled
        want_hour = self.cfg.maintenance_hour
        hour_changed = (
            self.scheduler is not None
            and getattr(self, "_scheduler_hour", want_hour) != want_hour
        )
        if want_running and (self.scheduler is None or hour_changed):
            if self.scheduler is not None:
                old = self.scheduler
                self.scheduler = None
                asyncio.ensure_future(old.stop())
            self._scheduler_hour = want_hour
            self.scheduler = DailyScheduler(self.engine, want_hour)
            asyncio.ensure_future(self.scheduler.start())
            logger.info(f"[StarMemory] 遗忘调度器已{'重启' if hour_changed else '启动'}，每日 {want_hour} 时维护")
        elif not want_running and self.scheduler is not None:
            sched = self.scheduler
            self.scheduler = None
            asyncio.ensure_future(sched.stop())
            logger.info("[StarMemory] 遗忘调度器已按配置停用")

    async def _manual_consolidate_scope(self, scope: str) -> dict:
        """WebUI 手动凝星：立即消化该会话缓冲的对话（调试用）。"""
        lines = list(self._pending_transcript.get(scope, []))
        self._pending_transcript.pop(scope, None)
        self._turn_counter[scope] = 0
        if not lines and self.cfg.capture_group_all:
            try:
                stardust = await self.store.take_stardust(scope, self.cfg.stardust_limit)
            except Exception:
                stardust = []
            for item in stardust:
                text = str(item.get("text") or "").strip()
                if len(text) >= self.cfg.min_stardust_chars:
                    sender = item.get("sender") or "群友"
                    ts = item.get("ts") or time.time()
                    lines.append(
                        f"[{time.strftime('%Y-%m-%d %H:%M', time.localtime(ts))}] "
                        f"{sender}（群聊旁听）：{truncate_line(text, 200)}"
                    )
        if not lines:
            return {"ok": False, "message": "该会话暂无缓冲的对话内容（先去聊几轮再来）"}
        is_group = self.cfg.scope_mode != "user" and (
            "GroupMessage" in scope or "group" in scope.lower()
        )
        outcome = await self.engine.consolidate(scope, lines, [], is_group=is_group)
        return {
            "ok": True,
            "added": outcome.added,
            "reinforced": outcome.reinforced,
            "merged": outcome.merged,
            "mood_changed": outcome.mood_changed,
            "mood_reason": outcome.mood_reason,
        }

    async def terminate(self):
        logger.info("[StarMemory] 正在收拢星光……")
        if self.scheduler:
            await self.scheduler.stop()
            self.scheduler = None
        tasks = [t for t in self._background_tasks if not t.done()]
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        self._background_tasks.clear()
        try:
            await self.store.close()
        except Exception:
            pass
        logger.info("[StarMemory] 星空记忆已安全关闭。")

    # ------------------------------------------------------------------
    # 事件上下文暂存（on_llm_request -> on_llm_response -> after_message_sent）
    # ------------------------------------------------------------------

    @staticmethod
    def _set_ctx(event: AstrMessageEvent, data: dict) -> None:
        setter = getattr(event, "set_extra", None)
        if callable(setter):
            try:
                setter(CTX_KEY, data)
                return
            except Exception:
                pass
        try:
            setattr(event, f"_{CTX_KEY}", data)
        except Exception:
            pass

    @staticmethod
    def _get_ctx(event: AstrMessageEvent) -> dict:
        getter = getattr(event, "get_extra", None)
        if callable(getter):
            try:
                data = getter(CTX_KEY)
                if isinstance(data, dict):
                    return data
            except Exception:
                pass
        data = getattr(event, f"_{CTX_KEY}", None)
        return data if isinstance(data, dict) else {}

    # ------------------------------------------------------------------
    # scope / 名称解析
    # ------------------------------------------------------------------

    def _scope(self, event: AstrMessageEvent) -> str:
        mode = self.cfg.scope_mode
        if mode == "global":
            return "global"
        if mode == "user":
            sender_id = str(_pick(event, "get_sender_id", default="") or "").strip()
            if sender_id:
                return f"user:{sender_id}"
        umo = str(getattr(event, "unified_msg_origin", "") or "").strip()
        if umo:
            return umo
        session_id = str(_pick(event, "get_session_id", default="") or "")
        return f"session:{session_id or 'unknown'}"

    def _sender_name(self, event: AstrMessageEvent) -> str:
        name = _pick(event, "get_sender_name", default="")
        if not name:
            sender = getattr(event, "sender", None)
            name = _pick(sender, "nickname", "user_id", default="")
        return truncate_line(str(name or "对话者"), 24)

    def _is_group(self, event: AstrMessageEvent) -> bool:
        group_id = _pick(event, "get_group_id", "group_id", default="")
        return bool(str(group_id or "").strip())

    def _bot_id(self, event: AstrMessageEvent) -> str:
        return str(_pick(event, "get_self_id", default="") or "").strip()

    def _is_admin(self, event: AstrMessageEvent) -> bool:
        checker = getattr(event, "is_admin", None)
        try:
            if callable(checker):
                return bool(checker())
            if checker is not None:
                return bool(checker)
        except Exception:
            pass
        return str(getattr(event, "role", "") or "").lower() in ("admin", "owner")

    # ------------------------------------------------------------------
    # LLM 请求前：召回与注入
    # ------------------------------------------------------------------

    @filter.on_llm_request()
    async def handle_memory_recall(self, event: AstrMessageEvent, req: ProviderRequest):
        """LLM 请求前：仰望星空，把相关的星星与此刻心绪注入上下文。"""
        if not self.cfg.enabled or not self._ready:
            return
        try:
            query = str(
                getattr(event, "message_str", "") or getattr(req, "prompt", "") or ""
            ).strip()
            if not query:
                return
            scope = self._scope(event)
            job = self.engine.recall(scope, query)
            budget = self.cfg.hook_budget_seconds
            if budget > 0:
                try:
                    outcome = await asyncio.wait_for(job, timeout=budget)
                except asyncio.TimeoutError:
                    logger.warning(f"[StarMemory] 召回超时（>{budget:.1f}s），本轮不注入")
                    return
            else:
                outcome = await job

            block = self.engine.render_injection(outcome)
            if block:
                self._inject(req, block)
                if outcome.scored:
                    logger.info(f"[StarMemory] [{scope}] 注入 {len(outcome.scored)} 颗星星")
                else:
                    logger.debug(f"[StarMemory] [{scope}] 无命中星星，仅注入心绪提示")
            else:
                logger.debug(f"[StarMemory] [{scope}] 没有被点亮的星星")

            # 暂存本轮上下文，供 after_message_sent 阶段的巩固使用
            self._set_ctx(event, {
                "scope": scope,
                "is_group": self._is_group(event),
                "user_text": query,
                "injected": [
                    {"id": s.star.id, "content": s.star.content} for s in outcome.scored
                ],
                "ts": time.time(),
            })
        except Exception as exc:
            logger.error(f"[StarMemory] 召回失败（本轮跳过）: {exc}", exc_info=True)

    def _inject(self, req: ProviderRequest, block: str) -> None:
        method = self.cfg.injection_method
        if method == "off":
            return
        if method == "contexts":
            contexts = getattr(req, "contexts", None)
            if isinstance(contexts, list):
                contexts.append({"role": "system", "content": block})
                return
        # 默认：追加到 system_prompt（与人格提示共存）
        try:
            base = req.system_prompt or ""
            req.system_prompt = f"{base}\n\n{block}".strip() if base else block
        except Exception as exc:
            logger.warning(f"[StarMemory] 注入 system_prompt 失败: {exc}")

    # ------------------------------------------------------------------
    # LLM 响应后 / 消息发送后：巩固
    # ------------------------------------------------------------------

    @filter.on_llm_response()
    async def handle_llm_response(self, event: AstrMessageEvent, resp: LLMResponse):
        """记录 bot 回复，供巩固阶段使用。"""
        ctx = self._get_ctx(event)
        if not ctx:
            return
        reply = ""
        try:
            reply = str(getattr(resp, "completion_text", "") or "")
        except Exception:
            pass
        ctx["reply"] = truncate_line(reply, 2000)
        self._set_ctx(event, ctx)

    @filter.after_message_sent()
    async def handle_consolidation(self, event: AstrMessageEvent, *args):
        """消息发送后：在后台把对话凝成星星（不阻塞主流程）。"""
        if not self.cfg.enabled or not self._ready:
            return
        ctx = self._get_ctx(event)
        if not ctx or not ctx.get("scope"):
            return
        try:
            task = asyncio.create_task(self._consolidate_job(event, dict(ctx)))
            self._background_tasks.add(task)
            task.add_done_callback(self._background_tasks.discard)
        except Exception as exc:
            logger.error(f"[StarMemory] 巩固任务提交失败: {exc}")

    async def _consolidate_job(self, event: AstrMessageEvent, ctx: dict):
        try:
            scope = ctx["scope"]
            # 每轮计数，支持 N 轮一凝
            self._turn_counter[scope] = self._turn_counter.get(scope, 0) + 1
            if self._turn_counter[scope] < self.cfg.consolidate_every_n_turns:
                self._buffer_transcript(scope, ctx)
                return
            self._turn_counter[scope] = 0

            lines: list[str] = list(self._pending_transcript.get(scope, []))
            self._pending_transcript.pop(scope, None)
            lines.extend(self._ctx_transcript_lines(event, ctx))

            # 群聊被动消息（星尘）
            if ctx.get("is_group") and self.cfg.capture_group_all and self.cfg.stardust_limit > 0:
                try:
                    stardust = await self.store.take_stardust(scope, self.cfg.stardust_limit)
                except Exception:
                    stardust = []
                user_text = str(ctx.get("user_text") or "").strip()
                for item in stardust:
                    text = str(item.get("text") or "").strip()
                    if not text or text == user_text:
                        continue
                    if len(text) < self.cfg.min_stardust_chars:
                        continue
                    sender = item.get("sender") or "群友"
                    ts = item.get("ts") or time.time()
                    lines.append(
                        f"[{time.strftime('%Y-%m-%d %H:%M', time.localtime(ts))}] "
                        f"{sender}（群聊旁听）：{truncate_line(text, 200)}"
                    )

            if not lines:
                return

            injected = self._ctx_injected_stars(scope, ctx)
            outcome = await self.engine.consolidate(
                scope, lines, injected, is_group=bool(ctx.get("is_group"))
            )
            self._log_consolidation(scope, outcome)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error(f"[StarMemory] 巩固失败: {exc}", exc_info=True)

    def _ctx_transcript_lines(self, event: AstrMessageEvent, ctx: dict) -> list[str]:
        lines: list[str] = []
        stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(ctx.get("ts") or time.time()))
        user_text = str(ctx.get("user_text") or "").strip()
        if user_text:
            lines.append(f"[{stamp}] {self._sender_name(event)}：{truncate_line(user_text, 500)}")
        reply = str(ctx.get("reply") or "").strip()
        if reply:
            bot_name = self.cfg.str("general.bot_name", "Bot")
            lines.append(f"[{stamp}] {bot_name}：{truncate_line(reply, 800)}")
        return lines

    def _ctx_injected_stars(self, scope: str, ctx: dict) -> list[ScoredStar]:
        """把本轮注入的星星还原为候选对象，供 LLM 做"复习点名"。"""
        injected = ctx.get("injected") or []
        result: list[ScoredStar] = []
        for item in injected[:20]:
            if not isinstance(item, dict):
                continue
            try:
                star_id = int(item.get("id"))
            except (TypeError, ValueError):
                continue
            content = str(item.get("content") or "")
            if not content:
                continue
            result.append(
                ScoredStar(star=Star(id=star_id, scope=scope, content=content))
            )
        return result

    def _buffer_transcript(self, scope: str, ctx: dict) -> None:
        """N 轮一凝时，先在内存里攒着没到点的轮次。"""
        buffer = self._pending_transcript.setdefault(scope, [])
        stamp = time.strftime("%Y-%m-%d %H:%M", time.localtime(ctx.get("ts") or time.time()))
        user_text = str(ctx.get("user_text") or "").strip()
        if user_text:
            buffer.append(f"[{stamp}] 对话者：{truncate_line(user_text, 500)}")
        reply = str(ctx.get("reply") or "").strip()
        if reply:
            bot_name = self.cfg.str("general.bot_name", "Bot")
            buffer.append(f"[{stamp}] {bot_name}：{truncate_line(reply, 800)}")
        del buffer[:-40]

    def _log_consolidation(self, scope: str, outcome) -> None:
        parts = []
        if outcome.added:
            parts.append(f"凝成 {len(outcome.added)} 颗新星")
        if outcome.merged:
            parts.append(f"汇入旧星 {outcome.merged} 次")
        if outcome.reinforced:
            parts.append(f"复习点名 {len(outcome.reinforced)} 颗")
        if outcome.mood_changed:
            parts.append("心绪更新")
        if outcome.skipped:
            logger.debug(f"[StarMemory] [{scope}] 整理跳过: {outcome.skipped}")
        elif parts:
            logger.info(f"[StarMemory] [{scope}] " + "，".join(parts))

    # ------------------------------------------------------------------
    # 群聊被动捕获（星尘）
    # ------------------------------------------------------------------

    @filter.event_message_type(filter.EventMessageType.GROUP_MESSAGE, priority=1)
    async def capture_group_stardust(self, event: AstrMessageEvent):
        """群聊消息的轻量旁听：暂存为"星尘"，供下次巩固时作背景。"""
        if not self.cfg.enabled or not self._ready:
            return
        if not self.cfg.capture_group_all or self.cfg.stardust_limit <= 0:
            return
        try:
            text = str(getattr(event, "message_str", "") or "").strip()
            if len(text) < self.cfg.min_stardust_chars:
                return
            sender_id = str(_pick(event, "get_sender_id", default="") or "")
            if sender_id and sender_id == self._bot_id(event):
                return  # 不旁听自己
            sender = self._sender_name(event)
            scope = self._scope(event)
            await self.store.add_stardust(scope, sender, truncate_line(text, 300))
        except Exception as exc:
            logger.debug(f"[StarMemory] 星尘记录失败（忽略）: {exc}")

    # ------------------------------------------------------------------
    # LLM 工具：让 bot 自己决定何时回忆 / 记住
    # ------------------------------------------------------------------

    @filter.llm_tool(name="star_memory_recall")
    async def tool_star_recall(self, event: AstrMessageEvent, query: str = "", top_k: int = 5) -> str:
        """搜索你的长期记忆星空，按相关度返回记忆星星。当你怀疑过去聊过相关话题、或对方提到"之前/上次/还记得吗"时调用。

        Args:
            query(string): 检索关键词或自然语言问题
            top_k(number): 最多返回几条，默认 5，最大 10
        """
        if not self.cfg.enabled or not self._ready or not self.cfg.enable_recall_tool:
            return json.dumps({"ok": False, "error": "recall disabled"}, ensure_ascii=False)
        try:
            top_k = max(1, min(10, int(top_k)))
        except (TypeError, ValueError):
            top_k = 5
        try:
            scope = self._scope(event)
            outcome = await self.engine.recall(
                scope, str(query or ""), top_k=top_k, use_resonance=False
            )
            items = [
                {
                    "id": s.star.id,
                    "content": s.star.content,
                    "date": time.strftime("%Y-%m-%d", time.localtime(s.star.created_at)),
                    "event_time": s.event_time_label or "不详",
                    "brightness": round(s.retention, 2),
                    "clarity": s.clarity or "clear",
                    "details": [
                        {
                            "text": d.get("text"),
                            "clarity": d.get("clarity"),
                        }
                        for d in (s.detail_states or [])
                        if d.get("clarity") in ("clear", "vague")
                    ],
                    "emotion_residual": [
                        {"type": e.label, "residual": round(e.residual, 3)}
                        for e in (s.emotion_states or [])
                    ],
                }
                for s in outcome.scored
            ]
            return json.dumps({"ok": True, "stars": items}, ensure_ascii=False)
        except Exception as exc:
            logger.error(f"[StarMemory] star_memory_recall 工具失败: {exc}")
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    @filter.llm_tool(name="star_memory_memorize")
    async def tool_star_memorize(
        self,
        event: AstrMessageEvent,
        content: str = "",
        tags: str = "",
        importance: float = 0.6,
        valence: float = 0.0,
        memory_type: str = "fact",
        pinned: bool = False,
        details: str = "",
        event_time: str = "",
        emotions: str = "",
    ) -> str:
        """把一件重要的事凝成星星保存为长期记忆。仅在对话者明确要求记住、或出现重要承诺/偏好/事实时调用；不要保存密码等敏感信息。

        Args:
            content(string): 要记住的内容，一句独立、完整、可检索的陈述
            tags(string): 逗号分隔的检索锚点词，如 "小黑,生日,3月5日"
            importance(number): 重要度 0~1，承诺与强烈偏好建议 0.8 以上
            valence(number): 情绪色彩 -1~1，愉快为正
            memory_type(string): fact/event/preference/promise/emotion/skill 之一
            pinned(boolean): 对方明确要求"永远记住"时为 true
            details(string): 逗号分隔的细节，每条细节会按自己的半衰期单独遗忘
            event_time(string): 事情发生的时间，写成绝对时间 "YYYY-MM-DD HH:MM"；不确定就留空
            emotions(string): 逗号分隔的"情绪:强度"，如 "开心:0.6,生气:0.4"
        """
        if not self.cfg.enabled or not self._ready or not self.cfg.enable_memorize_tool:
            return json.dumps({"ok": False, "error": "memorize disabled"}, ensure_ascii=False)
        text = truncate_line(str(content or ""), 500).strip()
        if len(text) < 4:
            return json.dumps({"ok": False, "error": "content too short"}, ensure_ascii=False)
        try:
            scope = self._scope(event)
            now = time.time()
            imp = max(0.0, min(1.0, float(importance)))
            val = max(-1.0, min(1.0, float(valence)))

            # 事件时间：解析不出来就保持"不详"，绝不编造
            event_ts, precision, source = parse_event_time(event_time, now=now)
            if not str(event_time or "").strip():
                event_ts, precision, source = None, "unknown", "unknown"

            # 情绪：原始强度 + 各自的半衰期
            emo_rows: list[dict] = []
            for pair in str(emotions or "").split(","):
                pair = pair.strip()
                if not pair or ":" not in pair:
                    continue
                name, _, raw = pair.partition(":")
                try:
                    intensity = float(raw)
                except ValueError:
                    continue
                etype = emotion_engine.normalize_type(name)
                emo_rows.append({
                    "type": etype,
                    "intensity": max(0.0, min(1.0, intensity)),
                    "half_life_days": self.cfg.emotion_half_life(etype),
                })

            emotional = max(abs(val), 0.5)
            for row in emo_rows:
                emotional = max(emotional, row["intensity"])
            half_life = ebbinghaus.half_life_for_new_memory(imp, emotional, self.params)
            anchor = event_ts or now

            star = Star(
                id=0,
                scope=scope,
                content=text,
                tags=[t.strip() for t in str(tags or "").split(",") if t.strip()][:6],
                memory_type=str(memory_type or "fact"),
                importance=imp,
                valence=val,
                arousal=0.5,
                event_time=event_ts,
                event_time_precision=precision,
                event_time_source=source,
                half_life_days=half_life,
                stability=ebbinghaus.half_life_to_stability(half_life),
                last_reinforced_at=anchor,
                last_review=anchor,
                created_at=now,
                pinned=bool(pinned),
            )
            vec = await self.embedder.embed([text])
            vec = vec[0] if vec else None
            new_id = await self.store.add_star(star, vec)
            if not new_id:
                return json.dumps({"ok": False, "error": "duplicate memory"}, ensure_ascii=False)

            # 细节：各自独立的半衰期
            detail_rows = []
            for item in str(details or "").split(","):
                item = item.strip()
                if len(item) < 2:
                    continue
                detail_rows.append(Detail(
                    star_id=new_id,
                    scope=scope,
                    text=truncate_line(item, 200),
                    detail_type="detail",
                    half_life_days=ebbinghaus.detail_half_life_for(
                        half_life, "detail", self.params),
                    created_at=now,
                    updated_at=now,
                    last_reinforced_at=now,
                ))
            for row in detail_rows:
                await self.store.add_detail(row)

            # 情绪：原始强度 + 独立半衰期
            for row in emo_rows:
                await self.store.add_emotion(EmotionRecord(
                    star_id=new_id,
                    scope=scope,
                    emotion_type=row["type"],
                    direction=emotion_engine.direction_of(row["type"]),
                    intensity=row["intensity"],
                    half_life_days=row["half_life_days"],
                    event_time=event_ts or now,
                    created_at=now,
                    updated_at=now,
                    last_reinforced_at=now,
                ))

            logger.info(f"[StarMemory] 工具凝星 #{new_id}: {truncate_line(text, 40)}")
            return json.dumps({
                "ok": True,
                "id": new_id,
                "half_life_days": round(half_life, 2),
                "details": len(detail_rows),
                "emotions": len(emo_rows),
                "event_time": precision,
            }, ensure_ascii=False)
        except Exception as exc:
            logger.error(f"[StarMemory] star_memory_memorize 工具失败: {exc}")
            return json.dumps({"ok": False, "error": str(exc)}, ensure_ascii=False)

    # ------------------------------------------------------------------
    # 命令 /star ...
    # ------------------------------------------------------------------

    @filter.command_group("star")
    def star(self):
        """星空记忆命令组：发送 /star help 查看用法"""
        pass

    @star.command("help", priority=10)
    async def star_help(self, event: AstrMessageEvent):
        """查看命令帮助"""
        yield event.plain_result(
            "★ 咸鱼星空记忆 ★\n"
            "/star status   查看星空与心绪\n"
            "/star search <词>  检索星星\n"
            "/star recent [n]   最近的星星\n"
            "/star detail <id>  一颗星星的完整状态（时间/清晰度/细节/情绪残留）\n"
            "/star mood     查看当前心绪\n"
            "/star forget <id>  立即熄灭一颗星(管理员)\n"
            "/star pin <id>     珍藏一颗星(管理员)\n"
            "/star unpin <id>   取消珍藏(管理员)\n"
            "/star maintain     立即执行遗忘维护(管理员)\n"
            "/star clear        归档当前会话的星空(管理员)"
        )

    @star.command("status", priority=10)
    async def star_status(self, event: AstrMessageEvent):
        """查看当前会话的星空状态"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        scope = self._scope(event)
        stats = await self.engine.stats(scope)
        lines = [
            "★ 星空状态 ★",
            f"星星总数 {stats.get('total', 0)}（明亮 {stats.get('active', 0)} / "
            f"变暗 {stats.get('faded', 0)} / 熄灭 {stats.get('archived', 0)}，"
            f"珍藏 {stats.get('pinned', 0)}）",
        ]
        mood = stats.get("mood")
        if self.cfg.mood_enabled and isinstance(mood, Mood):
            lines.append("")
            lines.append("〖星云心绪〗")
            lines.append(formatting.mood_banner(mood))
            lines.append(mood_engine.describe(mood))
        if not stats.get("total"):
            lines.append("（夜空还空空的，聊聊天吧）")
        yield event.plain_result("\n".join(lines))

    @star.command("search", priority=10)
    async def star_search(self, event: AstrMessageEvent, query: str = ""):
        """按关键词检索星星"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        if not query.strip():
            yield event.plain_result("用法：/star search <关键词>")
            return
        scope = self._scope(event)
        outcome = await self.engine.recall(scope, query.strip(), top_k=8, use_resonance=False)
        if not outcome.scored:
            yield event.plain_result("这片夜空里暂时没有相关的星星。")
            return
        lines = ["★ 检索结果 ★"]
        for s in outcome.scored:
            lines.append(formatting.format_star_line(s))
        yield event.plain_result("\n".join(lines))

    @star.command("recent", priority=10)
    async def star_recent(self, event: AstrMessageEvent, count: str = "8"):
        """查看最近的星星"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        n = _parse_int(count) or 8
        n = max(1, min(20, n))
        scope = self._scope(event)
        stars = await self.store.list_stars(scope=scope, order="created_at", limit=n)
        if not stars:
            yield event.plain_result("这片夜空还空空的。")
            return
        lines = [f"★ 最近的 {len(stars)} 颗星星 ★"]
        for star in stars:
            scored = await self.engine.describe_star(scope, star.id)
            if scored is None:
                continue
            lines.append(formatting.format_star_detail(scored))
        yield event.plain_result("\n".join(lines))

    @star.command("detail", priority=10)
    async def star_detail(self, event: AstrMessageEvent, star_id: str = ""):
        """查看一颗星星的完整状态：事件时间 / 清晰度 / 细节 / 情绪残留"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        sid = _parse_int(star_id)
        if sid is None:
            yield event.plain_result("用法：/star detail <星星id>")
            return
        scope = self._scope(event)
        scored = await self.engine.describe_star(scope, sid)
        if scored is None:
            yield event.plain_result(f"当前会话找不到 #{sid} 这颗星。")
            return
        star = scored.star
        r = ebbinghaus.retention(star, time.time(), self.params)
        clarity = {
            "clear": "可靠",
            "vague": "模糊",
            "faint": "几乎不记得",
            "unknown": "无法可靠回忆",
        }.get(scored.clarity or "unknown", "无法可靠回忆")
        lines = [
            f"★ #{star.id} · 亮度{int(round(r * 100))}% · {clarity}",
            f"  记忆半衰期 {star.half_life_days:.1f} 天 | "
            f"重要度 {star.importance:.2f} | 事件时间 {scored.event_time_label or '不详'}"
            f"（精度{star.event_time_precision or 'unknown'}）",
            f"  {truncate_line(star.content, 200)}",
        ]
        if star.tags:
            lines.append("  " + " ".join(f"#{t}" for t in star.tags[:8]))
        if scored.detail_states:
            lines.append("  细节：")
            for state in scored.detail_states:
                mark = {"clear": "清楚", "vague": "模糊", "faint": "几乎不记得"}.get(
                    state.get("clarity") or "unknown", "不可靠")
                lines.append(
                    f"    ↳ [{mark}] {truncate_line(str(state.get('text') or ''), 60)}"
                    f"（半衰期{float(state.get('half_life_days') or 0):.1f}天）"
                )
        if scored.emotion_states:
            lines.append("  情绪残留：")
            for st in scored.emotion_states:
                lines.append(
                    f"    ↳ {st.label}：原始 {st.original_intensity:.2f} → "
                    f"残留 {st.residual:.3f}（半衰期{st.half_life_days:.1f}天）"
                )
        lines.append(
            f"  强化 {star.review_count} 次 / 检索 {star.recall_count} 次 / "
            f"再激活 {star.reactivate_count} 次"
        )
        yield event.plain_result("\n".join(lines))

    @star.command("mood", priority=10)
    async def star_mood(self, event: AstrMessageEvent, action: str = ""):
        """查看心绪；管理员可加 reset 参数重置"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        scope = self._scope(event)
        if action.strip().lower() == "reset":
            if not self._is_admin(event):
                yield event.plain_result("只有管理员可以重置心绪。")
                return
            await self.store.set_mood(scope, Mood())
            yield event.plain_result("星云已归于平静。")
            return
        mood = mood_engine.decay(await self.store.get_mood(scope))
        yield event.plain_result("〖星云心绪〗\n" + formatting.mood_banner(mood))

    @permission_type(PermissionType.ADMIN)
    @star.command("forget", priority=10)
    async def star_forget(self, event: AstrMessageEvent, star_id: str = ""):
        """立即熄灭一颗星星（管理员）"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        sid = _parse_int(star_id)
        if sid is None:
            yield event.plain_result("用法：/star forget <星星id>")
            return
        scope = self._scope(event)
        star = await self.store.get_star(sid, scope)
        if star is None:
            yield event.plain_result(f"当前会话找不到 #{sid} 这颗星。")
            return
        await self.store.update_star(sid, scope, status="archived")
        yield event.plain_result(f"✧ #{sid} 已熄灭归档：{truncate_line(star.content, 40)}")

    @permission_type(PermissionType.ADMIN)
    @star.command("pin", priority=10)
    async def star_pin(self, event: AstrMessageEvent, star_id: str = ""):
        """珍藏一颗星星，永不熄灭（管理员）"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        sid = _parse_int(star_id)
        if sid is None:
            yield event.plain_result("用法：/star pin <星星id>")
            return
        scope = self._scope(event)
        star = await self.store.get_star(sid, scope)
        if star is None:
            yield event.plain_result(f"当前会话找不到 #{sid} 这颗星。")
            return
        await self.store.update_star(sid, scope, pinned=True, status="active")
        yield event.plain_result(f"📌 #{sid} 已被珍藏：{truncate_line(star.content, 40)}")

    @permission_type(PermissionType.ADMIN)
    @star.command("unpin", priority=10)
    async def star_unpin(self, event: AstrMessageEvent, star_id: str = ""):
        """取消珍藏（管理员）"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        sid = _parse_int(star_id)
        if sid is None:
            yield event.plain_result("用法：/star unpin <星星id>")
            return
        scope = self._scope(event)
        star = await self.store.get_star(sid, scope)
        if star is None:
            yield event.plain_result(f"当前会话找不到 #{sid} 这颗星。")
            return
        await self.store.update_star(sid, scope, pinned=False)
        yield event.plain_result(f"#{sid} 已取消珍藏，重新交还给时间。")

    @permission_type(PermissionType.ADMIN)
    @star.command("maintain", priority=10)
    async def star_maintain(self, event: AstrMessageEvent):
        """立即执行一次遗忘维护（管理员）"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        scope = self._scope(event)
        result = await self.engine.maintain_scope(scope)
        await self.store.set_meta("last_maintenance_day", time.strftime("%Y-%m-%d"))
        yield event.plain_result(
            "★ 维护完成 ★\n"
            f"状态变化 {result['changed']} 条，熄灭归档 {result['archived']} 条"
            + (f"，清理 {result['purged']} 条" if result["purged"] else "")
        )

    @permission_type(PermissionType.ADMIN)
    @star.command("clear", priority=10)
    async def star_clear(self, event: AstrMessageEvent):
        """归档当前会话的全部星星（管理员）"""
        if not self._ready:
            yield event.plain_result("星空还未点亮（初始化中）。")
            return
        scope = self._scope(event)
        stars = await self.store.list_stars(
            scope=scope, statuses=("active", "faded"), order="updated_at", limit=10000
        )
        for star in stars:
            await self.store.update_star(star.id, scope, status="archived")
        await self.store.clear_stardust(scope)
        yield event.plain_result(f"已把 {len(stars)} 颗星星收进抽屉（全部归档）。")
