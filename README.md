# Smart Teleprompter · 智能提词器 · 1.3.0

**下载 / Download:** [GitHub Releases](https://github.com/MarcusYF/smart-teleprompter/releases)。下载 `SmartTeleprompter-1.3.0-macOS-arm64.zip`，解压并将 **智能提词器.app** 拖入 Applications。应用内置前端、本地服务、Node.js 24.21.0 和语音识别器，运行时不需要源码目录、Homebrew 或另外安装 Node。

**支持范围：Apple Silicon（M 系列）Mac，macOS 26 或更高。** Windows/Linux 可运行浏览器前端，但没有 Mac 原生离线识别及幻灯片控制。当前没有 Intel 原生发行包。

1.3.0（14）删除开发者路径依赖，将讲稿、缓存和日志存入用户目录；新增 Jev 密钥配置与数据文件夹菜单；启动时检查服务实例，避免误连旧版服务。窗口显示实际版本号和构建号。代码采用 [MIT License](LICENSE)，内置 Node 的完整许可证随包分发，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。本项目最初由 Claude + Jev 开发，可靠性修订和独立打包由 Codex 完成。

应用有本地临时签名，**未经过 Apple 开发者签名或公证**。首次打开可能受到 Gatekeeper 阻止；请核对发行包的 SHA-256，系统允许时通过“系统设置 → 隐私与安全性 → 仍要打开”授权，不要关闭系统安全保护。

1.2 修复了暂停后继续发送排队点击、失败点击被计为完成、旧识别会话结束干扰新会话、关闭 Jev 后迟到响应继续移动位置、刷新覆盖动画计数、保存失败却提示成功，以及连续多个公式解析崩溃。切换文档（包括同名 Keynote 文档）会暂停自动控制；Keynote 控制请求检查当前文档和页码，PowerPoint 检查页码；只有一个窗口能持有自动控制会话。演练模式不会操作真实幻灯片。

A local, voice-following teleprompter for English and Chinese. It listens to you, highlights where you are in the script phrase by phrase, holds still when you pause or ad-lib, and uses **Jev** (TypeSafe's System One model) for the judgments plain matching cannot make: are you ad-libbing, paraphrasing, restarting after a slip, or did you jump ahead; did the passage you just skipped matter; which words of each sentence make the best cue for the outline view.

本地运行的语音跟读提词器，支持中文和英文。它实时听你说话，按固定短语高亮当前位置；你停顿时它也停，你即兴发挥或口误时它会判断并等你接上；提纲模式可以只显示要点或提纲；也可以和 Keynote / PowerPoint 联动，作为智能演讲者备注。

## 安装与首次使用

1. 退出正在运行的旧版；解压发行包，拖入 Applications，打开“智能提词器”。窗口标题应显示 **v1.3.0 (14)**。
2. 粘贴讲稿，或在 Keynote 打开 `.key` 文档后点击“导入 Keynote 备注”。导入的是当前打开文档，不直接解析 `.key` 文件。
3. 开始提词并点击“开始收音”，按 macOS 提示授予麦克风权限。设置中的本机识别语言若未下载，可点击下载；Apple 模型首次下载需要联网，之后识别可离线。
4. Jev 可选：应用菜单 → **配置 Jev API 密钥…**，填写自己的 TypeSafe API key，保存后退出并重新打开应用。设置中可关闭 Jev。未配置时使用本地跟读和本地提纲。
5. 幻灯片联动需要自动化权限；观察翻页器按键需要辅助功能权限。普通讲稿提词不需要这些权限。

**数据位置：** `~/Library/Application Support/SmartTeleprompter/`，其中 `scripts/` 是讲稿，`cache/` 是提纲缓存，`server.log` 是诊断日志；菜单可打开该目录。更新或移动应用不更改讲稿。发行包不含作者的讲稿、缓存、密钥或日志。旧开发版的 `data/scripts/` 可备份并复制到新目录的 `scripts/`，操作前退出应用；浏览器本地草稿和窗口设置不通过复制迁移。

**排障：** 无法启动时，退出其他提词器实例，再检查 5217 端口及 `server.log`。没有识别结果时，检查麦克风权限和语言模型。Keynote 没有跟随时，检查自动化权限、联动来源及页码映射。

### 从源码运行 / Build from source

源码需要 Node.js 24 LTS（无 npm 依赖）；构建 Mac 应用还需 macOS 26 SDK / Xcode Command Line Tools。

```bash
git clone https://github.com/MarcusYF/smart-teleprompter.git
cd smart-teleprompter
npm start              # http://127.0.0.1:5217
npm run build:native   # 可选：编译源码版的本机识别器
npm run build:app      # 生成独立 ZIP，不替换已有安装
```

构建脚本下载固定版本的官方 Node arm64 发行包，校验 SHA-256，并将运行时及许可证打入应用。`TELEPROMPTER_NODE_DIST` 可指定已下载的 arm64 官方发行目录用于离线构建。直接运行 `bash tools/make-app.sh` 会替换本机安装；发布和测试请使用 `--archive`。

### 和 Keynote 一起演讲（演讲模式）

1. 在提词页右上角点 **联动 Keynote**。第一次 macOS 会问“智能提词器”能否控制 Keynote：点 **好**。
2. 点 **🎙 开始收音**。第一次 macOS 会问能否使用麦克风：点 **允许**。
3. 像平常一样开始 Keynote 放映（全屏）。提词器会自动进入**演讲模式**：悬浮在笔记本屏幕最上层，盖住 Keynote 的演讲者显示；幻灯片照常在外接屏上。提词器不抢键盘，遥控器照常控制 Keynote。放映结束后自动恢复成普通窗口。
4. 快捷键（任何时候都有效）：**⌃⌥空格** 开始/停止收音，**⌃⌥P** 进入/退出演讲模式，**⌃⌥B** 暂停/恢复语音控制动画和翻页。
5. 菜单栏的提词器图标：演讲模式的位置（盖满笔记本屏幕 / 下半屏 / 右半屏 / 保持我调整的大小）、不透明度（100%–60%，可以透出下面的 Keynote 演讲者显示）、是否放映时自动进入演讲模式。

如果之前点了“不允许”：系统设置 › 隐私与安全性 › 自动化 › 智能提词器 › 打开 Keynote；麦克风在 系统设置 › 隐私与安全性 › 麦克风。

### 连接麦克风（浏览器版）

1. 打开提词页后，点左上角 **🎙 开始收音**（或屏幕中间的大按钮，或按空格）。
2. 第一次 Chrome 会问是否允许使用麦克风：点 **允许**。如果 macOS 也问 Chrome 能否使用麦克风，同样允许。
3. 开口照稿念，高亮就会跟着走。底部会显示识别出的文字，左上角的电平条会随声音跳动。
4. 如果 8 秒内没有识别结果，提词器会提示原因：没有声音（检查 系统设置 › 隐私与安全性 › 麦克风 › Google Chrome，以及 系统设置 › 声音 › 输入），或者有声音但识别不出（Chrome 的语音识别需要联网；也可在 ⚙ 设置里改用“本机离线识别”）。
5. 之前点过“阻止”的话：窗口左上角的站点图标 › 麦克风 › 允许（或 Chrome 设置 › 隐私和安全 › 网站设置 › 麦克风）。

⚙ 设置里的“模拟演示”只是用模拟的“说话”输入演示高亮如何跟随，**没有声音，也不是朗读功能**。

## 使用

1. 在编辑页粘贴讲稿（或点“中文示例 / English sample”），点 **开始提词**。
2. 按 **空格** 开始收音，照稿念即可。高亮按短语前进，当前短语里已读的字会变暗。
3. 顶部切换显示粒度：**逐字 / 精简 / 要点 / 提纲 / 标题**（快捷键 `[` `]` 或 `1`–`5`）。“精简”和“要点”旁边有 **详略** 滑块（快捷键 `,` `.`），按 Jev 给每句打的重要性分数连续调节显示多少内容。切换是即时的，不会重新调用 Jev。
4. 点击任意短语可以手动跳过去；`←/→` 按短语（要点/提纲视图里按条目），`↑/↓` 按段落。出现“漏掉要点”提醒时按 `B` 回到那里。
5. 收音时按一次 `Esc` 不会离开（防误触），连按两次才回编辑页；回到编辑页再点“开始提词”，同一份稿件会从原来的位置、计时继续。
6. ⚙ 设置：字号、行距、阅读线位置、镜像（提词玻璃）、主题、识别引擎、识别语言、幻灯片联动，以及“模拟演示”（无声音，用来预览效果）。

### 讲稿语法（都是可选的）

| 写法 | 含义 |
| --- | --- |
| `# 标题` | 章节标题（不念） |
| `[slide 3: 标题]` 或 `---` | 幻灯片分界，用于和 Keynote/PowerPoint 同步 |
| `// 看向观众` | 舞台提示（不念，显示为蓝色提示） |
| `>> 核心：……` | 下一段在“要点 / 提纲”视图里的自定义提纲 |
| `[必讲]` 或 `[must]`，单独一行 | 下一段在所有显示粒度下都保留全文，并用左侧金色线标出；跟读检测到遗漏时提醒。必讲状态来自你的标记，不由模型决定 |
| `[[停顿]]` | 句中提示 |
| `[click]` / `[点击]` / `[动画]` / `[下一步]` / `▶` | 放映时点一下：讲到这里自动放下一个动画（或翻页）；`[click x2]` 点两下；全角括号 `［点击］` 也可以。单独一行的标记归到前后文里，标题行里的标记归到标题后面的文字 |
| 空行 / 换行 | 空行分段；单个换行也是短语分界 |

## 跟读是怎么工作的

- **Lexical follower** (`public/lib/tracker.js`): a streaming alignment over every script position, updated for each recognized word. It allows words the script doesn't have (ad-libs, fillers), skipped words, short re-reads, and far jumps. Chinese is matched per character with pinyin, so homophone recognition errors (的/得, 模型/魔性) still count; numbers are compared by their reading, so 20% = 百分之二十 and 2026年 = 二零二六年. English uses stems, a phonetic key, and number words (20 = twenty). After off-script speech, only a clear content-word match can re-anchor the highlight, so a stray "the" or "的" never moves it.
- **Display** (`public/lib/follower.js`): hysteresis for jumps; pause detection from recognizer silence and microphone level; pace in words/characters per minute and the estimated time left; a short lead that offsets recognizer lag; a look-ahead band sized to your pace (always whole phrases); skipped-phrase marks; while you are off script the resume point is outlined.
- **Jev** (`server/semantic.mjs`, called only when needed):
  - while you are off script, one request asks *what are you doing* (reading with recognition noise / paraphrasing / related ad-lib / slip or restart / jumped ahead / went back / off-topic), *which script line are you on*, and *have you already said the current sentence in other words*. The prompter holds, re-anchors, or moves to the next sentence based on the answers. Online latency has not been measured for this release.
  - after a skip, each skipped sentence is judged on its own: *is it a key point?* and *did you already say it in other words?* A reminder with a “go back” button appears only for an important sentence you really left out (a paraphrase is not an omission).
  - for the outline views, each sentence gets an importance score and a cue fragment **selected from its own words** (Jev picks; it doesn't write), and each paragraph gets a main sentence. Results are cached per paragraph in `data/cache/`.
  - with slides but no `[slide]` markers, *Auto-align slides* proposes paragraph mappings. Review and apply them before linking; failed model calls return an error, and low-confidence or no-match slides are flagged.
- Script parsing, matching and display run locally. Browser speech recognition may use the browser vendor's service. Without a Jev key the app still works: the outline uses local heuristics and off-script moments are handled lexically.

Jev key: the server reads `TYPESAFE_API_KEY` from the environment, or the app Keychain entry (account `typesafe-ai`, service `local.claude-jev.teleprompter.jev`), then the legacy `TYPESAFE_API_KEY` Keychain item. The key never goes to the browser.

**隐私与服务状态：** Apple 本机识别不会上传音频；开启“Jev 智能辅助”时会把相关讲稿片段和识别文字发送给 TypeSafe，用于提纲和语义判断。关闭后使用本地跟读与提纲，并取消未完成的请求。Web Speech 的音频处理由浏览器提供商负责。健康状态的“Jev 可用”表示找到密钥，不代表已验证网络或模型效果；失败会反馈并保留本地提纲。

可用 `TELEPROMPTER_JEV_MODEL` 指定模型版本。提纲缓存区分模型、提示版本、语言、演讲标题和段落；`jev-latest` 的缓存最长使用 24 小时。`TELEPROMPTER_JEV_PRICE_PER_MTOK` 可设置每百万输入 token 的估算价格，未设置时不报金额。请求与返回格式已对照 [TypeSafe 官方 API](https://docs.typesafe.ai/api) 核查；概率阈值仍需要在真实演讲上验证。

## 识别引擎

| Engine | Notes |
| --- | --- |
| Browser (Web Speech) | Default. Works in Chrome/Safari with no setup; audio goes to the browser vendor's speech service. `zh-CN`, `zh-TW`, `en-US`, `en-GB`. |
| On-device (Apple SpeechAnalyzer) | Offline and private. Build once with `npm run build:native` (Command Line Tools, macOS 26). Apple's model for each language is downloaded once (on this Mac: en-US and zh-CN are installed); the settings panel shows a download button for others. The first time, macOS asks to let the launching app (Terminal or Teleprompter.app) use the microphone. |
| Simulated | For demos and testing without a microphone. |

## 幻灯片联动（演讲者备注模式）

Choose Keynote or PowerPoint in ⚙ → 幻灯片联动. The server polls the slideshow over Apple Events and, on each slide change, moves the prompter to that slide's text (`[slide N]` markers, or the Jev auto-alignment). The header shows the current slide and the next slide's title. Optional: **advance slides when I finish a slide** (speech-driven page turning).

- **Two screens.** Keynote and PowerPoint normally take over both displays when a show starts. Either play in a window on the projector screen (Keynote: *Play ▸ Play Slideshow in Window*; PowerPoint: *Slide Show ▸ Set Up Slide Show ▸ Browsed by an individual (window)*), or allow other apps on screen during the show (Keynote: *Settings ▸ Slideshow ▸ Allow Mission Control, Dashboard and others to use screen*), then put the teleprompter window on your laptop screen. A clicker keeps driving the slide app; the teleprompter follows through the watcher.
- Both Keynote builds are supported (bundle ids `com.apple.Keynote`, e.g. Keynote Creator Studio, and `com.apple.iWork.Keynote`).
- **Import Keynote notes** (editor page) builds a script from the front Keynote document: one `[slide N: title]` section per slide, with its presenter notes as the text.
- **手动校对页码：** 在设置中点“手动校对页码”，参考段落列表，每行填写 `幻灯片页码=段落编号`，例如 `1=1`、`3=2`。纯图片页可省略，页码和段落必须递增。应用后会保存映射并保持自动控制暂停；确认后点动画按钮恢复。已有 `[slide N]` 标记的稿件直接在编辑页改标记。
- Any other tool can push slide state: `POST http://127.0.0.1:5217/api/slides/state` with `{"slide": 3, "total": 12}` (CORS is open for this endpoint). Example for a reveal.js deck:
  ```js
  Reveal.on('slidechanged', e => fetch('http://127.0.0.1:5217/api/slides/state', {
    method: 'POST', headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({ slide: e.indexh + 1, total: Reveal.getTotalSlides() }) }));
  ```

### 讲稿里的公式

演讲者备注只能放文字（Keynote 的行内公式对象经 AppleScript 读出来只剩占位符），所以公式用 LaTeX 写在备注里，提词器把它渲染成真正的数学公式（MathML，系统自带的 STIX Two Math 字体，WebKit 和 Chrome 原生支持，不需要下载任何库）：

| 写法 | 显示 | 跟读 |
| --- | --- | --- |
| `$\frac{1}{\|w\|_2}${one over the norm of w}` | 公式 | 按花括号里的读法跟 |
| `$w^\top x + b = 0$` | 公式 | 英文稿自动生成读法（w transpose x plus b equals zero）；中文稿只显示、不参与跟读 |
| 单独一行 `$$…$$` | 居中的公式块 | 不念（板书、推导） |
| `// Board: $\nabla_w L = 0$` | 提示行里的公式 | 不念 |

⚙ → 公式显示：**公式**（默认）/ **公式＋读法**（读法以小字标在公式下方）/ **只显示读法**。价格之类的 `$5` 不会被当成公式（规则同 Pandoc：开头 `$` 后、结尾 `$` 前不能是空格，结尾 `$` 后不能紧跟数字）。

识别器会把逐个念的字母拼成一个词（“y i x i” → YIXI），讲稿这边也做同样的合并，所以念公式时跟读不会掉。

### 语音控制动画和翻页

在 Keynote 演讲者备注里，用 `[click]`（或 `[点击]`、`[动画]`、`▶`）标出每一次点击的位置，写在这次点击要讲的那句话前面：

```
先看左边这张图……
[click] 第一条说的是：到分界线的距离很重要。
[click x2] 两个公式一起出现。
```

放映时，讲到标记前那句话的最后一个词，提词器就让 Keynote 放下一个动画（AppleScript `show next`）；一页的标记都放完、这页的稿子也讲完，就自动翻到下一页（如果幻灯片没翻过去——幻灯片里的动画比标记多——会再点几下，最多 6 次）。写在一页稿子最末尾的标记就是这一页的翻页，只点一次。只在收音中、Keynote 正在放映、并且联动了 Keynote 时生效。

- **手动控制照常可用。** 翻页器、键盘、鼠标都直接控制 Keynote；Mac 版提词器在旁边“看着”这些操作（不拦截），把手动放出的动画算进计数，所以讲到那个标记时不会再点一次。⇧← 退回一个动画后，要讲到那个标记之前、再讲过它，才会重新自动放出。
- **退回到前面的幻灯片**（← / ↑ / PageUp）：这一页交给你手动控制（顶部显示“本页手动”），翻到后面的新页后自动恢复。
- 读取翻页器和键盘按键需要 **辅助功能** 权限：系统设置 › 隐私与安全性 › 辅助功能 › 智能提词器（菜单栏图标里有入口；每次重装 app 后需要重新打勾）。没有这个权限时，鼠标点击照样能同步，按键不能。
- 顶部的“动画 2/8”是当前页已放出/总共的点击数；点它可以暂停/恢复（也可以 ⌃⌥B）。恢复时不会补放暂停期间讲过的动画。⚙ 里可以分别关掉“自动放动画”和“自动翻页”。
- 停止收音、暂停控制、服务断开时会清除未发出的点击。已经交给 Keynote 的一次点击无法撤回；控制报错后会暂停，不自动重试，确认状态后可点“控制失败 · 点此恢复”。动画数字是根据脚本与观察到的操作推算的计数，Keynote 不提供真实动画索引。
- 鼠标点击只在点到 Keynote 自己的窗口上时才算一次点击（点别的 app 的窗口不算）。页面重新载入后，当前页已放出的动画数会恢复。
- 提词稿记得它是从哪份 Keynote 导入的；如果正在放映的是另一份，会暂停自动控制，并提示一键导入这份幻灯片的备注。
- Keynote 的 AppleScript 不报告“当前第几个动画”，所以提词器只能计数：稿子里的标记数要和幻灯片的点击数一致。`test/builds-e2e.mjs` 用真实识别器和模拟的放映检查标记位置和翻页时机。

## 测试

```bash
npm run test:all    # 基础/回归测试 + 73 个跟读压力用例；Jev 使用模拟响应，无 API 费用
npm run test:http   # 隔离临时数据目录、随机本机端口：HTTP/SSE、保存删除、跨站保护和控制会话
npm run test:e2e    # say -> Apple 本机识别 -> 跟读；英文/中文各 read/adlib/skip/pause，不调用 Jev
npm run test:e2e -- --jev  # 可选付费 Jev 联测，需要先启动服务器；请自行确认额度
node test/builds-e2e.mjs --script notes.md --slides 3-6 --clicks 0,0,2,2,8,6   # [click] timing with the real recognizer and a simulated Keynote
./tools/make-app.sh --output "$PWD/output/智能提词器-new.app"  # 输出可检查的 Mac 包，不替换已有安装
./tools/make-app.sh --archive "$PWD/output/智能提词器-new.zip"  # 生成 ZIP 并验证解压后的签名
```

### 验证状态

1.3.0 当前验证结果见 [docs/VALIDATION.md](docs/VALIDATION.md)，变更记录见 [CHANGELOG.md](CHANGELOG.md)，开发交接见 [HANDOFF.md](HANDOFF.md)。GitHub Actions 自动运行回归和 HTTP/SSE 测试；Mac 打包工作流需要手动启动，不调用付费 Jev。

**仍需实机验收：** 真人麦克风与室内噪声、双屏全屏放映、实体翻页器与鼠标事件、PowerPoint、Jev 准确率和延迟。动画索引依赖脚本标记及操作观察。`.key` 导入没有文件选择器和备注增量同步。测试通过不等于这些现场场景已验收。

历史 1.0 QA 报告在 `test/qa/REPORT-*.md`，问题与测试数字属于旧版本；以当前验证文档和测试命令为准。

## 隐私

本机识别音频留在本机。开启 Jev 时，相关讲稿和识别文字会发送到 TypeSafe，可能产生 API 费用；Web Speech 的处理由浏览器提供商负责。详见 [PRIVACY.md](PRIVACY.md)。

## 目录

```
server/        main.mjs (HTTP + SSE), jev.mjs (TypeSafe client), semantic.mjs (Jev questions),
               slides.mjs (Keynote/PowerPoint), native-asr.mjs, store.mjs
public/        index.html, app.js, style.css
public/lib/    lang.js, script.js, tracker.js, follower.js, outline.js, render.js,
               engines.js, semantic-client.js, simulate.js, i18n.js, pinyin-table.js
native/        tp-asr.swift (Apple SpeechAnalyzer helper), build.sh
native/shell/  TeleprompterShell.swift (智能提词器.app: window, floating presenter mode, hotkeys, menu bar)
tools/         make-app.sh (build + install the Mac app), launch.sh, icon/, gen-pinyin.swift
data/          saved scripts and the Jev cache (local only)
```
