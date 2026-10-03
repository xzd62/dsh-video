# dsh-video — DSH 开机动画（动态锁屏）

> 给 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 的 Web 界面加一层开机动画：
> 打开或刷新页面时全屏播放一段视频，**点击任意处立即进入，播完自动进入**。
> A boot-animation / dynamic-lockscreen plugin for the DSH Web GUI.

仓库自带 4 段示例视频，**装好重启即用，不需要自己准备素材**；多个视频可以用 ↑ ↓ 切换并记住选择。

---

## 效果

```
浏览器请求 http://127.0.0.1:3080/
  ↓  index.html 的 <head> 被注入一段同步脚本
  ↓  立刻给 <html> 加 dsh-boot-cover 类 → #root 隐藏、背景刷黑   ← 此刻 DSH 还没挂载
  ↓  异步加载 /boot-video/cover.js，铺上全屏 <video>
  ↓  能自动播就直接播；被浏览器拦截就弹出「播放视频 / 直接进入 DSH」
  ↓  播放中：点任意处或按键 = 立即进入；播完 = 自动进入
  ↓  揭开时才移除 dsh-boot-cover → 应用与覆盖层交叉淡入
```

关键在于隐藏界面发生在 **DSH 应用挂载之前**，所以不会出现「先闪一下界面再盖住」。
这也是本项目不走 `dsh.client` + React Slot 的原因 —— 那条路要等 shell 启动完成才挂载，拿不到首帧之前的时机。

## 操作

| 想做的事 | 怎么做 |
| --- | --- |
| 进入 DSH | 播放中点任意处 / 按任意键（Esc 也行；F11 除外），或等它播完自动进入 |
| 不看视频直接进 | 自动播放被拦截时，面板上点「直接进入 DSH」 |
| 带声音开始播放 | 面板上点「▶ 播放视频」（这一次点击不会直接进入，见下文「声音」） |
| 换一个视频 | ↑ / ↓ —— 选中的会记进 `state.json`，下次启动/刷新继续播它 |
| 2 倍速看完 | 点右下角「2× 快进」，再点一下恢复正常 |
| 全屏观看 | F11 —— 原样交给浏览器，只切全屏，**不会**进入 DSH |
| 卡住了 | 控制台执行 `__dshBootVideoSkip()` 立即进入 |

播放时右下角只有这几样，不显示当前是哪个视频：

```
↑ ↓ 切换视频
[ 2× 快进 ]   F11 可全屏观看   点击任意位置进入
```

（唯一会点名文件的地方是「某个视频播不了」时的那行提示。）

## 安装

要求：可用的 `dsh` 命令，以及 PATH 上的 `git` 与 `pnpm`（`dsh plugin` 只是把参数转发给 profile 目录里的 pnpm）。

```sh
dsh plugin --profile web add github:xzd62/dsh-video
```

然后**重启 `dsh web`**（插件行只在进程启动时装载）：

```sh
# 在跑 dsh web 的终端里 Ctrl+C，再重新执行原来的启动命令
```

再打开 `http://127.0.0.1:3080` 并按 **Ctrl+F5**，就能看到开机动画。

没有构建步骤：纯 JavaScript，没有 `prepare` 脚本，所以装完即用，也不需要往 `allowBuilds` 里加白名单。

<details>
<summary>从源码跑 DSH？手动安装？卸载？点这里</summary>

**从源码 checkout 运行 DSH 时**，`pnpm run dsh -- plugin ...` 会把 `--` 当字面参数传给 CLI（实测会报 `required option '--profile <name>' not specified`），直接调脚本即可：

```sh
cd <你的 dsh 仓库>
node --import tsx/esm apps/cli/src/bin.ts plugin --profile web add github:xzd62/dsh-video
```

**手动安装**（不想用 `dsh plugin`）：`dsh plugin add` 只做两件事，手动照做也一样：

```sh
cd "$DSH_HOME/profiles/web"        # Windows: %USERPROFILE%\.dsh\profiles\web
pnpm add github:xzd62/dsh-video
# 然后把 "dsh-boot-video" 追加到该目录 package.json 的 dsh.profile.bundles 数组里
```

**卸载**：

```sh
dsh plugin --profile web remove dsh-boot-video
```

> 注意：仓库叫 `dsh-video`，而包名是 `dsh-boot-video` —— `add` 用仓库地址，`remove` 用包名。

**更新**：`dsh plugin add` 对同一个依赖不会自动重装，先 `remove` 再 `add`。
⚠️ `remove` 会删掉整个已安装目录，**包括你放进 `assets/` 的视频和记录选择用的 `state.json`**，动手前先备份。

</details>

## 内置示例视频

| 文件 | 大小 |
| --- | --- |
| `坐杀搏徒.mp4` | 45.9 MB |
| `虎杖vs宿傩.mp4` | 19.7 MB |
| `新宿决战.mp4` | 12.5 MB |
| `苦夏.mp4` | 8.6 MB |

它们放在 `assets/`，安装后位于：

```
%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-boot-video\assets\
```

关于这一目录的规则：

- 可用扩展名：`.mp4 .webm .mov .m4v .ogv .ogg .mkv .avi`；推荐 **mp4 + H.264 + AAC**（`.mkv`/`.avi` 多数浏览器不认）
- **放 2 个及以上**就能用 ↑ ↓ 切换；切换顺序 = 文件名排序
- 没记录过选择时，默认播「名字以 `boot` 开头」的那个，否则播排序第一个
- **换视频 / 加视频不用重启 `dsh web`**，Ctrl+F5 刷新即可（路由每次请求都重看磁盘）
- 文件名可以是中文：内部走百分号编码，`state.json` 也按 UTF-8 正确读写（有专门的自检用例）

## 配置（`config.json`）

改完需要**重启 `dsh web`**（配置在装载时读一次）；只有换视频不用。

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 整体关闭开机动画（连路由都不注册） |
| `file` | `""` | 留空 = `assets/` 里所有视频都是候选；**填了就只播这一个，↑↓ 切换随之关闭**。填了却不可用时不静默换素材，直接当作没有视频并告警 |
| `fit` | `"cover"` | `cover` 铺满裁切（动态壁纸感）；`contain` 完整显示留黑边 |
| `fadeMs` | `600` | 进入 DSH 的淡出时长，`0` = 不淡出 |
| `muted` | `false` | `true` = 直接静音播放 |
| `requireSound` | `true` | 必须有声：自动播放被拦截时改为「两个选项」面板 |
| `fallbackMuted` | `true` | 有声方案全失败时退化为静音播放，而不是直接进入 |
| `autoEnterAtEnd` | `true` | 播完自动进入（关掉则停在最后一帧等点击） |
| `fastRate` | `2` | 「快进」按钮的倍速（>1，上限 16） |
| `rememberChoice` | `true` | 用 ↑↓ 选中的视频记到 `state.json` |
| `hint` | `"点击任意位置进入"` | 右下角提示；给空串则不显示 |
| `switchHint` | `"↑ ↓ 切换视频"` | 切换提醒（只有 2 个以上候选时显示）；给空串则不显示 |
| `fullscreenHint` | `"F11 可全屏观看"` | F11 全屏提醒；给空串则不显示 |
| `prompt` | `"🔊 浏览器拦截了自动播放，请选择"` | 两个选项面板的标题 |
| `playLabel` | `"▶ 播放视频"` | 面板按钮文字 |
| `skipLabel` | `"直接进入 DSH"` | 面板按钮文字 |
| `showProgress` | `true` | 底部 2px 播放进度条 |

## 声音（重要）

浏览器默认**禁止有声自动播放**。这个插件的阶梯是：

1. 先尝试**带声音**自动播放；
2. 被拦截 → 弹出面板给两个选项：
   - **▶ 播放视频**：带声音开始播放（此时有用户手势，浏览器才允许出声）。
     注意这次点击**不会**把你送进 DSH —— 再点一次（或等播完）才进入；
   - **直接进入 DSH**：不看视频，立刻进入；
   - 面板空白处点击 = 播放视频；
3. 若连静音都播不了（文件损坏、编码不支持），直接放行进入 DSH 并在控制台打印原因 —— 不会把你锁在黑屏上。

想让它在打开页面时就自动带声音播放，二选一：

- **A（推荐）**：地址栏左侧图标 →「网站设置」→ 声音 → **允许**（针对 `http://127.0.0.1:3080`），然后刷新；
- **B**：用启动参数打开浏览器：`--autoplay-policy=no-user-gesture-required`。

## 预览与自检

想在不重启 DSH 的情况下先看效果（调 `fit` / 文案 / 试 ↑↓ 最省事）：

```sh
node tools/preview.mjs
node tools/preview.mjs --file "C:\path\to\your.mp4" --port 4000
```

它起的是一个**静态占位页**（假 DSH 界面 + 真实注入逻辑 + 真实视频路由），不是第二个 `dsh web`，
也不碰正在跑的 3080。默认不写 `state.json`，加 `--remember` 才写。

```sh
node tools/selfcheck.mjs
```

176 项断言，不需要浏览器、不需要 DSH：注入时序、HTTP Range（200/206/416/HEAD/405）、
视频清单与默认项、按名路由与路径穿越防护、中文文件名、POST 记录选择并跨「重启」保持、
两个选项面板、↑↓ 切换、倍速按钮、F11 放行、播完/播不了的各条分支。
全部用例跑在系统临时目录里，不会往真的 `assets/` 写东西，也不会留下 `state.json`。

## 排错

| 现象 | 原因 / 处理 |
| --- | --- |
| 打开就是 DSH，没有动画 | ① 还没重启 `dsh web`；② `assets/` 里没有视频；③ `config.json` 的 `file` 指错了（宿主日志里有告警） |
| 黑屏、界面不出来 | 15 秒兜底会自动放行。卡住时控制台执行 `__dshBootVideoSkip()`；再看控制台报错 |
| 有画面没声音 | 被自动播放策略拦截了，见上文「声音」 |
| ↑↓ 没反应 | 只有 1 个候选，或 `config.json` 里 `file` 写死了单个文件 |
| 切换后下次又变回去了 | `rememberChoice` 是不是 false；或 `state.json` 写不进去（宿主日志有告警） |
| 某个视频播不了 | 多个候选时面板会提示「无法播放 xxx —— 用 ↑↓ 换一个」；只有一个时会直接放行进入 |
| 画面比例不对 | 把 `fit` 改成 `contain` |
| 换了视频还是老的 | Ctrl+F5 硬刷新（路由带 `no-store`，正常刷新即可生效） |
| 想临时关掉 | `config.json` 里 `enabled: false`，重启 `dsh web` |

## 工作原理

- **落点**：DSH 的 `$DSH_HOME/profiles/web` 是一个层栈（`dsh-base` → `dsh-web-app` → 你的插件）。
  本包声明 `dsh.bundle.patch`，被装进 `dsh.profile.bundles` 后，它的 `cordis.patch.yml`
  会被当成一层 patch，插入一行 `name: dsh-boot-video` 的 Cordis 行。
- **宿主半**（`lib/index.js`）用 `ctx.webServer.register()` 注册三条路由：
  - `GET /boot-video/cover.js` —— 覆盖层脚本（把视频清单与配置注入进去）
  - `GET /boot-video/media[/<名字>]` —— 视频本体，HTTP Range 流式（可拖动、可分段缓冲），
    文件名必须命中当前清单，因此同时挡住了路径穿越
  - `POST /boot-video/current` —— 记录选择

  再用 `ctx.webServer.tapIndex()` 改写每次返回的 `index.html`。`ctx.effect` 保证卸载时全部撤销。
- **浏览器半**（`lib/cover.js`）不依赖任何框架，纯 DOM。切换视频只是换 `video.src`
  （清单在注入时已带齐，不需要额外往返），只有「记录选择」需要一次 POST。
- **为什么两个文件可以独立更新**：`cover.js` 每次请求都从磁盘现读，而宿主配置在
  `dsh web` 启动时冻结 —— 所以浏览器半对「配置缺字段」全部做了兜底（否则按钮上会渲染出
  `undefined`），这条兼容窗口也有专门的测试用例。

## License

代码：MIT，见 [LICENSE](LICENSE)。

`assets/` 内的示例视频为第三方素材，仅用于演示，**版权归原权利人所有，不在 MIT 许可范围内**；
若要公开分发或商用，请替换为你拥有权利的视频。
