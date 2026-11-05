# dsh-bili-bg

把 **B 站视频当作可控的全屏背景**，边工作边看。基于 DSH 的视频皮肤思路扩展而来，是独立插件（不依赖 `dsh-video-skin`）。

## 功能

- **输入 BV 号 / 粘贴 bilibili 链接** → 当背景播放；也支持热门 / 排行榜 / **首页推荐**（需登录）队列
- **B 站账号登录（二维码扫码）**：控制面板「账号」区点「二维码登录」→ 出现二维码 → 手机上扫码
  确认 → 面板显示**头像 + 昵称**，可「退出登录」；二维码过期自动刷新（轮询 2s）
- **账号首页 / 推荐列表**：登录后切换来源到「首页推荐」，拉取账号推荐 feed（WBI 签名）点条目即播
- **悬浮胶囊**（可拖动、可展开/收回）：
  - 展开后是 `▶/⏸` 播放暂停、`⏭` 下一支、`清` 清屏、`⚙` 设置
  - 点击胶囊展开/收回；拖动（>3px）移动并记住位置
- **控制面板**：
  - 播放/暂停、上一支/下一支、静音/音量、专注隐藏
  - **进度条**（可拖动跳转，显示 `当前 / 总时长`）
  - **倍速**（0.5x ~ 2x）
  - **热门 / 排行榜 / 首页推荐**切换、轮播（放完自动下一支）
  - 显示方式：**完整**（按宽度靠顶、不裁切、下方留空）/ **铺满**
  - 背景：**保留**（透出 dsh-video-skin / 主题背景）/ **留空**
  - 界面不透明度、蒙版浓度
- **清屏**：只隐藏中间会话内容区，左侧会话/任务列表保持可见可点；点左侧任意会话会自动恢复并切换
- **记住播放进度**：每 5 秒 + 暂停/关闭页面时保存；上次在播的话，重启后自动接着播（无手势时浏览器会静音，点 🔊 开声音）
- 快捷键 `Ctrl+Shift+B` 开关面板

## 接入方式

作为本地 bundle 挂到 desktop profile：

- `C:\Users\11511\.dsh\profiles\desktop\package.json`
  - `dependencies` 里加 `"@local/dsh-bili-bg": "link:F:/GitHub/DSH/bundles/dsh-bili-bg"`
  - `dsh.profile.bundles` 里加 `"@local/dsh-bili-bg"`
- 在 profile 的 `node_modules/@local/` 下建 Junction 指向本目录

宿主用 `webserver/index-inject` 注入样式与脚本；**桌面壳启动时一次性收集注入表**，所以插件相关改动需要重启 DSH 生效。

## 文件结构

```
index.js            宿主插件：注入行 + 路由（config/play/media/queue/state/auth）
lib/bili.js         B 站接口客户端 + 带 Range 的本地播放流代理 + 首页推荐(feed)
lib/auth.js         二维码登录、Cookie 持久化（收紧权限）、账号信息、退出
lib/wbi.js          WBI 签名（mixin key + w_rid，首页推荐接口必需）
lib/qr.js           纯 Node 内建 MIT 二维码编码 + PNG 渲染（无需再登录态二维码图）
lib/injections.js   webserver/index-inject 结构化注入行
runtime/skin.js     浏览器端：背景层 + 悬浮胶囊 + 控制面板 + 账号区 + 进度/倍速/清屏
runtime/skin.css    样式
tests/smoke.mjs     宿主冒烟（临时 DSH_HOME，不碰真实状态）
tests/client.mjs    客户端 DOM stub 测试
```

## 已知限制

- **画质仍封顶约 360p~720p**：本阶段已支持登录，但播放源仍走无登录的低清路径；
  **更高画质（1080p/4K）需走 DASH 分轨 + MSE 混流**，属于下一阶段，暂不引入。
- 播放流经本地代理（带 `Referer` + `Range`）。Electron 的 `dsh-app://` 转发层会丢掉 `Content-Length`，会让 `<video>` 无法 seek，所以客户端优先**直连本机 HTTP**、失败再回退代理。
- 清屏依赖 `dsh-client-ui-layout` 的类名（匹配 `[class*="centerCol"]` / `[class*="sidebarCol"]`）。
- 仅面向 desktop profile（Electron 桌面壳）。

## 状态文件

- `$DSH_HOME/dsh-bili-bg.json`：记录来源、上次 BV、音量/倍速/显示方式、悬浮胶囊位置、播放进度、诊断信息。
- `$DSH_HOME/dsh-bili-bg-auth.json`：**登录凭据（Cookie）**，敏感凭证——写入时收紧文件权限
  （POSIX 0600；Windows 尽力 via `icacls`），日志/接口都**不回显**，面板只显示昵称/头像。

## 后续计划（Roadmap）

1. **✅ B 站账号登录（二维码扫码）**：`passport-login/web/qrcode/generate` → 轮询 `poll` → 保存 Cookie（本阶段完成）
2. **✅ 账号首页 / 推荐列表**：登录后取首页推荐 feed（wbi 签名）（本阶段完成）
3. **登录后高画质**：带 Cookie 请求 playurl，按需接入 DASH + MSE 混流（下一阶段）
4. 弹幕、分 P / 合集、纯氛围静音墙纸模式

## 开发

```bash
node tests/smoke.mjs    # 宿主冒烟（需外网访问 B 站接口）
node tests/client.mjs   # 客户端 DOM stub 测试
```
