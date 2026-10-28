# bigfish_starmemory · 咸鱼星空记忆

[![CI](https://github.com/nanoke707/bigfish_starmemory/actions/workflows/ci.yml/badge.svg)](https://github.com/nanoke707/bigfish_starmemory/actions/workflows/ci.yml)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![License](https://img.shields.io/badge/License-MIT-green)
![AstrBot](https://img.shields.io/badge/AstrBot-v4.x-7aa5ff)

<p align="center">
  <img src="logo.png" width="160" alt="咸鱼星空记忆 logo"/>
</p>

**把每段经历存成一颗有时间的星星**，为 [AstrBot](https://github.com/AstrBotDevs/AstrBot) 提供记忆的召回与保存。
记忆用艾宾浩斯半衰期遗忘，情绪有它自己的独立半衰期，细节可以在同一件事里单独模糊。

> 一条记忆不是一行文本，而是**一段经历**：说了什么、什么时候发生的、当时什么心情、
> 现在还记得多少、情绪还剩多少、被想起过几次。刚记下时它很亮，随时间自然变暗；
> 被真正想起时重新点亮，而"检索过"本身**不算**想起。

---

## ✨ 特性

### 🌌 星空记忆模型（半衰期版艾宾浩斯遗忘曲线）

- **保持率即亮度**：`R(t) = 2^(-t / H_m)`，`H_m` 是这颗星星的**半衰期**（等价于 `exp(-t/S)`，`H_m = S·ln2`）；
- **半衰期因记忆而异**：写入时由重要度与情绪浓淡一次性算出，之后只被"真正的强化"拉长——
  绝不所有记忆统一一个固定周期；
- **事件时间 ≠ 记录时间**：记忆从**事情发生的那一刻**开始遗忘（锚点优先级：
  最近一次有效强化 → 事件发生时间 → 记录写入时间）；
- **回忆有清晰度分级**：`可靠 / 模糊 / 几乎不记得 / 无法可靠回忆`——
  无法可靠回忆的内容**不会进入提示词**，绝不当作事实断言；
- **细节可以单独模糊**：一颗星星 = 主干 + 若干细节，细节各有自己的半衰期，
  同一件事里可以"记得清楚主干、想不起细节"；
- **遗忘 ≠ 删除**：淡出的星星仍在库里，相似情境下可以被**重新激活**；
- **每日维护**：凌晨自动推进全部星空的遗忘曲线，错过自动补跑。

### 💗 情绪有它自己的半衰期

- `E(t) = E0 · 2^(-t / H_e)`：**每种情绪可单独配置**半衰期（开心 3 天、生气 2 天、信任 14 天…）；
- 原始强度 `E0` **永不被改写**，衰减只改变"此刻还剩多少"；
- **情绪衰减与记忆清晰度完全独立**：记得清楚的事，情绪可能早已散尽；
  记忆模糊的事，情绪可能还留着一丝；
- 重新激活只在本轮**临时放大**残留，既不重置半衰期，也不恢复已模糊的细节。

### 🔗 检索 / 强化 / 再激活，三件事分开

| 动作 | 含义 | 会改变什么 |
| --- | --- | --- |
| **检索** | 系统把候选记忆塞进上下文 | 只加 `recall_count`，**不动**遗忘状态 |
| **强化** | 这次真的想起来了 | 拉长 `H_m`、锚点推到当下、记录一次 |
| **再激活** | 相似情境唤起淡忘的旧经历 | 记录一次，临时放大情绪残留，**不恢复细节** |

### 🌫️ 星云心绪（bot 的情绪状态）

- 三轴情绪：**愉悦 valence**（-1~1）、**激动 arousal**（0~1）、**好感 affection**（0~1，对当前对话者）；
- 每轮对话由 LLM 判读心绪增量并更新，情绪随时间自然回归基线；
- **心境一致性回忆**：与当前心情同频的旧事更容易浮现；
- **回忆共鸣**：想起的旧星星会按其保持率与重要度轻轻牵引此刻心绪；
- **心绪注入**：当前心绪随记忆一起注入提示词，让回复自然带上情绪色彩。

### 🛠️ 完整的召回 / 保存链路

- `on_llm_request`：混合检索（向量 + CJK bigram 关键词降级）→ 亮度可见度 → 情绪一致性 → 灵光一现
  → 注入星空记忆块与心绪；
- `after_message_sent`：后台把对话提炼成结构化**经历**（主干 / 细节 / 标签 / 类型 / 重要度 /
  事件时间 / 情绪），带精确哈希 + 语义向量双重去重；
- **复习点名**：LLM 汇报本轮真正用到的旧星星，它们才获得强化；
- **关系链**：`强化 / 补充 / 纠正 / 回忆` 四种关系；纠正只打标记，**原始记录永不被覆盖**；
- **群聊旁听（星尘）**：未唤醒 bot 的群消息暂存为背景上下文；
- **Agent 工具**：`star_memory_recall`（主动回忆）、`star_memory_memorize`（主动凝星，支持
  `details / event_time / emotions` 参数）；
- **零第三方依赖**：核心只靠标准库运行，向量不可用时自动降级关键词检索，星星不会消失。

## 📦 安装

1. 下载或克隆本仓库；
2. 将 `bigfish_starmemory` 文件夹放入 AstrBot 的 `data/plugins/` 目录；
3. 在 AstrBot WebUI 中刷新插件并启用；
4. （推荐）在插件配置中填写一个 Embedding 提供商 ID 以启用语义检索。

> 无需安装任何 pip 依赖。记忆数据存储在 `data/plugin_data/bigfish_starmemory/`。

## ⚙️ 使用

### 命令

| 命令 | 说明 | 权限 |
| --- | --- | --- |
| `/star status` | 查看星空状态与当前心绪 | 所有人 |
| `/star search <词>` | 检索星星 | 所有人 |
| `/star recent [n]` | 最近的 n 颗星星 | 所有人 |
| `/star detail <id>` | 一颗星星的完整状态（时间 / 清晰度 / 细节 / 情绪残留） | 所有人 |
| `/star mood [reset]` | 查看 / 重置心绪 | reset 需管理员 |
| `/star forget <id>` | 立即熄灭一颗星 | 管理员 |
| `/star pin <id>` / `/star unpin <id>` | 珍藏 / 取消珍藏（永不熄灭） | 管理员 |
| `/star maintain` | 立即执行遗忘维护 | 管理员 |
| `/star clear` | 归档当前会话全部星星 | 管理员 |
| `/star help` | 帮助 | 所有人 |

### 配置（WebUI 可视化）

全部参数都带中文说明，常用的几个：

- **记忆归属**：`session`（每个会话一片星空，默认）/ `user`（跟随人）/ `global`（共享）；
- **每次注入星星数 / 召回阈值 / 注入字符上限**：控制"想起多少"；
- **基础半衰期 / 最大半衰期 / 细节半衰期比例**：控制"忘多快"；
- **清晰度阈值（可靠 / 模糊）**：决定一颗星星怎么说出口；
- **情绪半衰期**（基准 + 每种情绪单独覆盖）、情绪残留地板、**再激活增益**；
- **检索即复习**：默认关闭（检索 ≠ 强化）；
- **每 N 轮凝星一次**：省 token 的懒人模式。

### 🖥️ 调试控制台（插件拓展页）

插件自带一个 WebUI 调试控制台，安装后在 AstrBot WebUI 的
**插件管理 → 咸鱼星空记忆 → 拓展页** 打开：

- **星空总览**：星星总数 / 明亮 / 变暗 / 熄灭 / 珍藏统计，每个星域的心绪三轴；
- **星空列表**：每颗星星显示**事件时间、半衰期、回忆清晰度**与亮度条，支持珍藏 / 熄灭 / 重新点亮 / 删除；
- **星星详情**：完整调试信息——`R = 2^(-Δt / H_m)` 当前取值、锚点来源、再被想起能长到多少天，
  以及「细节（各自独立遗忘）」「情绪残留（独立半衰期）」「关系」「重新激活记录」四个区块；
- **检索调试**：以放宽到 1/3 的阈值展示原始检索得分与命中方式（vector / keyword），且**不改变任何星星状态**；
- **会话与凝星**：手动触发某个星域的立即凝星、立即执行一次全局遗忘维护；
- **⚙️ 设置**：直接配置 LLM / Embedding 提供商与全部十节参数，**保存即热生效**，支持每节一键恢复默认。

所有 API 走 AstrBot 原生插件 WebAPI（`/api/v1/plugins/extensions/...`），鉴权由面板处理，
页面通过官方桥接 SDK（`AstrBotPluginView`）通信，无需额外配置。

## 🧮 算法备忘

**记忆保持率（半衰期形式）**

```
R(t) = 2^(-t / H_m)              等价于 exp(-t / S)，其中 H_m = S · ln2
t    = now - 锚点时间            锚点 = 最近有效强化 > 事件发生时间 > 记录创建时间
```

**初始半衰期（写入时一次算清）**

```
H_m = clamp(base_half_life_days
             × (importance_base + importance_span × importance)
             × (1 + emotion_gain × emotional_intensity),
           min_half_life_days, max_half_life_days)
emotional_intensity = max(|valence|, arousal, max(情绪强度…))
```

**强化（间隔效应）**

```
H_m' = H_m + review_boost_days × (1 + spacing_bonus × min(Δt, 7)/7) × (0.6 + 0.4 × importance)
锚点 ← now
```

**情绪残留（独立半衰期）**

```
E(t) = E0 × 2^(-t / H_e)        H_e 按情绪类型取配置值
E0   永不改写；重新激活只做本轮临时增益，且不超过 E0
```

**细节保持率**

```
H_detail = max(detail_half_life_min_days, H_m × detail_half_life_ratio)   （原话略长一点）
```

**回忆清晰度分级**

```
clear   R ≥ 0.55    可靠，可当事实说
vague   R ≥ 0.20    模糊，只能含糊其辞
faint   R >  0       几乎不记得，可提"好像有过"
unknown            无法可靠回忆 —— 不注入
```

**召回综合分**

```
score = (0.65×向量相似度 + 0.35×关键词得分) × 亮度可见度 × 心境一致性 × 灵光一现
亮度可见度 = 0.35 + 0.65 × R^0.45   （暗星仍有机会，但更难浮现）
```

## 🗂️ 目录结构

```
bigfish_starmemory/
├── main.py              # AstrBot 接入层：钩子 / 命令 / 工具
├── metadata.yaml
├── _conf_schema.json
├── requirements.txt     # 零依赖
├── core/                # 无 AstrBot 依赖的纯 Python 核心
│   ├── config.py        # 配置读取（默认值兜底 + 钳位）
│   ├── models.py        # 星星 / 细节 / 情绪 / 关系 / 再激活 数据模型
│   ├── ebbinghaus.py    # 遗忘曲线引擎（半衰期）
│   ├── emotion.py       # 情绪衰减引擎（独立半衰期）
│   ├── timeline.py      # 事件时间解析（相对/绝对/精度）
│   ├── mood.py          # 心绪引擎
│   ├── storage.py       # SQLite 持久化（星星/细节/情绪/关系/再激活）
│   ├── text.py          # CJK 分词 / 相似度 / JSON 容错
│   ├── llm.py           # Provider 兼容适配
│   ├── embedding.py     # Embedding 适配 + 降级
│   ├── prompts.py       # 提炼与心绪判读提示词
│   ├── formatting.py    # 注入块 / 展示格式化
│   ├── engine.py        # 召回 / 巩固 / 维护编排
│   ├── webui.py         # WebUI 后端路由
│   └── scheduler.py     # 每日维护调度
├── views/console/       # WebUI 前端
└── tests/
    ├── test_core.py     # 核心单测（30）
    ├── test_spec.py    # 规范用例 A~G（38）
    └── ablation.py     # 真实 AstrBot 消融实验（10 场景）
```

## 🧪 测试

```bash
pip install pytest
pytest tests/ -q                      # 68 项核心单测（零依赖，任意环境可跑）
```

真实 AstrBot 消融实验（需要本机有 AstrBot 实例，`ASTRBOT_ROOT` 指向沙箱目录）：

```bash
python tests/ablation.py                 # 10 个场景：全量/无向量/关情绪/关心绪/LLM故障/空库/
                                       # 存储故障/重启重算/WebUI路由/LLM工具
```

## 📄 许可证

[MIT](./LICENSE) © 2026 bigfish
