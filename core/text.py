"""文本工具：规范化、哈希、CJK 友好的分词、相似度、JSON 容错解析。

全部为纯 Python 实现，不引入任何第三方依赖——记忆检索的降级路径
（无向量时靠关键词）必须永远可用。
"""

from __future__ import annotations

import hashlib
import json
import math
import re
import unicodedata
from typing import Any, Iterable

# 常见的中英文标点与空白，用于内容规范化
_PUNCT_RE = re.compile(r"[\s，。！？、；：\"'“”‘’（）《》〈〉【】\[\]{}()…·,\.!\?;:~\-_=+*&^%$#@\\|/<>`]+", re.UNICODE)

_WORD_RE = re.compile(r"[0-9A-Za-z_]+|[\u4e00-\u9fff\u3400-\u4dbf]", re.UNICODE)

_CJK_RE = re.compile(r"[\u4e00-\u9fff\u3400-\u4dbf]")

# 高频虚词/代词单字：单字锚点兜底时忽略，防止"的/了/我"造成误召回
_STOP_CHARS = set("的了是在就不这那也都很啊吧呢吗么呀哦哈嗯与和跟对被把有没我你他她它您个这什么怎么这样那样还有所以但是而且如果虽虽然然后因此于是")


def normalize_text(text: str) -> str:
    """统一全半角、去多余空白；用于哈希与展示前的清洗。"""
    if not text:
        return ""
    text = unicodedata.normalize("NFKC", str(text))
    return re.sub(r"\s+", " ", text).strip()


def canonical_text(text: str) -> str:
    """强规范化：去标点、小写。用于内容去重哈希。"""
    text = normalize_text(text).lower()
    return _PUNCT_RE.sub("", text)


def content_hash(text: str) -> str:
    """内容指纹：同一 scope 内用于精确去重。"""
    return hashlib.sha1(canonical_text(text).encode("utf-8")).hexdigest()


def tokenize(text: str) -> set[str]:
    """检索分词。

    - 中文按单字 + 二元组（bigram）切分，保留词序信息且无需分词器；
    - 英文/数字按连续片段切分并小写。
    """
    if not text:
        return set()
    text = normalize_text(text).lower()
    tokens: set[str] = set()
    for word in _WORD_RE.findall(text):
        if _CJK_RE.match(word):
            tokens.add(word)
            if len(word) >= 1:
                # word 在此分支是单个汉字
                pass
        else:
            if len(word) >= 2:
                tokens.add(word)
    # 中文 bigram：从规范化文本里整体抽取
    cjk_runs = re.findall(r"[\u4e00-\u9fff\u3400-\u4dbf]+", text)
    for run in cjk_runs:
        for i in range(len(run)):
            tokens.add(run[i])
            if i + 1 < len(run):
                tokens.add(run[i: i + 2])
    return {t for t in tokens if t}


def jaccard(a: Iterable[str], b: Iterable[str]) -> float:
    """词集 Jaccard 相似度。"""
    sa, sb = set(a), set(b)
    if not sa or not sb:
        return 0.0
    inter = len(sa & sb)
    union = len(sa | sb)
    return inter / union if union else 0.0


def keyword_score(query: str, content: str, tags: Iterable[str]) -> float:
    """关键词得分：词级重叠为主，标签单字锚点兜底。

    中文追问经常换说法（"那只猫" vs 记忆里的"小奶猫"），词级 Jaccard 会漏检。
    标签是凝星时写入的检索锚点，因此查询与标签哪怕只共享一个非停用字，
    也视为一次有效的主题命中——这让纯关键词降级模式依然"像人一样联想"。
    """
    q_tokens = tokenize(query)
    if not q_tokens:
        return 0.0
    c_tokens = tokenize(content)
    tag_text = " ".join(t for t in tags if t)
    t_tokens = tokenize(tag_text)
    base = jaccard(q_tokens, c_tokens)
    tag_hit = jaccard(q_tokens, t_tokens)
    score = base * 0.8 + tag_hit * 0.9

    # 单字锚点兜底（CJK）：查询与标签共享的非停用单字
    q_chars = {t for t in q_tokens if len(t) == 1 and t not in _STOP_CHARS}
    if q_chars:
        tag_chars = {t for t in t_tokens if len(t) == 1}
        content_chars = {t for t in c_tokens if len(t) == 1}
        tag_char_hits = len(q_chars & tag_chars)
        if tag_char_hits:
            score = max(score, min(0.9, 0.18 + 0.06 * tag_char_hits))
        elif q_chars & content_chars:
            score = max(score, 0.10)
    return min(1.0, score)


def cosine(a: list[float] | None, b: list[float] | None) -> float:
    """余弦相似度；任一向量无效时返回 0。"""
    if not a or not b or len(a) != len(b):
        return 0.0
    dot = 0.0
    na = 0.0
    nb = 0.0
    for x, y in zip(a, b):
        dot += x * y
        na += x * x
        nb += y * y
    if na <= 1e-12 or nb <= 1e-12:
        return 0.0
    return dot / math.sqrt(na * nb)


# ---------------------------------------------------------------------------
# JSON 容错解析：LLM 的输出永远要当"可能会坏"来处理
# ---------------------------------------------------------------------------

_FENCE_RE = re.compile(r"^```[a-zA-Z0-9_-]*\s*|\s*```$", re.MULTILINE)
_TRAILING_COMMA_RE = re.compile(r",(\s*[}\]])")


def strip_code_fence(text: str) -> str:
    text = (text or "").strip()
    text = _FENCE_RE.sub("", text)
    return text.strip()


def extract_json_object(text: str) -> str | None:
    """从任意文本中抽出最外层的 ``{...}``（括号配对、字符串感知）。"""
    text = strip_code_fence(text or "")
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escaped = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
            continue
        if ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start: i + 1]
    return None


def parse_lenient_json(text: str) -> dict[str, Any] | None:
    """尽力把 LLM 输出解析成 dict：去围栏 -> 括号抽取 -> 修尾逗号。"""
    if not text:
        return None
    candidates: list[str] = []
    stripped = strip_code_fence(text)
    candidates.append(stripped)
    extracted = extract_json_object(stripped)
    if extracted and extracted != stripped:
        candidates.insert(0, extracted)
    for cand in candidates:
        for attempt in (cand, _TRAILING_COMMA_RE.sub(r"\1", cand)):
            try:
                obj = json.loads(attempt)
            except (json.JSONDecodeError, ValueError):
                continue
            if isinstance(obj, dict):
                return obj
    return None


def clamp(value: float, low: float, high: float) -> float:
    """数值钳位；非法输入返回 low。"""
    try:
        v = float(value)
    except (TypeError, ValueError):
        return low
    if not math.isfinite(v):
        return low
    return max(low, min(high, v))


def as_tag_list(raw: Any, limit: int = 6, max_len: int = 24) -> list[str]:
    """把 LLM 返回的 tags 字段清洗成干净的标签列表。"""
    if isinstance(raw, str):
        parts = re.split(r"[,，、;；\s]+", raw)
    elif isinstance(raw, (list, tuple)):
        parts = [str(p) for p in raw]
    else:
        parts = []
    tags: list[str] = []
    for part in parts:
        tag = normalize_text(part)
        if not tag or len(tag) > max_len:
            continue
        if tag not in tags:
            tags.append(tag)
        if len(tags) >= limit:
            break
    return tags


def truncate_line(text: str, limit: int) -> str:
    text = normalize_text(text)
    if len(text) <= limit:
        return text
    return text[: max(0, limit - 1)] + "…"
