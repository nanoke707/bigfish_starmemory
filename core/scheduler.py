"""每日维护调度器。

- 启动时检查上次维护日期，漏跑则立即补一次（星星的遗忘按真实时间计算，
  错过几天也不会算错账，补跑只是为了归档与提示及时）；
- 之后每天在配置的时刻（默认凌晨 4 点）触发一次 engine.maintain_all()；
- 调度器整体可取消，供 terminate() 优雅停机。
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timedelta

try:  # AstrBot 运行时
    from astrbot.api import logger
except Exception:  # 独立测试环境
    import logging

    logger = logging.getLogger("bigfish_starmemory")

_META_KEY = "last_maintenance_day"


class DailyScheduler:
    """每天固定时刻推动一次遗忘曲线。"""

    def __init__(self, engine, hour: int = 4, day_getter=None):
        self.engine = engine
        self.hour = max(0, min(23, int(hour)))
        self._task: asyncio.Task | None = None
        self._stopped = asyncio.Event()
        self._day = day_getter or (lambda: datetime.now().strftime("%Y-%m-%d"))

    def _seconds_until_next_run(self) -> float:
        now = datetime.now()
        target = now.replace(hour=self.hour, minute=7, second=0, microsecond=0)
        if now >= target:
            target += timedelta(days=1)
        return max(1.0, (target - now).total_seconds())

    async def start(self) -> None:
        if self._task and not self._task.done():
            return
        self._stopped.clear()
        # 先补漏再进入日常循环
        self._task = asyncio.create_task(self._run())

    async def _run(self) -> None:
        try:
            await self._catch_up()
        except Exception as exc:
            logger.warning(f"[StarMemory] 维护补跑失败: {exc}")
        while not self._stopped.is_set():
            try:
                wait = self._seconds_until_next_run()
                logger.debug(f"[StarMemory] 下次遗忘维护在 {wait / 3600:.1f} 小时后")
                try:
                    await asyncio.wait_for(self._stopped.wait(), timeout=wait)
                    break  # 收到停止信号
                except asyncio.TimeoutError:
                    pass
                if self._stopped.is_set():
                    break
                today = self._day()
                last = await self.engine.store.get_meta(_META_KEY, "")
                if last == today:
                    continue
                summary = await self.engine.maintain_all()
                logger.info(
                    f"[StarMemory] 每日维护完成: {summary['scopes']} 个星空, "
                    f"状态变化 {summary['changed']} 条, 熄灭归档 {summary['archived']} 条"
                    + (f", 清理 {summary['purged']} 条" if summary["purged"] else "")
                )
            except asyncio.CancelledError:
                break
            except Exception as exc:
                logger.error(f"[StarMemory] 维护循环异常: {exc}")
                try:
                    await asyncio.wait_for(self._stopped.wait(), timeout=3600)
                    break
                except asyncio.TimeoutError:
                    continue

    async def _catch_up(self) -> None:
        today = self._day()
        last = await self.engine.store.get_meta(_META_KEY, "")
        if last == today:
            return
        summary = await self.engine.maintain_all()
        if summary["scopes"]:
            logger.info(
                f"[StarMemory] 启动补跑维护: {summary['scopes']} 个星空, "
                f"状态变化 {summary['changed']} 条, 熄灭归档 {summary['archived']} 条"
            )

    async def stop(self) -> None:
        self._stopped.set()
        task = self._task
        self._task = None
        if task and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                pass
            except Exception:
                pass
