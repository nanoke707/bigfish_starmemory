"""bigfish_starmemory 咸鱼星空记忆核心包。

core 包内的模块是「无 AstrBot 依赖」的纯 Python 实现：

- config      配置读取封装（带默认值与安全钳位）
- models      星星（记忆条目）与星云（情绪状态）的数据模型
- text        分词、相似度、JSON 容错解析等文本工具
- ebbinghaus  艾宾浩斯遗忘曲线引擎（保持率 / 间隔重复巩固 / 拟人化遗忘）
- mood        星云心绪引擎（三轴情绪状态机）
- storage     SQLite 持久化层（星星 / 心绪 / 星尘 / 元数据）
- llm         LLM 客户端（AstrBot Provider 兼容适配）
- embedding   向量服务（AstrBot Embedding Provider 适配 + 关键词降级）
- prompts     记忆提取与心绪判读的提示词模板
- formatting  记忆注入与展示的格式化
- engine      记忆引擎（召回 / 保存 / 巩固 / 维护编排）
- scheduler   每日维护调度器（含漏跑补偿）

只有 main.py 与 llm/embedding 两个适配模块接触 AstrBot 运行时，
其余模块可独立于 AstrBot 进行单元测试。
"""

__all__ = [
    "config",
    "models",
    "text",
    "ebbinghaus",
    "mood",
    "storage",
    "llm",
    "embedding",
    "prompts",
    "formatting",
    "engine",
    "scheduler",
]
