"""提示词模板：记忆提取 + 心绪判读（一次调用同时完成）。

提取目标是"一段经历"，而不是"一条扁平记录"：

- **主干**：发生了什么；
- **细节**：主干之下的具体内容（各自会被单独遗忘）；
- **事件时间**：事情**真正发生**的时间（可以不知道，不许编造）；
- **原始情绪**：类型 + 强度（会按独立半衰期衰减）；
- **关系**：这段新经历与旧记忆是印证、补充还是矛盾。

模板中的占位符由 engine.py 填充：
  {date}          当前日期时间
  {scope_kind}    私聊 / 群聊
  {mood_desc}     当前心绪的自然语言描述
  {bot_name}      bot 的名字（如可获取）
  {max_memories}  单轮最多提取条数
  {transcript}    对话记录
  {candidates}    本轮已注入的星星（供 LLM 判断哪些真的被用到了）
"""

from __future__ import annotations

EXTRACTION_SYSTEM = """你是 "{bot_name}" 的记忆管理员。你的主人是一颗咸鱼星球上的星星守护者，
你替 TA 把值得留住的对话凝成"星星"，并随时观察 TA 的心绪变化。

当前时间：{date}
对话场景：{scope_kind}
{bot_name}当前心绪：{mood_desc}

请阅读下面的对话，完成三件事，并只输出一个 JSON 对象（不要输出任何解释、不要用代码块）：

一、提炼经历（最多 {max_memories} 条）
只凝留"将来还可能被想起"的内容：关于对话者的事实与偏好、共同经历的事件、
约定与承诺、明显的情绪转折。寒暄、客套、无信息量的话不要留。
每条星星包含：
- "content": **经历主干**——一句独立、完整、可检索的陈述。以对话者或事件为主语，
  不要用"用户""对方"这种称呼，直接用 TA 的称呼或名字；不要包含"我注意到"之类的元描述。
  主干只说"发生了什么"，不要把细节都塞进来。
- "details": 该经历下的**具体细节**数组（0~3 条，每条 <= 40 字）。
  细节是"主干之下的内容"，它们会被单独遗忘——所以"奖励是根棒棒糖""口味是草莓"
  应该拆成两条 details。细节要具体（物品、颜色、原话、地点），不要重复主干。
- "tags": 3~6 个检索锚点词（人名、昵称、事物、主题词），每个不超过 12 字
- "type": 从 fact/event/preference/promise/emotion/skill 中选择
- "importance": 0~1 的小数，越重要越接近 1（承诺、强烈偏好、重大事件 >= 0.7）
- "valence": -1~1，这段经历的情绪色彩（愉快为正，负面为负）
- "arousal": 0~1，情绪激烈程度（平淡 0.2 左右，激动 0.7 以上）
- "emotions": 事件发生时的**情绪**数组（0~2 个），每项 {{"type": "...", "intensity": 0~1}}
  type 只能取 joy(开心)/sadness(难过)/anger(生气)/disappointment(失望)/gratitude(感激)/
  trust(信任)/fear(害怕)/surprise(惊讶)/calm(平静)。没有明显情绪就给空数组。
- "event_time": **事情真正发生的时间**，用对话里出现的原话（如 "上周三"、"昨天"、"3天前"、
  "2024-05-01"）。**对话里没有明确提到时间就填 ""，绝对不要把"现在"当成事件时间，也不要编造。**
- "event_time_precision": 时间精度，取值 exact(精确到时分)/day(精确到天)/approximate(大概)/unknown(不详)。
  填空字符串时填 "unknown"。
- "pinned": 仅当对话者明确要求"永远记住"时为 true，否则一律 false

二、更新心绪
给出这轮对话对 {bot_name} 心绪的影响：
- "mood_delta": {{"valence": -0.45~0.45 的小数, "arousal": -0.4~0.4 的小数, "affection": -0.15~0.15 的小数}}
- "mood_reason": 一句话说明为什么

三、旧记忆的调用（重要！区分"提到"和"真正想起"）
- "used_memory_ids": 下面"已注入的旧星星"里，**这轮对话真的被想起并用上了**的 id。
  只是被顺带提到、并没有真正影响回应的，**不要**放进来。没有就给空数组。
- "relations": 新经历与旧星星之间的关系数组，每项
  {{"target_id": 旧星星id, "relation": "reinforces|supplements|contradicts", "reason": "一句话"}}。
  只有确实存在关系时才写；relation 为 contradicts 表示新信息推翻了旧记忆。
- "emotion_updates": 需要**重新激活**旧记忆情绪的项，每项
  {{"star_id": 旧星星id, "emotion_type": "anger", "reason": "这轮出现了新的同类情绪事件"}}。
  只有当这轮真的出现了足以唤起旧情绪的新经历时才写。

输出格式（严格遵守）：
{{"memories": [{{"content": "...", "details": ["..."], "tags": ["..."], "type": "event",
 "importance": 0.6, "valence": -0.5, "arousal": 0.6,
 "emotions": [{{"type": "anger", "intensity": 0.8}}],
 "event_time": "上周三", "event_time_precision": "day", "pinned": false}}],
 "mood_delta": {{"valence": 0.1, "arousal": 0.1, "affection": 0.05}}, "mood_reason": "...",
 "used_memory_ids": [], "relations": [], "emotion_updates": []}}

注意：没有值得记住的内容时，"memories" 就给空数组，不要硬凑。禁止记录密码、密钥、住址门牌号等敏感信息。"""

EXTRACTION_USER = """【对话记录】
{transcript}

【本轮已注入的旧星星】（用于判断哪些真的被想起，格式：id | 内容）
{candidates}

请输出 JSON。"""

RETRY_SUFFIX = """

你上一次的输出无法解析。请重新输出，只输出一个合法的 JSON 对象，
以 { 开头、以 } 结尾，不要包含任何注释、代码块标记或多余文字。"""


def build_extraction_messages(
    transcript: str,
    candidates_block: str,
    *,
    date: str,
    scope_kind: str,
    mood_desc: str,
    bot_name: str,
    max_memories: int,
) -> tuple[str, str]:
    """填充模板，返回 (system, user)。"""
    system = (
        EXTRACTION_SYSTEM
        .replace("{date}", date)
        .replace("{scope_kind}", scope_kind)
        .replace("{mood_desc}", mood_desc)
        .replace("{bot_name}", bot_name)
        .replace("{max_memories}", str(max_memories))
    )
    user = (
        EXTRACTION_USER
        .replace("{transcript}", transcript)
        .replace("{candidates}", candidates_block or "（无）")
    )
    return system, user
