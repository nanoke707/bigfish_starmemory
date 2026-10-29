# vendor · 本地静态依赖

| 文件 | 来源 | 版本 | 许可 |
| --- | --- | --- | --- |
| `three.min.js` | three.js（`https://github.com/mrdoob/three.js`，npm 包 `three` 的 `build/three.min.js`） | r147（`REVISION = "147"`） | MIT（Copyright 2010-2022 Three.js Authors，文件头保留原许可声明） |

## 为什么放在这里

页面里的 3D 大屏需要 three.js。以前只从 `cdn.jsdelivr.net` 取，**只要这台机器连不上 CDN
（内网、离线、代理拦截、浏览器装了拦截扩展），整块 3D 就直接不显示**，还会被误报成
"WebGL 不可用"。现在改成：**先读本目录的本地副本，读不到才退回 CDN**。

- 页面里的加载顺序见 `../neural.js` 顶部 `BSM_THREE_DEPS` / `BSM_loadScripts`。
- 辉光用的 `examples/js/postprocessing/*` 仍只走 CDN，**拿不到就跳过**（没有辉光也照常出画面）。
- 换版本时保持 `three.min.js` 与 CDN 的版本号一致（当前 `0.147.0`），否则 API 会对不上。
