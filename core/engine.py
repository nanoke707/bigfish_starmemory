"""记忆引擎：召回、重新激活、保存、巩固、维护的编排中心。

调用关系（全部可独立测试，不依赖 AstrBot）：

    main.py ─┬─ recall()      召回：检索 -> 可见度 -> 清晰度分级 -> 情绪残留
             ├─ consolidate() 巩固：LLM 提取经历 + 心绪更新 + 关系处理
             └─ maintain()    维护：每日遗忘曲线推进 + 心绪消退 + 归档清理

## 三条铁律

1. **检索 ≠ 强化**：被检索到只是"被找到了"，不改变遗忘状态，只加计数器；
   只有"真正被想起"（LLM 确认）或"有新经历印证"才强化。
2. **重新激活 ≠ 恢复**：旧经历被重新唤起时，本轮会临时放大它的情绪残留，
   但**不会**恢复已经模糊的细节，也**不会**改写原始情绪强度。
3. **记忆与情绪各走各的**：记忆清晰度看 R = 2^(-t/H_m)，
   情绪残留看 E = E0·2^(-t/H_e)，两套参数互不干扰。
"""

from __future__ import annotations

import random
import time
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from . import emotion as emotion_engine
from . import formatting
from . import mood as mood_engine
from .config import StarConfig
from .ebbinghaus import (
    EbbinghausParams,
    clarity_of,
    detail_half_life_for,
    detail_retention,
    half_life_for_new_memory,
    half_life_to_stability,
    maintenance_update,
    memory_anchor,
    reinforced_half_life,
    retention,
    visibility,
)
from .embedding import EmbeddingService
from .llm import LLMClient
from .models import (
    CLARITY_UNKNOWN,
    REL_CONTRADICTS,
    REL_RECALL,
    REL_REINFORCES,
    REL_SUPPLEMENTS,
    ConsolidationOutcome,
    Detail,
    EmotionRecord,
    MemoryLink,
    MemoryStatus,
    Mood,
    Reactivation,
    ScoredStar,
    Star,
)
from .prompts import RETRY_SUFFIX, build_extraction_messages
from .storage import StarStore
from .text import as_tag_list, clamp, content_hash, cosine, keyword_score, parse_lenient_json, truncate_line
from .timeline import format_event_time, parse_event_time


@dataclass
class RecallOutcome:
    scored: list[ScoredStar] = field(default_factory=list)
    mood_after: Mood | None = None
    reactivated: list[int] = field(default_factory=list)   # 本轮被重新唤起的星星 id


class StarMemoryEngine:
    """星空记忆引擎。"""

    def __init__(
        self,
        config: StarConfig,
        store: StarStore,
        llm: LLMClient,
        embedder: EmbeddingService,
        params: EbbinghausParams,
        bot_name: str = "Bot",
    ):
        self.config = config
        self.store = store
        self.llm = llm
        self.embedder = embedder
        self.params = params
        self.bot_name = bot_name or "Bot"
        self.rng = random.Random()

    # ------------------------------------------------------------------
    # 召回
    # ------------------------------------------------------------------

    async def recall(
        self,
        scope: str,
        query: str,
        mood: Mood | None = None,
        top_k: int | None = None,
        use_resonance: bool = True,
        reinforce: bool | None = None,
    ) -> RecallOutcome:
        """仰望星空：检索与当前话题有关的星星。

        - 相似度 = 向量/关键词混合得分 × 情绪一致性 × 亮度可见度（含灵光一现）；
        - 每颗星星会被算出**回忆清晰度**（可靠/模糊/几乎不记得）与**情绪残留**；
        - 被检索到**不改变**遗忘状态（除非显式开启"召回即复习"，默认关闭）。
        """
        outcome = RecallOutcome()
        now = time.time()
        top_k = top_k or self.config.recall_top_k
        query = (query or "").strip()
        if not query:
            return outcome

        mood = mood or await self.store.get_mood(scope)
        if self.config.mood_enabled:
            mood = mood_engine.decay(mood, now)

        candidates = await self.store.scope_stars(
            scope, (MemoryStatus.ACTIVE.value, MemoryStatus.FADED.value), limit=400
        )
        if not candidates:
            outcome.mood_after = mood
            return outcome

        # 查询向量（可能为 None -> 关键词降级）
        query_vectors = await self.embedder.embed([query]) if query else None
        query_vec = query_vectors[0] if query_vectors else None

        scored: list[ScoredStar] = []
        for star in candidates:
            kw = keyword_score(query, star.content, star.tags)
            sim = kw
            matched = "keyword"
            if query_vec is not None and star.embedding:
                vec_sim = cosine(query_vec, star.embedding)
                sim = 0.65 * vec_sim + 0.35 * kw
                matched = "vector" if vec_sim >= kw else "keyword"
            mult, glimmer = visibility(
                star, now, self.params, mood,
                bias_strength=self.config.mood_bias_strength, rng=self.rng.random,
            )
            final = sim * mult
            if final < self.config.recall_min_score:
                continue
            r = retention(star, now, self.params)
            scored.append(
                ScoredStar(
                    star=star,
                    score=final,
                    retention=r,
                    glimmer=glimmer,
                    matched_by=matched,
                    clarity=clarity_of(r, self.params),
                    event_time_label=format_event_time(
                        star.event_time, star.event_time_precision, now
                    ),
                )
            )

        scored.sort(key=lambda s: s.score, reverse=True)
        selected = scored[:top_k]
        outcome.scored = selected
        outcome.mood_after = mood

        if not selected:
            return outcome

        # ---- 细节 / 情绪 / 关联：只对入选的星星加载 -------------------
        ids = [s.star.id for s in selected]
        details_map = await self.store.details_for_stars(ids)
        emotions_map = await self.store.emotions_for_stars(ids)
        links_map = await self.store.links_for_stars(ids)

        for item in selected:
            star = item.star
            item.detail_states = self._detail_states(star, details_map.get(star.id, []), now)
            # 情绪子系统关闭时，不计算也不注入任何情绪残留
            item.emotion_states = (
                emotion_engine.emotion_profile(
                    emotions_map.get(star.id, []),
                    now=now,
                    floor=self.config.emotion_residual_floor,
                )
                if self.config.emotion_enabled
                else []
            )
            # 被纠正过的旧记忆：细节不再作为可靠事实给出
            if links_map.get(star.id):
                for link in links_map[star.id]:
                    if link.relation == REL_CONTRADICTS:
                        for state in item.detail_states:
                            state["clarity"] = CLARITY_UNKNOWN

        # ---- 重新激活：旧经历在合适情境下重新进入注意范围 ------------
        reactivated = await self._maybe_reactivate(selected, query, now)
        outcome.reactivated = reactivated
        for item in selected:
            if item.star.id in reactivated:
                item.reactivated = True
                # 本轮临时放大情绪残留（不改原始强度、不重置半衰期）
                item.emotion_states = (
                    emotion_engine.emotion_profile(
                        emotions_map.get(item.star.id, []),
                        now=now,
                        floor=self.config.emotion_residual_floor,
                        boost=self.config.emotion_reactivate_boost,
                    )
                    if self.config.emotion_enabled
                    else []
                )

        # ---- 检索计数（**不是**强化） --------------------------------
        for item in selected:
            star = item.star
            await self.store.update_star(
                star.id, star.scope, recall_count=star.recall_count + 1
            )
            star.recall_count += 1

        # ---- 可选的"召回即复习"（默认关闭，不推荐） -----------------
        do_reinforce = self.config.reinforce_on_recall if reinforce is None else reinforce
        if do_reinforce:
            for item in selected:
                await self._reinforce_star(item.star, now, reason="召回即复习（兼容选项）")

        # ---- 记忆共鸣：旧星星牵动心绪 ---------------------------------
        if use_resonance and self.config.mood_enabled:
            new_mood = mood_engine.resonate(mood, selected, self.config.mood_resonance)
            if (abs(new_mood.valence - mood.valence) > 1e-4
                    or abs(new_mood.arousal - mood.arousal) > 1e-4):
                outcome.mood_after = new_mood
                await self.store.set_mood(scope, new_mood)

        return outcome

    def _detail_states(
        self, star: Star, details: list[Detail], now: float
    ) -> list[dict[str, Any]]:
        """计算每条细节的保持率与清晰度。"""
        states: list[dict[str, Any]] = []
        for detail in details:
            r = detail_retention(detail, now, self.params)
            states.append({
                "id": detail.id,
                "text": detail.text,
                "type": detail.detail_type,
                "retention": r,
                "clarity": clarity_of(r, self.params),
                "half_life_days": detail.half_life_days,
            })
        states.sort(key=lambda s: s["retention"], reverse=True)
        return states

    async def _maybe_reactivate(
        self, selected: list[ScoredStar], query: str, now: float
    ) -> list[int]:
        """判断哪些星星在本轮构成"重新激活"。

        规则（可解释、可复现）：
        - 该星星被选中（相关性足够）；
        - 且它当前的保持率已经掉到可靠阈值以下（即本来快要想不起来了）。

        重新激活**不会**改变半衰期与锚点——只是记录一次，并把情绪残留
        在本轮临时放大一点。
        """
        ids: list[int] = []
        threshold = self.config.clear_threshold
        for item in selected:
            star = item.star
            if item.retention >= threshold:
                continue  # 本来就记得清楚，不算"重新唤起"
            ids.append(star.id)
            await self.store.add_reactivation(
                Reactivation(
                    star_id=star.id,
                    scope=star.scope,
                    ts=now,
                    trigger=truncate_line(query, 120),
                    score=item.score,
                    effect=self.config.emotion_reactivate_boost,
                )
            )
            await self.store.update_star(
                star.id, star.scope, reactivate_count=star.reactivate_count + 1
            )
            star.reactivate_count += 1
        return ids

    async def _reinforce_star(
        self, star: Star, now: float, reason: str = "", related: int | None = None
    ) -> float:
        """执行一次**有效强化**：半衰期变长 + 锚点推到当前时刻。"""
        new_half_life = reinforced_half_life(star, now, self.params)
        await self.store.update_star(
            star.id,
            star.scope,
            half_life_days=new_half_life,
            stability=half_life_to_stability(new_half_life),
            last_reinforced_at=now,
            last_review=now,
            review_count=star.review_count + 1,
        )
        star.half_life_days = new_half_life
        star.stability = half_life_to_stability(new_half_life)
        star.last_reinforced_at = now
        star.last_review = now
        star.review_count += 1
        if related is not None:
            await self.store.add_link(
                MemoryLink(
                    from_star_id=related,
                    to_star_id=star.id,
                    scope=star.scope,
                    relation=REL_REINFORCES,
                    reason=reason,
                    created_at=now,
                )
            )
        return new_half_life

    async def reinforce_ids(self, scope: str, star_ids: list[int]) -> list[int]:
        """真正被想起的星星：强化 + 记录再激活事件。"""
        reinforced: list[int] = []
        now = time.time()
        for star_id in star_ids:
            try:
                star_id = int(star_id)
            except (TypeError, ValueError):
                continue
            star = await self.store.get_star(star_id, scope)
            if star is None:
                continue
            await self._reinforce_star(star, now, reason="本轮真正被想起")
            await self.store.add_reactivation(
                Reactivation(
                    star_id=star.id,
                    scope=scope,
                    ts=now,
                    trigger="真正被想起",
                    score=1.0,
                    effect=self.config.emotion_reactivate_boost,
                )
            )
            reinforced.append(star.id)
        return reinforced

    # ------------------------------------------------------------------
    # 巩固（保存）
    # ------------------------------------------------------------------

    async def consolidate(
        self,
        scope: str,
        transcript_lines: list[str],
        injected_scored: list[ScoredStar] | None = None,
        is_group: bool | None = None,
    ) -> ConsolidationOutcome:
        """把一段对话凝成星星（经历），并更新心绪。"""
        outcome = ConsolidationOutcome()
        transcript = "\n".join(line for line in transcript_lines if line and line.strip())
        transcript = truncate_line(transcript, 6000)
        if len(transcript.strip()) < self.config.min_transcript_chars:
            outcome.skipped = "对话太短，不值得凝成星星"
            return outcome

        mood = mood_engine.decay(await self.store.get_mood(scope))

        candidates_block = ""
        if injected_scored:
            candidates_block = "\n".join(
                f"#{s.star.id} | {truncate_line(s.star.content, 60)}" for s in injected_scored
            )

        date = datetime.now().strftime("%Y-%m-%d %H:%M")
        if is_group is None:
            is_group = "group" in scope.lower()
        system, user = build_extraction_messages(
            transcript, candidates_block,
            date=date,
            scope_kind="群聊" if is_group else "私聊",
            mood_desc=mood_engine.describe(mood) if self.config.mood_enabled else "心情平静",
            bot_name=self.bot_name,
            max_memories=self.config.max_memories_per_turn,
        )

        try:
            raw = await self.llm.chat(system, user)
            data = parse_lenient_json(raw)
            if data is None:
                raw = await self.llm.chat(system, user + RETRY_SUFFIX)
                data = parse_lenient_json(raw)
        except Exception as exc:
            outcome.skipped = f"LLM 调用失败: {exc}"
            return outcome
        if data is None:
            outcome.skipped = "LLM 输出无法解析为 JSON"
            return outcome

        # ---- 1) 真正被想起的旧记忆 -> 强化 --------------------------
        used_ids = data.get("used_memory_ids")
        if isinstance(used_ids, list):
            clean_ids = []
            for v in used_ids:
                try:
                    clean_ids.append(int(v))
                except (TypeError, ValueError):
                    continue
            if clean_ids:
                outcome.reinforced = await self.reinforce_ids(scope, clean_ids)

        # ---- 2) 心绪更新 ---------------------------------------------
        if self.config.mood_enabled:
            new_mood = mood_engine.apply_deltas(mood, data.get("mood_delta"))
            outcome.mood_reason = str(data.get("mood_reason") or "")[:120]
            outcome.mood_changed = (
                abs(new_mood.valence - mood.valence) > 1e-4
                or abs(new_mood.arousal - mood.arousal) > 1e-4
                or abs(new_mood.affection - mood.affection) > 1e-4
            )
            if outcome.mood_changed:
                await self.store.set_mood(scope, new_mood)

        # ---- 3) 提炼经历 ----------------------------------------------
        raw_memories = data.get("memories")
        if not isinstance(raw_memories, list):
            raw_memories = []
        raw_memories = raw_memories[: self.config.max_memories_per_turn]
        if not raw_memories:
            await self._apply_emotion_updates(scope, data.get("emotion_updates"))
            return outcome

        # 近期星星用于语义去重（带向量的前 60 条）
        recent = await self.store.scope_stars(
            scope,
            (MemoryStatus.ACTIVE.value, MemoryStatus.FADED.value),
            limit=60,
        )

        now = time.time()
        new_items: list[dict[str, Any]] = []
        for item in raw_memories:
            if not isinstance(item, dict):
                continue
            content = str(item.get("content") or "").strip()
            if len(content) < 4:
                continue
            # 事件时间：解析不出来就保持"不详"，绝不编造
            event_ts, precision, source = parse_event_time(
                item.get("event_time"), now=now
            )
            if precision == "unknown" and not str(item.get("event_time") or "").strip():
                event_ts, precision, source = None, "unknown", "unknown"
            emotions = self._parse_emotions(item.get("emotions"), event_ts, now)
            new_items.append({
                "content": content,
                "details": self._parse_details(item.get("details")),
                "tags": as_tag_list(item.get("tags")),
                "type": str(item.get("type") or "fact"),
                "importance": clamp(item.get("importance", 0.5), 0.0, 1.0),
                "valence": clamp(item.get("valence", 0.0), -1.0, 1.0),
                "arousal": clamp(item.get("arousal", 0.35), 0.0, 1.0),
                "pinned": bool(item.get("pinned", False)),
                "event_time": event_ts,
                "event_time_precision": precision,
                "event_time_source": source,
                "emotions": emotions,
            })
        if not new_items:
            await self._apply_emotion_updates(scope, data.get("emotion_updates"))
            return outcome

        vectors = await self.embedder.embed([item["content"] for item in new_items])

        total = await self.store.count_stars(scope, MemoryStatus.ACTIVE.value)
        created_ids: list[int] = []
        for idx, item in enumerate(new_items):
            vec = vectors[idx] if vectors else None
            dup_hash = content_hash(item["content"])
            exists = any(s.content_hash == dup_hash for s in recent)
            dup_sim = False
            if vec:
                for s in recent:
                    if s.embedding and cosine(vec, s.embedding) >= self.config.dedup_similarity:
                        dup_sim = True
                        break
            if exists or dup_sim:
                outcome.merged += 1
                target = next((s for s in recent if s.content_hash == dup_hash), None)
                if target is None and vec:
                    target = next(
                        (s for s in recent if s.embedding and cosine(vec, s.embedding) >= self.config.dedup_similarity),
                        None,
                    )
                if target is not None:
                    # 同一件事被再次提起：这是"有新的经历印证"，允许强化
                    await self._reinforce_star(
                        target, now, reason="同一件事被再次提起（去重合并）"
                    )
                    merged_tags = list(dict.fromkeys(target.tags + item["tags"]))[:8]
                    await self.store.update_star(
                        target.id, scope,
                        tags=merged_tags,
                        importance=max(target.importance, item["importance"]),
                    )
                continue

            if total >= self.config.max_stars_per_scope:
                outcome.skipped = "这个星空已经太拥挤，暂不新增星星"
                continue

            star = await self._create_star(scope, item, now)
            if star is None:
                continue
            new_id = await self.store.add_star(star, vec)
            if not new_id:
                continue
            total += 1
            star.id = new_id
            created_ids.append(new_id)
            outcome.added.append(item["content"])

            # 细节（各自独立半衰期）
            trunk_h = star.half_life_days
            for detail_item in item["details"]:
                detail = Detail(
                    star_id=new_id,
                    scope=scope,
                    text=detail_item["text"],
                    detail_type=detail_item["type"],
                    half_life_days=detail_half_life_for(trunk_h, detail_item["type"], self.params),
                    created_at=now,
                    updated_at=now,
                    last_reinforced_at=now,
                )
                await self.store.add_detail(detail)

            # 原始情绪（独立半衰期）；情绪子系统关闭时只保留事件本身
            if self.config.emotion_enabled:
                for emo in item["emotions"]:
                    await self.store.add_emotion(
                        EmotionRecord(
                            star_id=new_id,
                            scope=scope,
                            emotion_type=emo["type"],
                            direction=emo["direction"],
                            intensity=emo["intensity"],
                            half_life_days=emo["half_life_days"],
                            event_time=item["event_time"] or now,
                            created_at=now,
                            updated_at=now,
                            last_reinforced_at=now,
                        )
                    )

        # ---- 4) 新经历与旧记忆的关系 ---------------------------------
        await self._apply_relations(scope, data.get("relations"), created_ids, now, outcome)

        # ---- 5) 情绪重新激活（独立于记忆强化） ----------------------
        await self._apply_emotion_updates(scope, data.get("emotion_updates"))

        return outcome

    def _parse_details(self, raw: Any) -> list[dict[str, str]]:
        """解析 LLM 给出的细节列表。"""
        result: list[dict[str, str]] = []
        if not isinstance(raw, list):
            return result
        for item in raw:
            if isinstance(item, dict):
                text = str(item.get("text") or "").strip()
                dtype = str(item.get("type") or "detail")
            else:
                text = str(item or "").strip()
                dtype = "detail"
            if len(text) < 2:
                continue
            if dtype not in ("detail", "quote", "fact"):
                dtype = "detail"
            result.append({"text": text[:120], "type": dtype})
            if len(result) >= 5:
                break
        return result

    def _parse_emotions(self, raw: Any, event_ts: float | None, now: float) -> list[dict[str, Any]]:
        """解析 LLM 给出的情绪列表，并配上半衰期。"""
        result: list[dict[str, Any]] = []
        if not isinstance(raw, list):
            return result
        for item in raw:
            if not isinstance(item, dict):
                continue
            etype = emotion_engine.normalize_type(item.get("type"))
            try:
                intensity = float(item.get("intensity", 0.0))
            except (TypeError, ValueError):
                continue
            intensity = max(0.0, min(1.0, intensity))
            if intensity <= 0.001:
                continue
            result.append({
                "type": etype,
                "direction": emotion_engine.direction_of(etype),
                "intensity": intensity,
                "half_life_days": self.config.emotion_half_life(etype),
            })
            if len(result) >= 3:
                break
        return result

    async def _create_star(
        self, scope: str, item: dict[str, Any], now: float
    ) -> Star | None:
        """构造一颗星星（计算初始半衰期、事件时间锚点）。"""
        emotional = max(abs(item["valence"]), item["arousal"])
        for emo in item["emotions"]:
            emotional = max(emotional, emo["intensity"])
        half_life = half_life_for_new_memory(item["importance"], emotional, self.params)
        event_ts = item["event_time"]
        # 事件发生时间优先作为遗忘锚点；没有就用记录时间
        anchor = event_ts or now
        return Star(
            id=0,
            scope=scope,
            content=item["content"],
            content_hash=content_hash(item["content"]),
            tags=item["tags"],
            memory_type=item["type"],
            importance=item["importance"],
            valence=item["valence"],
            arousal=item["arousal"],
            event_time=event_ts,
            event_time_precision=item["event_time_precision"],
            event_time_source=item["event_time_source"],
            half_life_days=half_life,
            stability=half_life_to_stability(half_life),
            last_reinforced_at=anchor,
            last_review=anchor,
            created_at=now,
            pinned=item["pinned"],
            status=MemoryStatus.ACTIVE.value,
        )

    async def _apply_relations(
        self,
        scope: str,
        raw: Any,
        created_ids: list[int],
        now: float,
        outcome: ConsolidationOutcome,
    ) -> None:
        """处理新经历与旧记忆的关系：印证 / 补充 / 纠正。"""
        if not isinstance(raw, list):
            return
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                target_id = int(item.get("target_id"))
            except (TypeError, ValueError):
                continue
            relation = str(item.get("relation") or REL_REINFORCES)
            reason = str(item.get("reason") or "")[:200]
            if relation not in (REL_REINFORCES, REL_SUPPLEMENTS, REL_CONTRADICTS):
                continue
            target = await self.store.get_star(target_id, scope)
            if target is None:
                continue
            source_id = created_ids[-1] if created_ids else 0
            await self.store.add_link(
                MemoryLink(
                    from_star_id=source_id,
                    to_star_id=target_id,
                    scope=scope,
                    relation=relation,
                    reason=reason,
                    created_at=now,
                )
            )
            if relation == REL_REINFORCES:
                # 有新经历印证 -> 允许强化（并记录依据）
                await self._reinforce_star(target, now, reason=reason or "新经历印证", related=source_id)
                outcome.reinforced.append(target_id)
            elif relation == REL_SUPPLEMENTS:
                # 补充：把新细节挂到旧记忆下（各自独立半衰期）
                detail_text = reason or "（补充细节）"
                await self.store.add_detail(
                    Detail(
                        star_id=target_id,
                        scope=scope,
                        text=detail_text,
                        detail_type="detail",
                        half_life_days=detail_half_life_for(
                            target.half_life_days or self.params.base_half_life_days,
                            "detail",
                            self.params,
                        ),
                        created_at=now,
                        updated_at=now,
                        last_reinforced_at=now,
                    )
                )
            elif relation == REL_CONTRADICTS:
                # 纠正：标记旧记忆被纠正，**保留原始记录**不做覆盖
                await self.store.update_star(target_id, scope, corrected=True)
                target.corrected = True
                outcome.corrected.append(target_id)

    async def _apply_emotion_updates(self, scope: str, raw: Any) -> None:
        """情绪重新激活：只更新情绪的时间锚点与依据，**不改写原始强度 E0**。"""
        if (not self.config.emotion_enabled
                or not self.config.emotion_reinforce_enabled
                or not isinstance(raw, list)):
            return
        now = time.time()
        for item in raw:
            if not isinstance(item, dict):
                continue
            try:
                star_id = int(item.get("star_id"))
            except (TypeError, ValueError):
                continue
            etype = emotion_engine.normalize_type(item.get("emotion_type"))
            reason = str(item.get("reason") or "")[:200]
            emotions = await self.store.star_emotions(star_id, scope)
            for emo in emotions:
                if emo.emotion_type != etype:
                    continue
                await self.store.update_emotion(
                    emo.id,
                    last_reinforced_at=now,
                    reinforce_count=emo.reinforce_count + 1,
                    reinforce_reason=reason,
                )
                emo.last_reinforced_at = now
                emo.reinforce_count += 1

    # ------------------------------------------------------------------
    # 每日维护
    # ------------------------------------------------------------------

    async def maintain_scope(self, scope: str) -> dict[str, int]:
        """推进一个 scope 的遗忘曲线与心绪消退。"""
        now = time.time()
        changed = 0
        archived = 0
        page = 500
        offset = 0
        mood = mood_engine.decay(await self.store.get_mood(scope), now)
        await self.store.set_mood(scope, mood)

        while True:
            stars = await self.store.list_stars(
                scope=scope,
                statuses=(MemoryStatus.ACTIVE.value, MemoryStatus.FADED.value),
                order="updated_at",
                limit=page,
                offset=offset,
            )
            if not stars:
                break
            for star in stars:
                new_status, new_half_life = maintenance_update(star, now, self.params, mood)
                if (
                    new_status != star.status
                    or abs(new_half_life - (star.half_life_days or 0)) > 1e-6
                ):
                    await self.store.update_star(
                        star.id,
                        scope,
                        status=new_status,
                        half_life_days=new_half_life,
                        stability=half_life_to_stability(new_half_life),
                    )
                    star.half_life_days = new_half_life
                    changed += 1
                    if new_status == MemoryStatus.ARCHIVED.value:
                        archived += 1
            if len(stars) < page:
                break
            offset += page

        purged = 0
        if self.config.purge_archived:
            cutoff = now - self.config.purge_after_days * 86400
            purged = await self.store.purge_archived_before(cutoff, scope)
        return {"changed": changed, "archived": archived, "purged": purged}

    async def maintain_all(self) -> dict[str, Any]:
        """推进所有 scope；返回汇总。"""
        scopes = await self.store.scopes()
        summary: dict[str, Any] = {"scopes": 0, "changed": 0, "archived": 0, "purged": 0}
        for scope in scopes:
            result = await self.maintain_scope(scope)
            summary["scopes"] += 1
            for key in ("changed", "archived", "purged"):
                summary[key] += result.get(key, 0)
        await self.store.set_meta("last_maintenance_day", datetime.now().strftime("%Y-%m-%d"))
        return summary

    # ------------------------------------------------------------------
    # 状态
    # ------------------------------------------------------------------

    async def stats(self, scope: str) -> dict[str, Any]:
        stats = await self.store.scope_stats(scope)
        mood = mood_engine.decay(await self.store.get_mood(scope))
        stats["mood"] = mood
        stats["mood_desc"] = mood_engine.describe(mood) if self.config.mood_enabled else "（心绪系统未开启）"
        return stats

    async def describe_star(self, scope: str, star_id: int) -> ScoredStar | None:
        """取单颗星星的完整状态（清晰度 + 细节 + 情绪），供 WebUI/命令使用。"""
        star = await self.store.get_star(star_id, scope)
        if star is None:
            return None
        now = time.time()
        details = await self.store.star_details(star_id, scope)
        emotions = await self.store.star_emotions(star_id, scope)
        r = retention(star, now, self.params)
        return ScoredStar(
            star=star,
            score=1.0,
            retention=r,
            clarity=clarity_of(r, self.params),
            detail_states=self._detail_states(star, details, now),
            emotion_states=(
                emotion_engine.emotion_profile(
                    emotions,
                    now=now,
                    floor=self.config.emotion_residual_floor,
                )
                if self.config.emotion_enabled
                else []
            ),
            event_time_label=format_event_time(
                star.event_time, star.event_time_precision, now
            ),
        )

    def render_injection(self, outcome: RecallOutcome) -> str:
        """渲染召回结果为注入块；没有星星但有情绪时，仅注入心绪提示。"""
        mood_desc = ""
        if self.config.mood_inject and outcome.mood_after is not None:
            mood_desc = mood_engine.describe(outcome.mood_after)
        if not outcome.scored:
            if mood_desc:
                return formatting.format_injection([], mood_desc, self.config.mood_inject)
            return ""
        return formatting.format_injection(
            outcome.scored, mood_desc, self.config.mood_inject,
            max_chars=self.config.max_injection_chars,
        )
