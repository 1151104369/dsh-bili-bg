# dsh-bili-bg

把 **B 站视频当作可控的全屏背景**，边工作边看。基于 DSH 的视频皮肤思路扩展而来，是独立插件（不依赖 `dsh-video-skin`）。

## 功能

- **输入 BV 号 / 粘贴 bilibili 链接** → 当背景播放；也支持热门 / 排行榜 / **首页推荐**（需登录）队列
- **B 站账号登录（二维码扫码）**：控制面板「账号」区点「二维码登录」→ 出现二维码 → 手机上扫码
  确认 → 面板显示**头像 + 昵称**，可「退出登录」；二维码过期自动刷新（轮询 2s）
- **账号首页 / 推荐列表**：登录后切换来源到「首页推荐」，拉取账号推荐 feed（WBI 签名）点条目即播
- **悬浮胶囊**（可拖动、可展开/收回）：
  - 展开后是 `▶/⏸` 播放暂停、`⏭` 下一支、`清` 清屏、`专` 专注隐藏/恢复、`⚙` 设置
  - 点击胶囊展开/收回；拖动（>3px）移动并记住位置
- **控制面板**：
  - 播放/暂停、上一支/下一支、静音/音量、专注隐藏
  - **进度条**（可拖动跳转，显示 `当前 / 总时长`）
  - **倍速**（0.5x ~ 2x）
  - **首页推荐 / 热门 / 排行榜**切换、轮播（放完自动下一支）
    - 默认来源：**已登录 → 首页推荐；未登录 → 热门**（未登录点首页推荐会提示需登录）
    - 手动切换过来源后记住你的选择，不再自动改；退出登录时若停在首页推荐会自动回落热门
  - 显示方式：**完整**（按宽度靠顶、不裁切、下方留空）/ **铺满**
  - 背景：**保留**（透出 dsh-video-skin / 主题背景）/ **留空**
  - 界面不透明度、蒙版浓度
- **清屏**：只隐藏中间会话内容区，左侧会话/任务列表保持可见可点；点左侧任意会话会自动恢复并切换
- **专注模式**：隐藏视频画面继续工作（面板按钮或胶囊「专」一键切换）；重启后保持上次状态
- **下载当前视频**：控制面板里一键把正在播的视频存成 mp4；点击后弹 **Windows「另存为」对话框**
  （默认目录=注册表 KnownFolder 解析的系统下载目录，如 `F:\Downloads`；默认文件名=标题-BV号.mp4），
  你确认存在哪里就下到哪里，取消则不下载；弹不出对话框时回退自动保存到 `Downloads/DSH-B站背景/`
  （系统下载目录不存在时退 `$DSH_HOME/downloads`）。流式写 .part 原子落地，面板显示
  百分比 / 已下载·总量 / 实时速度；**下载中按钮变「✕ 取消下载」**，点了立即中止并清理半成品
- **记住播放进度**：每 5 秒 + 暂停/关闭页面时保存；重启后**播放中退出**自动接着播
  （无手势时浏览器会静音，点 🔊 开声音），**暂停时退出**则恢复那一支到原进度但保持暂停，
  点播放继续——不会丢视频、不用回列表重选
- **登录后高清（1080p+）**：控制面板「高清（1080p+）」开关（快捷键/胶囊「专」下方）。
  - 打开后带登录 Cookie 走 DASH 分轨（qn=80/112/116，fnval=4048），在**同一个 `<video>`**
    上用 MSE 挂 video/audio 两个 SourceBuffer 混流，浏览器统一时间轴保证音画同步
    （各轨先 append 自己的 init 段，再按时间序 append 媒体分片）。
  - 可选的**分轨清晰度**按钮（1080P / 720P / 480P / 360P…）。B 站同一清晰度会返回
    avc1/hvc1/av01 多条编码，界面**按高度去重**，并自动优选浏览器 MSE 支持、H.264 优先的编码。
  - **切换高清/清晰度会保住当前进度**（不会从头播）；播放结束自动回开头续播（背景不断流）。
  - 拖动进度、暂停、倍速、清屏/专注下**两轨对称 seek/回收**，seek 从目标前最近关键帧重填；
    远距离 seek 会先探测真实 moof 边界再回填，避免落在 mdat 中间。
  - **画质降级开关**：关闭「高清」立即回到 720p 单文件；MSE 不可用/失败/超时（20s）时宿主自动回退
    720p 单文件并提示，**绝不白屏、也不会停在“播放中”却没画面**（等 MSE 真正就绪才显示“高清播放中”）。
  - 未登录开高清会提示「需登录」；服务端拿不到分轨也会自动回退并明确告知。
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
index.js            宿主插件：注入行 + 路由（config/play/media/queue/state/auth/download）
lib/bili.js         B 站接口客户端 + 带 Range 的本地播放流代理 + DASH 分轨解析(登录高清) + 首页推荐(feed)
lib/auth.js         二维码登录、Cookie 持久化（收紧权限）、账号信息、退出
lib/wbi.js          WBI 签名（mixin key + w_rid，首页推荐接口必需）
lib/qr.js           纯 Node 内建 MIT 二维码编码 + PNG 渲染（无需再登录态二维码图）
lib/download.js     视频下载：流式写 .part → 原子 rename，并发 2、内存任务表
lib/save-dialog.js  Windows「另存为」对话框（PowerShell + WinForms，零依赖）
lib/injections.js   webserver/index-inject 结构化注入行
runtime/skin.js     浏览器端：背景层 + 悬浮胶囊 + 控制面板 + 账号区 + 进度/倍速/清屏 + 高清开关
runtime/dash.js     浏览器端 MSE DASH 播放器：init-先+mof 索引 seek+两轨对称回收+降级回退（独立模块）
runtime/skin.css    样式
tests/smoke.mjs     宿主冒烟（临时 DSH_HOME，不碰真实状态）
tests/client.mjs    客户端 DOM stub 测试
tests/mse.mjs       MSE 播放器单测（ISO-BMFF 解析 + 装配/回退）
```

## 已知限制

- 高清需要**登录态**：未登录或该清晰度拿不到分轨时自动回退 720p 单文件（面板会提示）。
  4K / 杜比等更高级别既定级到 1080p，未做自适应码率（ABR）；长时间播放主要受网络抖动影响。
- MSE 取分轨走 fetch（跨源直连 127.0.0.1，带 `Range` 会触发 CORS 预检）。宿主 /media 路由必须
  正确应答 `OPTIONS`（204 + `Access-Control-Allow-Headers: Range`）并给 GET 加 `ACAO`；
  否则浏览器 fetch 会一直挂住，表现为「提示高清播放中但画面永远不出来」。已修复并有回归测试。
- 播放流经本地代理（带 `Referer` + `Range`）。Electron 的 `dsh-app://` 转发层会丢掉 `Content-Length`，会让 `<video>` 无法 seek，所以客户端优先**直连本机 HTTP**、失败再回退代理；MSE 取分轨也是直连 + 断线回退同源代理。
- 清屏依赖 `dsh-client-ui-layout` 的类名（匹配 `[class*="centerCol"]` / `[class*="sidebarCol"]`）。
- 仅面向 desktop profile（Electron 桌面壳）。
- **窗口大小不归本插件管**：DSH 桌面壳把主窗口尺寸硬编码在 `createWindow()`，且插件拿不到窗口控制
  （preload 沙箱 + IPC 白名单）。要做只能改 DSH 本体或加系统级工具，都不属于插件层，故不做。

## 状态文件

- `DSH_HOME/dsh-bili-bg.json`：记录来源（含手动选择标记）、上次 BV、音量/倍速/显示方式、
  专注模式、悬浮胶囊位置、播放进度（含是否在播/进度秒数）、**高清开关与清晰度偏好**、诊断信息。
- `$DSH_HOME/dsh-bili-bg-auth.json`：**登录凭据（Cookie）**，敏感凭证——写入时收紧文件权限
  （POSIX 0600；Windows 尽力 via `icacls` 且收紧后自检可读），日志/接口都**不回显**，面板只显示昵称/头像。

## 环境变量（可选）

- `DSH_BILI_DOWNLOAD_DIR`：覆盖下载保存根目录（默认走系统下载 KnownFolder）。
- `DSH_BILI_NO_DIALOG=1`：禁用「另存为」对话框，直接存默认目录（无头环境/自动化测试用）。
- `DSH_BILI_DEBUG=1`：B 站接口请求调试日志。

## 后续计划（Roadmap）

1. **✅ B 站账号登录（二维码扫码）**：`passport-login/web/qrcode/generate` → 轮询 `poll` → 保存 Cookie
2. **✅ 账号首页 / 推荐列表**：登录后取首页推荐 feed（wbi 签名）
3. **✅ 视频下载**：另存为对话框、进度/速度、中途取消（0.2.0）
4. **✅ 登录后高画质**：带 Cookie 请求 playurl(DASH) + 双轨 MSE 混流 + 画质降级开关（本阶段完成）
5. 4K / 杜比、自适应码率（ABR）、弹幕、分 P / 合集、纯氛围静音墙纸模式

## 开发

```bash
node tests/smoke.mjs    # 宿主冒烟（需外网访问 B 站接口）
node tests/client.mjs   # 客户端 DOM stub 测试
node tests/mse.mjs      # MSE 播放器单测（ISO-BMFF 解析 + 装配/回退）
```
