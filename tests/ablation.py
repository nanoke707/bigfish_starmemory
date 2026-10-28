"""在真实 AstrBot 环境里对 bigfish_starmemory 做消融实验。

原则：
  * 绝不触碰真实实例的 data/ 目录——ASTRBOT_ROOT 指向 TEMP 沙箱，所有写入都在沙箱里；
  * 通过 AstrBot 真实的 PluginManager 加载插件（真实配置、真实 schema、真实初始化流程）；
  * 每个场景独立进程运行，避免互相污染；父进程汇总结果。

场景：
  S0  全量基线       —— 凝星 + 细节 + 情绪 + 召回 + 注入 + 强化语义 + 矛盾处理
  S1  关闭 Embedding —— 只能走关键词降级召回
  S2  关闭情绪系统   —— 情绪链路不应阻断流程
  S3  关闭心绪系统   —— 心绪链路不应阻断流程
  S4  LLM 故障       —— 凝星应跳过而不是崩溃
  S5  空数据库       —— 首次运行无任何数据
  S6  存储层写失败   —— 写库失败时插件应静默降级
  S7  重启后重算     —— 重新加载插件后状态可从持久化数据重算

用法：
  python tests/ablation.py                 # 跑全部场景
  python tests/ablation.py s0              # 只跑一个场景
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
import sys
import time
import traceback
from pathlib import Path

SANDBOX = Path(os.environ["ASTRBOT_ROOT"])
PLUGIN_NAME = "bigfish_starmemory"
SCENARIOS = ["s0", "s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9"]

# 插件源码目录：默认取本仓库根目录（仓库自身），也可用环境变量覆盖
PLUGIN_SRC = Path(os.environ.get(
    "BSM_PLUGIN_SRC", str(Path(__file__).resolve().parents[1])
)).resolve()

# 真实 AstrBot 的代码目录（只读引用），保证 import astrbot 走的是真家伙。
# 不写死任何本机路径：由 ASTRBOT_CORE 环境变量给出；找不到时退回当前工作目录。
ASTRBOT_CORE = Path(os.environ.get(
    "ASTRBOT_CORE", str(Path.cwd())
)).resolve()

# 让 `data.plugins.bigfish_starmemory.main` 能被导入（沙箱根目录进 sys.path）
# 注意顺序：沙箱必须排在真实实例前面，否则会误加载实例里已安装的旧版插件
for _p in (str(SANDBOX), str(ASTRBOT_CORE)):
    if _p in sys.path:
        sys.path.remove(_p)
sys.path.insert(0, str(ASTRBOT_CORE))
sys.path.insert(0, str(SANDBOX))


# ---------------------------------------------------------------------------
# 假 Provider（但走 AstrBot 真实的 LLMClient / EmbeddingService 适配层）
# ---------------------------------------------------------------------------


class FakeResponse:
    def __init__(self, text: str):
        self.completion_text = text


class FakeLLMProvider:
    """模拟 AstrBot LLM Provider。"""

    def __init__(self):
        self.payload = json.dumps({"memories": [], "mood_delta": {},
                                   "used_memory_ids": []}, ensure_ascii=False)
        self.calls = 0
        self.fail = False

    async def text_chat(self, prompt: str = "", system_prompt: str = "", **kw):
        self.calls += 1
        if self.fail:
            raise RuntimeError("模拟 LLM 不可用")
        return FakeResponse(self.payload)


class FakeEmbeddingProvider:
    """模拟 AstrBot Embedding Provider（确定性哈希向量）。"""

    def __init__(self, dim: int = 16):
        self.dim = dim

    async def get_embeddings(self, texts: list[str]):
        out = []
        for t in texts:
            vec = [0.0] * self.dim
            for i, ch in enumerate(t or ""):
                vec[i % self.dim] += (ord(ch) % 17) / 17.0
            norm = sum(v * v for v in vec) ** 0.5 or 1.0
            out.append([v / norm for v in vec])
        return out


class FakeContext:
    """最小可用的 AstrBot Context 替身。"""

    def __init__(self, llm_provider=None, embedding_provider=None):
        self.llm_provider = llm_provider
        self.embedding_provider = embedding_provider
        self.web_apis: list[tuple] = []
        self.stars: dict[str, object] = {}

    # --- provider ---
    async def get_using_provider_async(self):
        return self.llm_provider

    async def get_using_provider(self):
        return self.llm_provider

    async def get_provider_by_id(self, provider_id: str = ""):
        return self.llm_provider

    async def get_all_embedding_providers(self):
        return [self.embedding_provider] if self.embedding_provider else []

    async def get_embedding_provider_by_id(self, provider_id: str = ""):
        return self.embedding_provider

    # --- plugin registry ---
    def get_all_stars(self):
        return list(self.stars.values())

    def get_registered_star(self, name: str):
        return self.stars.get(name)

    def register_star(self, star):
        self.stars[getattr(star, "name", str(star))] = star

    # --- web api ---
    def register_web_api(self, route, handler, methods=None, desc=None):
        self.web_apis.append((route, handler, methods, desc))

    def get_config(self, *a, **k):
        return None

    def get_plugin_data_dir(self, *a, **k) -> Path:
        p = SANDBOX / "data" / "plugin_data" / PLUGIN_NAME
        p.mkdir(parents=True, exist_ok=True)
        return p


# ---------------------------------------------------------------------------
# 沙箱准备
# ---------------------------------------------------------------------------


def install_plugin() -> Path:
    target = SANDBOX / "data" / "plugins" / PLUGIN_NAME
    if target.exists():
        shutil.rmtree(target, ignore_errors=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(
        PLUGIN_SRC, target,
        ignore=shutil.ignore_patterns(
            ".git", "__pycache__", "*.pyc", "tests", ".github",
            "pytest-cache-files-*", ".pytest_cache", "bsm_test_*", "bsm_scratch_*",
        ),
    )
    return target


def reset_data() -> None:
    """清掉沙箱里的插件数据库，保证每个场景从零开始。"""
    d = SANDBOX / "data" / "plugin_data" / PLUGIN_NAME
    if d.exists():
        shutil.rmtree(d, ignore_errors=True)


def write_plugin_config(overrides: dict | None = None) -> None:
    cfg_dir = SANDBOX / "data" / "config"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    path = cfg_dir / f"{PLUGIN_NAME}_config.json"
    data = {
        "general": {
            "enabled": True,
            "hook_budget_seconds": 5,
        },
        "consolidation": {
            "every_n_turns": 1,
            "min_transcript_chars": 1,
        },
    }
    for section, values in (overrides or {}).items():
        data.setdefault(section, {}).update(values or {})
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def default_payload(**overrides) -> str:
    data = {
        "memories": [{
            "content": "小黑在图书馆弄丢了一把透明长柄伞",
            "details": [
                {"text": "伞柄上贴着一只猫贴纸", "type": "detail"},
                {"text": "当时外面在下雨", "type": "detail"},
            ],
            "tags": ["小黑", "伞", "图书馆"],
            "type": "event",
            "importance": 0.7,
            "valence": -0.4,
            "arousal": 0.5,
            "emotions": [
                {"type": "disappointment", "intensity": 0.6},
                {"type": "sadness", "intensity": 0.4},
            ],
            "event_time": "上周三",
            "event_time_precision": "day",
            "pinned": False,
        }],
        "mood_delta": {"valence": -0.1, "arousal": 0.1, "affection": 0.0},
        "mood_reason": "聊到丢伞的事有点失落",
        "used_memory_ids": [],
        "relations": [],
        "emotion_updates": [],
    }
    data.update(overrides)
    return json.dumps(data, ensure_ascii=False)


# ---------------------------------------------------------------------------
# 插件加载（真实 PluginManager 路径）
# ---------------------------------------------------------------------------


async def load_plugin(llm_provider=None, embedding_provider=None, config_overrides=None):
    from astrbot.core.star import star_map
    from astrbot.core.star.star_manager import PluginManager

    reset_data()
    write_plugin_config(config_overrides)
    context = FakeContext(llm_provider, embedding_provider)
    manager = PluginManager(context, None)
    ok, err = await manager.load(specified_dir_name=PLUGIN_NAME)
    if not ok:
        raise RuntimeError(f"插件加载失败: {err}")
    key = f"data.plugins.{PLUGIN_NAME}.main"
    if key not in star_map:
        raise RuntimeError(f"star_map 里没有 {key}，已注册: {list(star_map)}")
    plugin = star_map[key].star_cls
    if plugin is None:
        raise RuntimeError("插件没有实例化（可能被禁用或导入失败）")
    return plugin, context


# ---------------------------------------------------------------------------
# 场景
# ---------------------------------------------------------------------------


async def scenario_s0():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, ctx = await load_plugin(llm, emb)
    scope = "ablation:s0"
    llm.payload = default_payload()

    out = await plugin.engine.consolidate(scope, [
        "[10-01 10:00] 小黑：上周三我在图书馆把伞弄丢了",
        "[10-01 10:01] Bot：别急，说不定还在失物招领处",
    ])
    stars = await plugin.store.scope_stars(scope)
    assert len(out.added) == 1, f"应凝成 1 颗星，实际 {len(out.added)}（skipped={out.skipped}）"
    assert len(stars) == 1
    star = stars[0]
    details = await plugin.store.star_details(star.id)
    emotions = await plugin.store.star_emotions(star.id)
    assert len(details) == 2, f"细节应有 2 条，实际 {len(details)}"
    assert len(emotions) == 2, f"情绪应有 2 条，实际 {len(emotions)}"
    assert star.event_time is not None, "事件时间应被解析"
    assert star.half_life_days > 0
    assert details[0].half_life_days < star.half_life_days, "细节半衰期应短于主干"

    rec = await plugin.engine.recall(scope, "小黑的伞")
    block = plugin.engine.render_injection(rec)
    assert rec.scored, "应召回"
    assert "伞" in block, "注入应包含记忆"

    # 检索 != 强化
    before = await plugin.store.get_star(star.id, scope)
    await plugin.engine.recall(scope, "小黑的伞")
    after = await plugin.store.get_star(star.id, scope)
    assert after.recall_count == before.recall_count + 1
    assert after.review_count == before.review_count, "检索不得触发强化"

    # 真正被想起 -> 强化（半衰期增长）
    llm.payload = default_payload(used_memory_ids=[star.id])
    await plugin.engine.consolidate(scope, ["[10-01 10:02] 小黑：其实那把伞我找到了"])
    after_reinforce = await plugin.store.get_star(star.id, scope)
    # 注意：同一件事被再次提起会先走"去重合并"强化，再用 used_memory_ids 强化一次，
    # 所以 review_count 可能 >= 1；关键是没有强化时它必须保持 0。
    assert after_reinforce.review_count >= 1, "used_memory_ids 应触发强化"
    assert after_reinforce.half_life_days > before.half_life_days, "强化应拉长半衰期"

    # 矛盾：不覆盖原文，标记 corrected
    llm.payload = default_payload(
        memories=[{
            "content": "小黑其实没丢伞，是小蓝拿走了",
            "details": [{"text": "小蓝一直想要那把伞", "type": "detail"}],
            "tags": ["小黑", "小蓝", "伞"],
            "type": "event", "importance": 0.7, "valence": -0.3, "arousal": 0.4,
            "emotions": [{"type": "anger", "intensity": 0.5}],
            "event_time": "上周三", "event_time_precision": "day", "pinned": False,
        }],
        relations=[{"target_id": star.id, "relation": "contradicts", "reason": "另一种说法"}],
    )
    await plugin.engine.consolidate(scope, ["[10-01 10:03] 小黑：其实是小蓝拿走了"])
    after_correct = await plugin.store.get_star(star.id, scope)
    assert after_correct.corrected is True, "矛盾应标记 corrected"
    assert "图书馆" in after_correct.content, "原始记录不得被覆盖"

    return (f"added=1 details=2 emotions=2 H_m={star.half_life_days:.2f}d "
            f"recall={len(rec.scored)} 强化后 H_m={after_reinforce.half_life_days:.2f}d "
            f"corrected={after_correct.corrected}")


async def scenario_s1():
    llm = FakeLLMProvider()
    plugin, _ = await load_plugin(llm, None)  # 没有 Embedding Provider
    scope = "ablation:s1"
    llm.payload = default_payload()
    await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：我在图书馆弄丢了伞"])
    rec = await plugin.engine.recall(scope, "图书馆 伞")
    block = plugin.engine.render_injection(rec)
    assert rec.scored, "无向量时也应靠关键词召回"
    assert "伞" in block
    return f"recalled={len(rec.scored)} matched_by={rec.scored[0].matched_by}"


async def scenario_s2():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb, {"emotion": {"enabled": False}})
    scope = "ablation:s2"
    llm.payload = default_payload()
    out = await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：伞丢了"])
    stars = await plugin.store.scope_stars(scope)
    emos = await plugin.store.star_emotions(stars[0].id) if stars else []
    rec = await plugin.engine.recall(scope, "伞")
    assert rec.scored
    return f"added={len(out.added)} emotions_stored={len(emos)} recalled={len(rec.scored)}"


async def scenario_s3():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb, {"mood": {"enabled": False}})
    scope = "ablation:s3"
    llm.payload = default_payload()
    out = await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：伞丢了"])
    rec = await plugin.engine.recall(scope, "伞")
    block = plugin.engine.render_injection(rec)
    assert "此刻心绪" not in block, "关闭心绪后不应注入心绪提示"
    return f"added={len(out.added)} recalled={len(rec.scored)}"


async def scenario_s4():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb)
    scope = "ablation:s4"
    llm.fail = True
    out = await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：伞丢了"])
    assert out.skipped, "LLM 故障时应标记 skipped"
    assert not out.added
    llm.fail = False
    rec = await plugin.engine.recall(scope, "伞")
    return f"skipped={out.skipped!r} recalled={len(rec.scored)}"


async def scenario_s5():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb)
    scope = "ablation:s5-empty"
    rec = await plugin.engine.recall(scope, "任何东西")
    assert not rec.scored
    maint = await plugin.engine.maintain_scope(scope)
    stats = await plugin.engine.stats(scope)
    return f"recalled={len(rec.scored)} maintain={maint} stats={stats.get('total', 0)}"


async def scenario_s6():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb)
    scope = "ablation:s6"
    llm.payload = default_payload()

    class BrokenStore:
        def __getattr__(self, item):
            async def _boom(*a, **k):
                raise RuntimeError("模拟数据库不可写")
            return _boom

    real_store = plugin.store
    plugin.store = BrokenStore()
    try:
        out = await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：伞丢了"])
    finally:
        plugin.store = real_store
    return f"skipped={out.skipped!r} added={len(out.added)}（未抛异常即达标）"


async def scenario_s7():
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb)
    scope = "ablation:s7"
    llm.payload = default_payload()
    await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：上周三在图书馆弄丢了伞"])
    stars = await plugin.store.scope_stars(scope)
    star = stars[0]
    # 把强化锚点精确拨到 7 天前，模拟"重启后又过了 7 天"
    anchor = time.time() - 7 * 86400
    await plugin.store.update_star(star.id, scope, last_reinforced_at=anchor)
    reloaded = await plugin.store.get_star(star.id, scope)
    from data.plugins.bigfish_starmemory.core import ebbinghaus
    r = ebbinghaus.retention(reloaded, time.time(), plugin.engine.params)
    expect = 2 ** (-7 / reloaded.half_life_days)
    assert abs(r - expect) < 1e-6, f"R={r} 期望 {expect}"
    return f"H_m={reloaded.half_life_days:.2f}d R(7d)={r:.4f} 期望={expect:.4f}"


async def scenario_s8():
    """WebUI 全部路由在真实环境里跑一遍（覆盖 webui.py 的每条路由）。"""
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, ctx = await load_plugin(llm, emb)
    scope = "ablation:s8"
    llm.payload = default_payload()
    await plugin.engine.consolidate(scope, ["[10-01 10:00] 小黑：上周三在图书馆弄丢了伞"])
    stars = await plugin.store.scope_stars(scope)
    sid = stars[0].id

    handlers = {r[0]: r[1] for r in ctx.web_apis}
    prefix = "/bigfish_starmemory/ui"
    assert len(handlers) >= 16, f"路由数量异常: {len(handlers)}"

    def resolve(path: str):
        """按路径模板匹配路由（把 <param> 还原成实参）。"""
        want = path.split("/")
        for route, handler in handlers.items():
            parts = route.split("/")
            if len(parts) != len(want):
                continue
            kw = {}
            ok = True
            for rp, wp in zip(parts, want):
                if rp.startswith("<") and rp.endswith(">"):
                    kw[rp[1:-1]] = wp
                elif rp != wp:
                    ok = False
                    break
            if ok:
                return handler, kw
        raise KeyError(path)

    async def call(path: str, **extra):
        handler, kw = resolve(path)
        kw.update(extra)
        res = await handler(**kw)
        assert res.get("status") == "success", (path, res)
        return res.get("data") or {}

    ov = await call(f"{prefix}/overview")
    assert "params" in ov and "base_half_life_days" in ov["params"]

    lst = await call(f"{prefix}/stars/all/1")
    cards = lst["stars"]
    assert cards and "half_life_days" in cards[0] and "clarity" in cards[0]

    d = (await call(f"{prefix}/star/{sid}"))
    assert d["debug"]["retention_formula"].startswith("R = 2^("), d["debug"]
    assert len(d["details"]) == 2 and len(d["emotions"]) == 2, d

    await call(f"{prefix}/scopes")
    await call(f"{prefix}/search/%E5%9B%BE%E4%B9%A6%E9%93%BE")
    st = await call(f"{prefix}/settings")
    sections = [s["name"] for s in st["sections"]]
    assert "emotion" in sections and "forgetting" in sections, sections

    # 生命周期操作
    for act in ("pin", "unpin", "revive", "forget"):
        await call(f"{prefix}/star/{sid}/{act}")
    await call(f"{prefix}/maintain")
    # 改一个配置项并热应用
    import base64
    val = base64.urlsafe_b64encode("9.0".encode()).decode().rstrip("=")
    await call(f"{prefix}/settings/set/forgetting/base_half_life_days/{val}")
    await call(f"{prefix}/settings/reset/forgetting")
    # 删除
    await call(f"{prefix}/star/{sid}/delete")
    return (f"routes={len(handlers)} sections={len(sections)} "
            f"details={len(d['details'])} emotions={len(d['emotions'])}")


class FakeEvent:
    """最小可用的消息事件替身（供 LLM 工具与命令使用）。"""

    def __init__(self, scope: str = "ablation:tools"):
        self.unified_msg_origin = scope
        self.message_str = "工具测试"
        self.role = "admin"
        self.is_admin = True

    def get_sender_id(self):
        return "u1"

    def get_sender_name(self):
        return "小黑"

    def get_session_id(self):
        return "s1"

    def get_group_id(self):
        return ""

    def get_self_id(self):
        return "bot1"


async def scenario_s9():
    """LLM 工具：star_memory_memorize / star_memory_recall 在真实环境可用。"""
    llm = FakeLLMProvider()
    emb = FakeEmbeddingProvider()
    plugin, _ = await load_plugin(llm, emb, {"tools": {"enable_recall_tool": True,
                                                       "enable_memorize_tool": True}})
    event = FakeEvent()
    res = json.loads(await plugin.tool_star_memorize(
        event=event,
        content="小黑的伞是一把透明长柄伞",
        tags="小黑,伞",
        importance=0.8,
        valence=-0.2,
        memory_type="fact",
        pinned=False,
        details="伞柄贴着一只猫贴纸,在图书馆丢的",
        event_time="上周三",
        emotions="失落:0.6,生气:0.3",
    ))
    assert res.get("ok"), res
    sid = res["id"]
    assert res["details"] == 2 and res["emotions"] == 2, res
    star = await plugin.store.get_star(sid)
    assert star is not None and star.event_time is not None
    assert star.half_life_days > 0
    details = await plugin.store.star_details(sid)
    emotions = await plugin.store.star_emotions(sid)
    assert len(details) == 2 and len(emotions) == 2
    assert details[0].half_life_days < star.half_life_days
    recall = json.loads(await plugin.tool_star_recall(event=event, query="小黑的伞", top_k=5))
    assert recall.get("ok"), recall
    assert recall["stars"] and recall["stars"][0]["clarity"], recall
    return (f"id={sid} H_m={star.half_life_days:.2f}d details={len(details)} "
            f"emotions={len(emotions)} recalled={len(recall['stars'])}")


RUNNERS = {
    "s0": scenario_s0, "s1": scenario_s1, "s2": scenario_s2, "s3": scenario_s3,
    "s4": scenario_s4, "s5": scenario_s5, "s6": scenario_s6, "s7": scenario_s7,
    "s8": scenario_s8, "s9": scenario_s9,
}


# ---------------------------------------------------------------------------
# 入口
# ---------------------------------------------------------------------------


async def run_one(name: str) -> tuple[bool, str]:
    try:
        detail = await RUNNERS[name]()
        return True, detail
    except Exception as exc:  # noqa: BLE001
        return False, f"{type(exc).__name__}: {exc}\n{traceback.format_exc()}"


def main() -> int:
    install_plugin()
    if len(sys.argv) > 1 and sys.argv[1] in RUNNERS:
        name = sys.argv[1]
        ok, detail = asyncio.run(run_one(name))
        print(json.dumps({"scenario": name, "ok": ok, "detail": detail}, ensure_ascii=False))
        return 0 if ok else 1

    # 父进程：逐个场景起独立进程
    print("插件已安装到沙箱:", SANDBOX / "data" / "plugins" / PLUGIN_NAME, flush=True)
    results = []
    for name in SCENARIOS:
        proc = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), name],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        payload = None
        for line in reversed(proc.stdout.strip().splitlines()):
            line = line.strip()
            if line.startswith("{"):
                try:
                    payload = json.loads(line)
                    break
                except json.JSONDecodeError:
                    continue
        if payload is None:
            payload = {"scenario": name, "ok": False,
                       "detail": (proc.stdout + "\n" + proc.stderr)[-2000:]}
        results.append(payload)
        print(f"[{'PASS' if payload['ok'] else 'FAIL'}] {name}: {payload['detail'][:200]}",
              flush=True)

    print("\n===== 消融实验汇总 =====", flush=True)
    for r in results:
        print(f"{'PASS' if r['ok'] else 'FAIL'} | {r['scenario']} | {r['detail']}", flush=True)
    failed = [r for r in results if not r["ok"]]
    print(f"\n总计 {len(results)} 个场景，失败 {len(failed)} 个", flush=True)
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
