"""SQLite 持久化层：星星 / 星云心绪 / 星尘（群聊被动消息）/ 元数据。

设计要点：
- 单文件数据库（WAL 模式），单一连接 + 线程锁，所有耗时操作经
  ``asyncio.to_thread`` 进入线程池，绝不阻塞 AstrBot 的事件循环；
- 所有方法都是 async，调用方无需关心锁与线程；
- 星星向量以 float32 BLOB 存储，读取时按需解码。
"""

from __future__ import annotations

import asyncio
import json
import sqlite3
import struct
import threading
import time
from typing import Any, Iterable, Sequence

from .models import Detail, EmotionRecord, MemoryLink, Reactivation, MemoryStatus, Mood, Star
from .text import content_hash

_SCHEMA_VERSION = 2

_SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS stars (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    scope        TEXT    NOT NULL,
    content      TEXT    NOT NULL,
    content_hash TEXT    NOT NULL,
    tags         TEXT    NOT NULL DEFAULT '[]',
    memory_type  TEXT    NOT NULL DEFAULT 'fact',
    importance   REAL    NOT NULL DEFAULT 0.5,
    valence      REAL    NOT NULL DEFAULT 0.0,
    arousal      REAL    NOT NULL DEFAULT 0.35,
    stability    REAL    NOT NULL DEFAULT 1.2,
    last_review  REAL    NOT NULL,
    created_at   REAL    NOT NULL,
    updated_at   REAL    NOT NULL,
    review_count INTEGER NOT NULL DEFAULT 0,
    recall_count INTEGER NOT NULL DEFAULT 0,
    pinned       INTEGER NOT NULL DEFAULT 0,
    status       TEXT    NOT NULL DEFAULT 'active',
    embedding    BLOB,
    -- 事件时间与半衰期
    event_time           REAL,
    event_time_precision TEXT    NOT NULL DEFAULT 'unknown',
    event_time_source    TEXT    NOT NULL DEFAULT 'unknown',
    half_life_days       REAL    NOT NULL DEFAULT 7.0,
    last_reinforced_at   REAL    NOT NULL DEFAULT 0,
    reactivate_count     INTEGER NOT NULL DEFAULT 0,
    corrected            INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stars_scope_status ON stars(scope, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_stars_scope_hash ON stars(scope, content_hash);

-- 经历的细节：各自拥有独立半衰期
CREATE TABLE IF NOT EXISTS star_details (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    star_id           INTEGER NOT NULL,
    scope             TEXT    NOT NULL,
    text              TEXT    NOT NULL,
    detail_type       TEXT    NOT NULL DEFAULT 'detail',
    half_life_days    REAL    NOT NULL DEFAULT 3.0,
    created_at        REAL    NOT NULL,
    updated_at        REAL    NOT NULL,
    last_reinforced_at REAL   NOT NULL DEFAULT 0,
    reinforce_count   INTEGER NOT NULL DEFAULT 0,
    corrected         INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_details_star ON star_details(star_id, scope);

-- 事件的原始情绪：独立半衰期
CREATE TABLE IF NOT EXISTS star_emotions (
    id                 INTEGER PRIMARY KEY AUTOINCREMENT,
    star_id            INTEGER NOT NULL,
    scope              TEXT    NOT NULL,
    emotion_type       TEXT    NOT NULL DEFAULT 'calm',
    direction          INTEGER NOT NULL DEFAULT 0,
    intensity          REAL    NOT NULL DEFAULT 0.0,
    half_life_days     REAL    NOT NULL DEFAULT 2.0,
    event_time         REAL,
    created_at         REAL    NOT NULL,
    updated_at         REAL    NOT NULL,
    last_reinforced_at REAL    NOT NULL DEFAULT 0,
    reinforce_count    INTEGER NOT NULL DEFAULT 0,
    reinforce_reason   TEXT    NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_emotions_star ON star_emotions(star_id, scope);

-- 星星之间的关系：强化 / 补充 / 纠正 / 回忆
CREATE TABLE IF NOT EXISTS star_links (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    from_star_id INTEGER NOT NULL,
    to_star_id   INTEGER NOT NULL,
    scope        TEXT    NOT NULL,
    relation     TEXT    NOT NULL,
    reason       TEXT    NOT NULL DEFAULT '',
    created_at   REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_to ON star_links(to_star_id);
CREATE INDEX IF NOT EXISTS idx_links_from ON star_links(from_star_id);

-- 重新激活记录
CREATE TABLE IF NOT EXISTS star_reactivations (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    star_id  INTEGER NOT NULL,
    scope    TEXT    NOT NULL,
    ts       REAL    NOT NULL,
    trigger  TEXT    NOT NULL DEFAULT '',
    score    REAL    NOT NULL DEFAULT 0,
    effect   REAL    NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_react_star ON star_reactivations(star_id, scope);

CREATE TABLE IF NOT EXISTS moods (
    scope      TEXT PRIMARY KEY,
    valence    REAL NOT NULL DEFAULT 0.0,
    arousal    REAL NOT NULL DEFAULT 0.2,
    affection  REAL NOT NULL DEFAULT 0.4,
    updated_at REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS stardust (
    id       INTEGER PRIMARY KEY AUTOINCREMENT,
    scope    TEXT NOT NULL,
    sender   TEXT NOT NULL DEFAULT '',
    text     TEXT NOT NULL,
    ts       REAL NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_stardust_scope ON stardust(scope, consumed, ts);

CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT
);
"""

# v1 -> v2 需要补齐的列（老数据库升级用）
_STAR_MIGRATIONS: tuple[tuple[str, str], ...] = (
    ("event_time", "REAL"),
    ("event_time_precision", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("event_time_source", "TEXT NOT NULL DEFAULT 'unknown'"),
    ("half_life_days", "REAL NOT NULL DEFAULT 7.0"),
    ("last_reinforced_at", "REAL NOT NULL DEFAULT 0"),
    ("reactivate_count", "INTEGER NOT NULL DEFAULT 0"),
    ("corrected", "INTEGER NOT NULL DEFAULT 0"),
)


def encode_embedding(vec: Sequence[float]) -> bytes:
    return struct.pack(f"<{len(vec)}f", *vec)


def decode_embedding(blob: bytes | None) -> list[float] | None:
    if not blob:
        return None
    try:
        count = len(blob) // 4
        if count <= 0:
            return None
        return list(struct.unpack(f"<{count}f", blob[: count * 4]))
    except (struct.error, ValueError):
        return None


def _row_to_star(row: sqlite3.Row, with_embedding: bool = True) -> Star:
    star = Star.from_row(dict(row))
    if with_embedding and "embedding" in row.keys():
        star.embedding = decode_embedding(row["embedding"])
    return star


class StarStore:
    """异步封装的 SQLite 存储。"""

    def __init__(self, db_path: str):
        self.db_path = db_path
        self._lock = threading.RLock()
        self._conn: sqlite3.Connection | None = None
        self._closed = False

    # ---- 生命周期 -------------------------------------------------

    async def initialize(self) -> None:
        await asyncio.to_thread(self._initialize_sync)

    def _initialize_sync(self) -> None:
        with self._lock:
            if self._conn is not None:
                return
            conn = sqlite3.connect(self.db_path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA synchronous=NORMAL")
            conn.execute("PRAGMA foreign_keys=ON")
            conn.executescript(_SCHEMA_SQL)
            self._migrate_stars_sync(conn)
            conn.commit()
            self._conn = conn
            self._set_meta_sync("schema_version", str(_SCHEMA_VERSION))

    def _migrate_stars_sync(self, conn: sqlite3.Connection) -> None:
        """把 v1 的 stars 表升级到 v2：补列 + 回填（旧数据一条不丢）。"""
        try:
            existing = {str(r["name"]) for r in conn.execute("PRAGMA table_info(stars)").fetchall()}
        except sqlite3.Error:
            return
        added: set[str] = set()
        for column, ddl in _STAR_MIGRATIONS:
            if column in existing:
                continue
            try:
                conn.execute(f"ALTER TABLE stars ADD COLUMN {column} {ddl}")
                added.add(column)
            except sqlite3.Error:
                continue

        # 回填：事件时间缺失 -> 用创建时间（标注为推断，精度有限）
        conn.execute(
            "UPDATE stars SET event_time = created_at, "
            "event_time_precision = 'approximate', event_time_source = 'inferred' "
            "WHERE event_time IS NULL"
        )
        # 回填：半衰期由旧的稳定度 S 换算（H_m = S·ln2）
        # 注意：本次刚加的列全是默认值，必须整表回填
        if "half_life_days" in added:
            conn.execute(
                "UPDATE stars SET half_life_days = MAX(0.25, stability * 0.6931471805599453)"
            )
        else:
            conn.execute(
                "UPDATE stars SET half_life_days = MAX(0.25, stability * 0.6931471805599453) "
                "WHERE half_life_days IS NULL OR half_life_days <= 0"
            )
        # 回填：强化锚点用旧的最后复习时间
        if "last_reinforced_at" in added:
            conn.execute("UPDATE stars SET last_reinforced_at = last_review")
        else:
            conn.execute(
                "UPDATE stars SET last_reinforced_at = last_review WHERE last_reinforced_at <= 0"
            )
        # 回填：为还没有情绪记录的老星星，从 valence/arousal 摘要合成一条
        conn.execute(
            """INSERT INTO star_emotions
                 (star_id, scope, emotion_type, direction, intensity, half_life_days,
                  event_time, created_at, updated_at, last_reinforced_at, reinforce_count)
               SELECT s.id, s.scope,
                      CASE WHEN s.valence > 0 THEN 'joy' ELSE 'sadness' END,
                      CASE WHEN s.valence > 0 THEN 1 ELSE -1 END,
                      MAX(ABS(s.valence), s.arousal * 0.5),
                      2.0,
                      s.event_time, s.created_at, s.created_at, s.last_reinforced_at, 0
                 FROM stars s
                WHERE ABS(s.valence) > 0.05
                  AND NOT EXISTS (SELECT 1 FROM star_emotions e WHERE e.star_id = s.id)"""
        )

    async def close(self) -> None:
        self._closed = True
        await asyncio.to_thread(self._close_sync)

    def _close_sync(self) -> None:
        with self._lock:
            if self._conn is not None:
                try:
                    self._conn.commit()
                except sqlite3.Error:
                    pass
                self._conn.close()
                self._conn = None

    def _require_conn(self) -> sqlite3.Connection:
        if self._closed:
            raise RuntimeError("StarStore already closed")
        if self._conn is None:
            raise RuntimeError("StarStore not initialized; call initialize() first")
        return self._conn

    # ---- 星星（stars） ---------------------------------------------

    async def add_star(self, star: Star, embedding: list[float] | None = None) -> int | None:
        """写入一颗星；同 scope 内内容重复时返回 None（去重）。"""
        return await asyncio.to_thread(self._add_star_sync, star, embedding)

    def _add_star_sync(self, star: Star, embedding: list[float] | None) -> int | None:
        now = time.time()
        star.content_hash = star.content_hash or content_hash(star.content)
        star.created_at = star.created_at or now
        star.updated_at = now
        star.last_review = star.last_review or now
        with self._lock:
            conn = self._require_conn()
            try:
                cur = conn.execute(
                    """INSERT INTO stars
                       (scope, content, content_hash, tags, memory_type, importance,
                        valence, arousal, stability, last_review, created_at, updated_at,
                        review_count, recall_count, pinned, status, embedding,
                        event_time, event_time_precision, event_time_source,
                        half_life_days, last_reinforced_at, reactivate_count, corrected)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        star.scope, star.content, star.content_hash,
                        json.dumps(star.tags, ensure_ascii=False), star.memory_type,
                        star.importance, star.valence, star.arousal, star.stability,
                        star.last_review, star.created_at, star.updated_at,
                        star.review_count, star.recall_count, int(star.pinned),
                        star.status, encode_embedding(embedding) if embedding else None,
                        star.event_time, star.event_time_precision, star.event_time_source,
                        star.half_life_days, star.last_reinforced_at,
                        star.reactivate_count, int(star.corrected),
                    ),
                )
                conn.commit()
                return int(cur.lastrowid or 0)
            except sqlite3.IntegrityError:
                return None

    async def get_star(self, star_id: int, scope: str | None = None) -> Star | None:
        return await asyncio.to_thread(self._get_star_sync, star_id, scope)

    def _get_star_sync(self, star_id: int, scope: str | None) -> Star | None:
        with self._lock:
            conn = self._require_conn()
            if scope:
                row = conn.execute(
                    "SELECT * FROM stars WHERE id=? AND scope=?", (star_id, scope)
                ).fetchone()
            else:
                row = conn.execute("SELECT * FROM stars WHERE id=?", (star_id,)).fetchone()
            return _row_to_star(row) if row else None

    async def update_star(self, star_id: int, scope: str, **fields: Any) -> None:
        """按字段更新星星（白名单字段），自动刷新 updated_at。"""
        await asyncio.to_thread(self._update_star_sync, star_id, scope, fields)

    _UPDATABLE = {
        "content", "tags", "memory_type", "importance", "valence", "arousal",
        "stability", "last_review", "review_count", "recall_count",
        "pinned", "status", "embedding",
        "event_time", "event_time_precision", "event_time_source",
        "half_life_days", "last_reinforced_at", "reactivate_count", "corrected",
    }

    def _update_star_sync(self, star_id: int, scope: str, fields: dict[str, Any]) -> None:
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in fields.items():
            if key not in self._UPDATABLE:
                continue
            if key == "tags":
                value = json.dumps(value, ensure_ascii=False) if isinstance(value, list) else "[]"
            elif key == "pinned":
                value = int(bool(value))
            elif key == "embedding" and isinstance(value, list):
                value = encode_embedding(value)
            assignments.append(f"{key}=?")
            values.append(value)
        if not assignments:
            return
        assignments.append("updated_at=?")
        values.append(time.time())
        values.extend([star_id, scope])
        with self._lock:
            conn = self._require_conn()
            conn.execute(
                f"UPDATE stars SET {', '.join(assignments)} WHERE id=? AND scope=?",
                values,
            )
            conn.commit()

    async def scope_stars(
        self,
        scope: str,
        statuses: Iterable[str] = ("active", "faded"),
        limit: int = 400,
        with_embedding: bool = True,
    ) -> list[Star]:
        """取一个 scope 的候选星星（默认按最近活动排序）。"""
        return await asyncio.to_thread(
            self._scope_stars_sync, scope, tuple(statuses), limit, with_embedding
        )

    def _scope_stars_sync(
        self, scope: str, statuses: tuple[str, ...], limit: int, with_embedding: bool
    ) -> list[Star]:
        if not statuses:
            return []
        placeholders = ",".join("?" for _ in statuses)
        cols = "*" if with_embedding else "*, NULL AS embedding"
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                f"""SELECT {cols} FROM stars
                    WHERE scope=? AND status IN ({placeholders})
                    ORDER BY updated_at DESC LIMIT ?""",
                (scope, *statuses, limit),
            ).fetchall()
        return [_row_to_star(r, with_embedding) for r in rows]

    async def list_stars(
        self,
        scope: str | None = None,
        statuses: Iterable[str] | None = None,
        order: str = "updated_at",
        limit: int = 50,
        offset: int = 0,
    ) -> list[Star]:
        statuses = tuple(statuses) if statuses else None
        return await asyncio.to_thread(
            self._list_stars_sync, scope, statuses, order, limit, offset
        )

    def _list_stars_sync(
        self,
        scope: str | None,
        statuses: tuple[str, ...] | None,
        order: str,
        limit: int,
        offset: int,
    ) -> list[Star]:
        _allowed = ("updated_at", "created_at", "importance", "stability", "id")
        order_key = order if order in _allowed else "updated_at"
        where: list[str] = []
        params: list[Any] = []
        if scope:
            where.append("scope=?")
            params.append(scope)
        if statuses:
            where.append(f"status IN ({','.join('?' for _ in statuses)})")
            params.extend(statuses)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        params.extend([max(0, limit), max(0, offset)])
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                f"SELECT * FROM stars {clause} ORDER BY {order_key} DESC LIMIT ? OFFSET ?",
                params,
            ).fetchall()
        return [_row_to_star(r) for r in rows]

    async def scopes(self) -> list[str]:
        """所有存在星星或心绪记录的 scope。"""
        return await asyncio.to_thread(self._scopes_sync)

    def _scopes_sync(self) -> list[str]:
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                "SELECT DISTINCT scope FROM stars "
                "UNION SELECT DISTINCT scope FROM moods"
            ).fetchall()
        return sorted(str(r["scope"]) for r in rows if r["scope"])

    async def count_stars(self, scope: str | None = None, status: str | None = None) -> int:
        return await asyncio.to_thread(self._count_stars_sync, scope, status)

    def _count_stars_sync(self, scope: str | None, status: str | None) -> int:
        where: list[str] = []
        params: list[Any] = []
        if scope:
            where.append("scope=?")
            params.append(scope)
        if status:
            where.append("status=?")
            params.append(status)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        with self._lock:
            conn = self._require_conn()
            row = conn.execute(f"SELECT COUNT(*) AS c FROM stars {clause}", params).fetchone()
        return int(row["c"]) if row else 0

    async def scope_stats(self, scope: str) -> dict[str, Any]:
        return await asyncio.to_thread(self._scope_stats_sync, scope)

    def _scope_stats_sync(self, scope: str) -> dict[str, Any]:
        with self._lock:
            conn = self._require_conn()
            row = conn.execute(
                """SELECT
                     COUNT(*)                                                   AS total,
                     SUM(CASE WHEN status='active'  THEN 1 ELSE 0 END)          AS active,
                     SUM(CASE WHEN status='faded'   THEN 1 ELSE 0 END)          AS faded,
                     SUM(CASE WHEN status='archived' THEN 1 ELSE 0 END)         AS archived,
                     SUM(CASE WHEN pinned=1 THEN 1 ELSE 0 END)                  AS pinned,
                     AVG(importance)                                            AS avg_importance
                   FROM stars WHERE scope=?""",
                (scope,),
            ).fetchone()
        if not row:
            return {}
        return {
            "total": int(row["total"] or 0),
            "active": int(row["active"] or 0),
            "faded": int(row["faded"] or 0),
            "archived": int(row["archived"] or 0),
            "pinned": int(row["pinned"] or 0),
            "avg_importance": float(row["avg_importance"] or 0.0),
        }

    async def delete_star(self, star_id: int, scope: str | None = None) -> bool:
        return await asyncio.to_thread(self._delete_star_sync, star_id, scope)

    def _delete_star_sync(self, star_id: int, scope: str | None) -> bool:
        with self._lock:
            conn = self._require_conn()
            if scope:
                cur = conn.execute("DELETE FROM stars WHERE id=? AND scope=?", (star_id, scope))
            else:
                cur = conn.execute("DELETE FROM stars WHERE id=?", (star_id,))
            conn.commit()
            return cur.rowcount > 0

    async def purge_archived_before(self, before_ts: float, scope: str | None = None) -> int:
        """删除在该时间点之前归档的星星，返回删除数。"""
        return await asyncio.to_thread(self._purge_archived_sync, before_ts, scope)

    def _purge_archived_sync(self, before_ts: float, scope: str | None) -> int:
        where = "status=? AND updated_at<?"
        params: list[Any] = [MemoryStatus.ARCHIVED.value, before_ts]
        if scope:
            where += " AND scope=?"
            params.append(scope)
        with self._lock:
            conn = self._require_conn()
            cur = conn.execute(f"DELETE FROM stars WHERE {where}", params)
            conn.commit()
            return cur.rowcount or 0

    # ---- 细节（star_details） ---------------------------------------

    async def add_detail(self, detail: Detail) -> int:
        return await asyncio.to_thread(self._add_detail_sync, detail)

    def _add_detail_sync(self, detail: Detail) -> int:
        now = time.time()
        detail.created_at = detail.created_at or now
        detail.updated_at = now
        with self._lock:
            conn = self._require_conn()
            cur = conn.execute(
                """INSERT INTO star_details
                   (star_id, scope, text, detail_type, half_life_days,
                    created_at, updated_at, last_reinforced_at, reinforce_count, corrected)
                   VALUES (?,?,?,?,?,?,?,?,?,?)""",
                (
                    detail.star_id, detail.scope, detail.text, detail.detail_type,
                    detail.half_life_days, detail.created_at, detail.updated_at,
                    detail.last_reinforced_at, detail.reinforce_count, int(detail.corrected),
                ),
            )
            conn.commit()
            return int(cur.lastrowid or 0)

    async def star_details(self, star_id: int, scope: str | None = None) -> list[Detail]:
        return await asyncio.to_thread(self._star_details_sync, star_id, scope)

    def _star_details_sync(self, star_id: int, scope: str | None) -> list[Detail]:
        where = "star_id=?"
        params: list[Any] = [star_id]
        if scope:
            where += " AND scope=?"
            params.append(scope)
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                f"SELECT * FROM star_details WHERE {where} ORDER BY id ASC", params
            ).fetchall()
        return [Detail.from_row(dict(r)) for r in rows]

    async def update_detail(self, detail_id: int, **fields: Any) -> None:
        await asyncio.to_thread(self._update_detail_sync, detail_id, fields)

    def _update_detail_sync(self, detail_id: int, fields: dict[str, Any]) -> None:
        allowed = {
            "text", "detail_type", "half_life_days", "last_reinforced_at",
            "reinforce_count", "corrected",
        }
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            if key == "corrected":
                value = int(bool(value))
            assignments.append(f"{key}=?")
            values.append(value)
        if not assignments:
            return
        assignments.append("updated_at=?")
        values.append(time.time())
        values.append(detail_id)
        with self._lock:
            conn = self._require_conn()
            conn.execute(
                f"UPDATE star_details SET {', '.join(assignments)} WHERE id=?", values
            )
            conn.commit()

    # ---- 情绪（star_emotions） --------------------------------------

    async def add_emotion(self, emotion: EmotionRecord) -> int:
        return await asyncio.to_thread(self._add_emotion_sync, emotion)

    def _add_emotion_sync(self, emotion: EmotionRecord) -> int:
        now = time.time()
        emotion.created_at = emotion.created_at or now
        emotion.updated_at = now
        with self._lock:
            conn = self._require_conn()
            cur = conn.execute(
                """INSERT INTO star_emotions
                   (star_id, scope, emotion_type, direction, intensity, half_life_days,
                    event_time, created_at, updated_at, last_reinforced_at,
                    reinforce_count, reinforce_reason)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    emotion.star_id, emotion.scope, emotion.emotion_type, emotion.direction,
                    emotion.intensity, emotion.half_life_days, emotion.event_time,
                    emotion.created_at, emotion.updated_at, emotion.last_reinforced_at,
                    emotion.reinforce_count, emotion.reinforce_reason,
                ),
            )
            conn.commit()
            return int(cur.lastrowid or 0)

    async def star_emotions(self, star_id: int, scope: str | None = None) -> list[EmotionRecord]:
        return await asyncio.to_thread(self._star_emotions_sync, star_id, scope)

    def _star_emotions_sync(self, star_id: int, scope: str | None) -> list[EmotionRecord]:
        where = "star_id=?"
        params: list[Any] = [star_id]
        if scope:
            where += " AND scope=?"
            params.append(scope)
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                f"SELECT * FROM star_emotions WHERE {where} ORDER BY id ASC", params
            ).fetchall()
        return [EmotionRecord.from_row(dict(r)) for r in rows]

    async def update_emotion(self, emotion_id: int, **fields: Any) -> None:
        await asyncio.to_thread(self._update_emotion_sync, emotion_id, fields)

    def _update_emotion_sync(self, emotion_id: int, fields: dict[str, Any]) -> None:
        allowed = {
            "last_reinforced_at", "reinforce_count", "reinforce_reason",
            "half_life_days", "event_time",
        }
        assignments: list[str] = []
        values: list[Any] = []
        for key, value in fields.items():
            if key not in allowed:
                continue
            assignments.append(f"{key}=?")
            values.append(value)
        if not assignments:
            return
        assignments.append("updated_at=?")
        values.append(time.time())
        values.append(emotion_id)
        with self._lock:
            conn = self._require_conn()
            conn.execute(
                f"UPDATE star_emotions SET {', '.join(assignments)} WHERE id=?", values
            )
            conn.commit()

    # ---- 关联（star_links） ------------------------------------------

    async def add_link(self, link: MemoryLink) -> int:
        return await asyncio.to_thread(self._add_link_sync, link)

    def _add_link_sync(self, link: MemoryLink) -> int:
        link.created_at = link.created_at or time.time()
        with self._lock:
            conn = self._require_conn()
            cur = conn.execute(
                """INSERT INTO star_links
                   (from_star_id, to_star_id, scope, relation, reason, created_at)
                   VALUES (?,?,?,?,?,?)""",
                (
                    link.from_star_id, link.to_star_id, link.scope,
                    link.relation, link.reason, link.created_at,
                ),
            )
            conn.commit()
            return int(cur.lastrowid or 0)

    async def star_links(
        self,
        to_star_id: int | None = None,
        from_star_id: int | None = None,
        scope: str | None = None,
        limit: int = 50,
    ) -> list[MemoryLink]:
        return await asyncio.to_thread(
            self._star_links_sync, to_star_id, from_star_id, scope, limit
        )

    def _star_links_sync(
        self,
        to_star_id: int | None,
        from_star_id: int | None,
        scope: str | None,
        limit: int,
    ) -> list[MemoryLink]:
        where: list[str] = []
        params: list[Any] = []
        if to_star_id is not None:
            where.append("to_star_id=?")
            params.append(to_star_id)
        if from_star_id is not None:
            where.append("from_star_id=?")
            params.append(from_star_id)
        if scope:
            where.append("scope=?")
            params.append(scope)
        clause = f"WHERE {' AND '.join(where)}" if where else ""
        params.append(max(1, limit))
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                f"SELECT * FROM star_links {clause} ORDER BY id DESC LIMIT ?", params
            ).fetchall()
        return [MemoryLink.from_row(dict(r)) for r in rows]

    # ---- 重新激活（star_reactivations） ------------------------------

    async def add_reactivation(self, reactivation: Reactivation) -> int:
        return await asyncio.to_thread(self._add_reactivation_sync, reactivation)

    def _add_reactivation_sync(self, reactivation: Reactivation) -> int:
        reactivation.ts = reactivation.ts or time.time()
        with self._lock:
            conn = self._require_conn()
            cur = conn.execute(
                """INSERT INTO star_reactivations
                   (star_id, scope, ts, trigger, score, effect)
                   VALUES (?,?,?,?,?,?)""",
                (
                    reactivation.star_id, reactivation.scope, reactivation.ts,
                    reactivation.trigger, reactivation.score, reactivation.effect,
                ),
            )
            conn.commit()
            return int(cur.lastrowid or 0)

    async def star_reactivations(self, star_id: int, limit: int = 20) -> list[Reactivation]:
        return await asyncio.to_thread(self._star_reactivations_sync, star_id, limit)

    def _star_reactivations_sync(self, star_id: int, limit: int) -> list[Reactivation]:
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                "SELECT * FROM star_reactivations WHERE star_id=? ORDER BY id DESC LIMIT ?",
                (star_id, max(1, limit)),
            ).fetchall()
        return [Reactivation.from_row(dict(r)) for r in rows]

    async def details_for_stars(self, star_ids: Sequence[int]) -> dict[int, list[Detail]]:
        """批量取细节（避免逐颗查询）。"""
        ids = [int(i) for i in star_ids if i]
        if not ids:
            return {}
        return await asyncio.to_thread(self._details_for_stars_sync, ids)

    def _details_for_stars_sync(self, ids: list[int]) -> dict[int, list[Detail]]:
        result: dict[int, list[Detail]] = {i: [] for i in ids}
        with self._lock:
            conn = self._require_conn()
            for chunk_start in range(0, len(ids), 400):
                chunk = ids[chunk_start:chunk_start + 400]
                placeholders = ",".join("?" for _ in chunk)
                rows = conn.execute(
                    f"SELECT * FROM star_details WHERE star_id IN ({placeholders}) ORDER BY id ASC",
                    chunk,
                ).fetchall()
                for row in rows:
                    d = Detail.from_row(dict(row))
                    result.setdefault(d.star_id, []).append(d)
        return result

    async def emotions_for_stars(self, star_ids: Sequence[int]) -> dict[int, list[EmotionRecord]]:
        """批量取情绪记录。"""
        ids = [int(i) for i in star_ids if i]
        if not ids:
            return {}
        return await asyncio.to_thread(self._emotions_for_stars_sync, ids)

    def _emotions_for_stars_sync(self, ids: list[int]) -> dict[int, list[EmotionRecord]]:
        result: dict[int, list[EmotionRecord]] = {i: [] for i in ids}
        with self._lock:
            conn = self._require_conn()
            for chunk_start in range(0, len(ids), 400):
                chunk = ids[chunk_start:chunk_start + 400]
                placeholders = ",".join("?" for _ in chunk)
                rows = conn.execute(
                    f"SELECT * FROM star_emotions WHERE star_id IN ({placeholders}) ORDER BY id ASC",
                    chunk,
                ).fetchall()
                for row in rows:
                    e = EmotionRecord.from_row(dict(row))
                    result.setdefault(e.star_id, []).append(e)
        return result

    async def links_for_stars(self, star_ids: Sequence[int]) -> dict[int, list[MemoryLink]]:
        """批量取"指向这些星星"的关联（新经历 -> 旧记忆）。"""
        ids = [int(i) for i in star_ids if i]
        if not ids:
            return {}
        return await asyncio.to_thread(self._links_for_stars_sync, ids)

    def _links_for_stars_sync(self, ids: list[int]) -> dict[int, list[MemoryLink]]:
        result: dict[int, list[MemoryLink]] = {i: [] for i in ids}
        with self._lock:
            conn = self._require_conn()
            for chunk_start in range(0, len(ids), 400):
                chunk = ids[chunk_start:chunk_start + 400]
                placeholders = ",".join("?" for _ in chunk)
                rows = conn.execute(
                    f"SELECT * FROM star_links WHERE to_star_id IN ({placeholders}) ORDER BY id DESC",
                    chunk,
                ).fetchall()
                for row in rows:
                    link = MemoryLink.from_row(dict(row))
                    result.setdefault(link.to_star_id, []).append(link)
        return result

    # ---- 组合读取 ----------------------------------------------------

    async def star_bundle(
        self, star_id: int, scope: str | None = None
    ) -> tuple[Star | None, list[Detail], list[EmotionRecord]]:
        """一次取出星星 + 细节 + 情绪，避免多次 IO。"""
        star = await self.get_star(star_id, scope)
        if star is None:
            return None, [], []
        details = await self.star_details(star_id, scope)
        emotions = await self.star_emotions(star_id, scope)
        return star, details, emotions

    # ---- 星云心绪（moods） -----------------------------------------

    async def get_mood(self, scope: str) -> Mood:
        return Mood.from_row(await asyncio.to_thread(self._get_mood_sync, scope))

    def _get_mood_sync(self, scope: str) -> dict[str, Any] | None:
        with self._lock:
            conn = self._require_conn()
            row = conn.execute("SELECT * FROM moods WHERE scope=?", (scope,)).fetchone()
        return dict(row) if row else None

    async def set_mood(self, scope: str, mood: Mood) -> None:
        await asyncio.to_thread(self._set_mood_sync, scope, mood)

    def _set_mood_sync(self, scope: str, mood: Mood) -> None:
        with self._lock:
            conn = self._require_conn()
            conn.execute(
                """INSERT INTO moods (scope, valence, arousal, affection, updated_at)
                   VALUES (?,?,?,?,?)
                   ON CONFLICT(scope) DO UPDATE SET
                     valence=excluded.valence, arousal=excluded.arousal,
                     affection=excluded.affection, updated_at=excluded.updated_at""",
                (scope, mood.valence, mood.arousal, mood.affection, mood.updated_at),
            )
            conn.commit()

    # ---- 星尘（stardust，群聊被动消息暂存） -------------------------

    async def add_stardust(self, scope: str, sender: str, text: str, ts: float | None = None) -> None:
        await asyncio.to_thread(self._add_stardust_sync, scope, sender, text, ts or time.time())

    def _add_stardust_sync(self, scope: str, sender: str, text: str, ts: float) -> None:
        with self._lock:
            conn = self._require_conn()
            conn.execute(
                "INSERT INTO stardust (scope, sender, text, ts, consumed) VALUES (?,?,?,?,0)",
                (scope, sender, text, ts),
            )
            conn.commit()

    async def take_stardust(self, scope: str, limit: int = 30, max_chars: int = 3000) -> list[dict[str, Any]]:
        """取走未消费的星尘并标记为已消费（按时间正序）。"""
        return await asyncio.to_thread(self._take_stardust_sync, scope, limit, max_chars)

    def _take_stardust_sync(self, scope: str, limit: int, max_chars: int) -> list[dict[str, Any]]:
        with self._lock:
            conn = self._require_conn()
            rows = conn.execute(
                """SELECT id, sender, text, ts FROM stardust
                   WHERE scope=? AND consumed=0 ORDER BY ts ASC LIMIT ?""",
                (scope, max(0, limit)),
            ).fetchall()
            ids = [int(r["id"]) for r in rows]
            if ids:
                conn.execute(
                    f"UPDATE stardust SET consumed=1 WHERE id IN ({','.join('?' for _ in ids)})",
                    ids,
                )
                # 星尘是临时上下文，消费后即可清理旧行，防止表无限增长
                conn.execute("DELETE FROM stardust WHERE scope=? AND consumed=1 AND ts < ?",
                             (scope, time.time() - 3600))
            conn.commit()
        return [{"sender": str(r["sender"]), "text": str(r["text"]), "ts": float(r["ts"])} for r in rows]

    async def clear_stardust(self, scope: str) -> None:
        await asyncio.to_thread(self._clear_stardust_sync, scope)

    def _clear_stardust_sync(self, scope: str) -> None:
        with self._lock:
            conn = self._require_conn()
            conn.execute("DELETE FROM stardust WHERE scope=?", (scope,))
            conn.commit()

    # ---- 元数据（meta） --------------------------------------------

    async def get_meta(self, key: str, default: str = "") -> str:
        return await asyncio.to_thread(self._get_meta_sync, key, default)

    def _get_meta_sync(self, key: str, default: str) -> str:
        with self._lock:
            conn = self._require_conn()
            row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
        return str(row["value"]) if row else default

    def _set_meta_sync(self, key: str, value: str) -> None:
        with self._lock:
            conn = self._require_conn()
            conn.execute(
                "INSERT INTO meta (key, value) VALUES (?,?) "
                "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                (key, value),
            )
            conn.commit()

    async def set_meta(self, key: str, value: str) -> None:
        await asyncio.to_thread(self._set_meta_sync, key, value)
