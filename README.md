# Smart Teleprompter · 1.3.0

A voice-following teleprompter for English and Chinese, with optional **Jev** semantic assistance and Keynote / PowerPoint synchronization. Read, pause, paraphrase, or ad-lib: the app follows your script phrase by phrase and offers several levels of detail, from full text to an outline.

**[Download the Mac app](https://github.com/MarcusYF/smart-teleprompter/releases)** — download `SmartTeleprompter-1.3.0-macOS-arm64.zip`, extract it, and drag **智能提词器.app** into Applications. The app bundles its frontend, local server, Node.js 24.21.0, and native speech helper. Running it does not require the source checkout, Homebrew, or a separate Node installation.

**Supported native release: Apple Silicon Macs running macOS 26 or later.** There is no Intel native release. The browser frontend can run on Windows or Linux, without the Mac speech helper or native slideshow automation.

This is a **preview release**. It has an ad-hoc signature and is **not signed with an Apple Developer certificate or notarized by Apple**. Check the archive against the release's `SHA256SUMS.txt`. If macOS blocks first launch, use System Settings → Privacy & Security → Open Anyway when available; keep system security protections enabled.

## Features

- English and Chinese voice following, with phrase highlighting, pause detection, estimated time remaining, manual navigation, and skipped-passage indicators.
- Five views: full text, condensed, key points, outline, and headings. A detail slider adjusts condensed and key-point views without requesting a new outline.
- Optional Jev judgments for paraphrases, ad-libs, restarts, jumps, omitted key points, outline cues, and proposed slide mappings. Local matching and outline heuristics remain available without a key.
- Keynote presenter-note import, slide synchronization, a floating presentation window, and script markers for speech-triggered animation steps and page turns.
- PowerPoint slide synchronization and page turning; Keynote-specific animation behavior is described below.
- On-device Apple SpeechAnalyzer recognition, browser speech recognition, and silent simulated input.
- MathML formula rendering, explicit spoken formula readings, stage directions, mandatory passages, mirrored text, themes, and adjustable typography.
- Standalone Mac packaging, per-user storage, an optional Jev Keychain configuration dialog, and a title displaying the version and build number: **v1.3.0 (14)**.

Version 1.3 removes developer-path dependencies and checks the server instance during startup to avoid connecting to an old app's server. The 1.2 reliability changes prevent queued clicks after pausing, successful-looking failed clicks or saves, stale recognition and Jev responses affecting newer sessions, animation counts being overwritten on refresh, and crashes when parsing adjacent formulas. Document changes pause automatic control, including switching between same-name Keynote documents. Only one window can hold an automatic-control session. Rehearsal mode does not operate real slides.

Originally developed with Claude and Jev; reliability revisions and standalone packaging were completed with Codex. The project uses the [MIT License](LICENSE). Bundled Node licensing is included in the app; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## First launch

1. Quit any older running copy, install the extracted app, and open it. Confirm **v1.3.0 (14)** in the window title.
2. Paste a script, or open a `.key` document in Keynote and choose **Import Keynote notes**. Import reads the open document through AppleScript; it does not parse `.key` files directly.
3. Start prompting, then start listening. Grant microphone permission when macOS requests it. Download a supported Apple language model in Settings if necessary. The initial model download requires internet access; on-device recognition can then run offline.
4. Optionally choose the application menu's **Configure Jev API key…**, enter your own TypeSafe key, save, quit, and reopen the app. Jev can be disabled in Settings. Without a key, local following and local outlines still work.
5. Slideshow integration requires Automation permission. Observing clicker and keyboard events requires Accessibility permission. Ordinary script prompting does not require those slideshow permissions.

The app supports English and Chinese interface text. Its current Mac application filename is `智能提词器.app` (Smart Teleprompter).

### Storage and migration

The packaged app stores scripts, caches, and logs under:

```text
~/Library/Application Support/SmartTeleprompter/
  scripts/       Saved scripts
  cache/         Outline cache
  server.log     Diagnostic log
```

Use **Open data folder** in the application menu to open it. Updating or moving the app does not change this data. The release contains no developer scripts, caches, keys, or logs.

To migrate saved scripts from a development checkout, quit the app, back up `data/scripts/`, and copy its contents into the new `scripts/` directory. This does not migrate browser-local drafts or window settings.

If startup fails, quit other teleprompter instances and inspect port 5217 and `server.log`. For missing recognition results, check microphone permission and the selected language model. For missing Keynote synchronization, check Automation permission, the selected slide source, and the page mapping.

## Reading a script

1. Paste a script in the editor or choose a built-in sample, then select **Start**.
2. Press **Space** to start listening. Highlighting advances by phrase; already-read characters within the current phrase fade.
3. Switch views using `[` / `]` or `1`–`5`. Use `,` / `.` to adjust the detail slider where available.
4. Click a phrase to jump manually. `←` / `→` move by phrase, or by item in outline views; `↑` / `↓` move by paragraph. Press `B` to return to a passage flagged as omitted.
5. While listening, press `Esc` twice to return to the editor. Starting the same script again resumes its position and timer.
6. Settings control font size, line spacing, reading-line position, mirroring, theme, recognition engine and language, slide integration, and simulated input.

**Simulation supplies synthetic recognition text. It produces no audio and is not text-to-speech.**

### Optional script syntax

| Syntax | Meaning |
| --- | --- |
| `# Heading` | Section heading; not spoken. |
| `[slide 3: Title]` or `---` | Slide boundary for slideshow synchronization. |
| `// Look at the audience` | Stage direction, displayed as a blue cue; not spoken. |
| `>> Main point: …` | Custom outline for the following paragraph. |
| `[must]` on its own line | Keep the following paragraph in full in every view; mark it with a gold line and warn about detected omissions. Mandatory status comes from your marker. `[必讲]` is also accepted. |
| `[[pause]]` | Inline cue. |
| `[click]`, `[click x2]`, or `▶` | Trigger one or two slideshow steps. Chinese aliases `[点击]`, `[动画]`, `[下一步]`, and full-width brackets are accepted. Standalone markers attach to nearby text; markers in a heading attach to the following text. |
| Blank line / newline | Blank lines separate paragraphs; a single newline also creates a phrase boundary. |

### Formulas

Write formulas as LaTeX text in presenter notes. Keynote's inline formula objects are not preserved by AppleScript note import. The prompter renders supported syntax as MathML using system fonts, without a downloaded rendering library.

| Syntax | Display and following |
| --- | --- |
| `$\frac{1}{\|w\|_2}${one over the norm of w}` | Render the formula and follow the explicit spoken reading in braces. |
| `$w^\top x + b = 0$` | Render the formula. English scripts get an automatic spoken reading; Chinese scripts require an explicit reading for following. |
| `$$…$$` on its own line | Centered formula block; not spoken. |
| `// Board: $\nabla_w L = 0$` | Formula in a stage direction; not spoken. |

Settings offer formula-only, formula-with-reading, and reading-only display. Currency such as `$5` is not treated as a formula. Recognizer outputs that combine spoken letter sequences, such as “y i x i” into “YIXI,” are handled by matching normalization.

## Recognition engines

| Engine | Behavior |
| --- | --- |
| Browser / Web Speech | Browser-dependent recognition, using the browser vendor's service. Supported UI choices include `zh-CN`, `zh-TW`, `en-US`, and `en-GB`; availability depends on the browser. |
| On-device / Apple SpeechAnalyzer | Native Mac recognition. Language models are downloaded from Apple separately and are not bundled with the release. Settings show model availability and download controls. |
| Simulated | Silent synthetic input for demonstration and testing. |

In a browser, allow microphone access for the site and for the browser in macOS settings. If no results arrive after eight seconds, the app offers diagnostics for missing audio or recognition failure. Browser recognition may require internet access; select on-device recognition on a supported Mac for offline use.

## Keynote and PowerPoint

Choose a slide source in Settings. The local server observes slideshow state through Apple Events and moves to the current slide's script using `[slide N]` markers or an applied mapping. The header shows the current slide and the next slide's title. Automatic page turning is optional.

**Import Keynote notes** creates one `[slide N: title]` section per slide from the front document's presenter notes. Both `com.apple.Keynote` and `com.apple.iWork.Keynote` bundle identifiers are supported.

For a script without slide markers, **Auto-align slides** proposes paragraph mappings for you to review and apply. Failed model calls are reported; low-confidence and unmatched slides are flagged. **Manual page mapping** accepts one `slide=paragraph` pair per line, such as `1=1` and `3=2`. Image-only slides can be omitted. Both columns must increase. Applying a mapping leaves automatic control paused until you resume it. For scripts with explicit slide markers, edit the markers directly.

### Floating presentation mode

Link Keynote, start listening, and start the slideshow. With automatic presentation mode enabled, the Mac prompter floats above the laptop's presenter display and returns to a normal window when the show ends. The menu-bar controls offer full-screen, lower-half, right-half, or your custom window bounds; opacity can be adjusted from 100% to 60%.

Global Mac shortcuts:

- **Control–Option–Space:** start or stop listening.
- **Control–Option–P:** enter or leave presentation mode.
- **Control–Option–B:** pause or resume voice-controlled animation and page turning.

For two displays, place the prompter on the laptop and the slideshow on the external display. If a slideshow takes over both displays, use the presentation app's windowed slideshow option or its setting allowing other applications during a show. Display behavior needs verification with your presentation setup.

### Voice-controlled Keynote animations

Place a marker before the text that follows an animation:

```text
First, look at the figure on the left.
[click] The first point is the distance to the boundary.
[click x2] Both formulas now appear together.
```

When the preceding phrase finishes, the prompter requests the next Keynote step. After the current slide's marked steps and script finish, automatic page turning can advance the slide. If additional unmarked animations prevent the page turn, it attempts up to six further steps. A marker at the very end of a slide is treated as one page-turn step. This requires active listening, Keynote linkage, and an active slideshow.

- Clickers, keyboard, and mouse remain usable. The Mac app observes manual advances and counts them to avoid repeating marked steps. Observing keyboard/clicker events requires Accessibility permission; mouse observations are limited to Keynote's own windows.
- Going back to an earlier slide puts that slide under manual control. Automatic control resumes on a later new slide. After reversing an animation, reread across its marker to trigger it again.
- The animation counter is **inferred from script markers and observed events**. Keynote does not expose its actual animation index. Keep marker counts consistent with the deck.
- Pause using the animation counter or the global shortcut. Resuming does not replay markers crossed during the pause. Settings separately control automatic animations and page turns.
- Stopping listening, pausing, or losing the service clears unsent clicks. A click already sent cannot be withdrawn. Control failures pause automation; inspect the slideshow before using the recovery control.
- Changing the presentation document pauses automatic control. Imported scripts retain their source-document association and can offer to import notes from the newly active Keynote document.

### External slide-state input

Other presentation tools can send state to `POST http://127.0.0.1:5217/api/slides/state` with `{"slide": 3, "total": 12}`. This endpoint permits cross-origin requests. For example, a reveal.js deck can use:

```js
Reveal.on('slidechanged', e => fetch('http://127.0.0.1:5217/api/slides/state', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ slide: e.indexh + 1, total: Reveal.getTotalSlides() })
}));
```

## How following and Jev work

The streaming lexical tracker (`public/lib/tracker.js`) aligns recognition text against the script. It handles fillers, omitted words, short rereads, and jumps. Chinese matching uses characters and pinyin; English uses stems and a phonetic key. Number normalization matches written numbers to spoken forms. After off-script speech, re-anchoring requires a clear content-word match rather than an isolated common word.

The display follower (`public/lib/follower.js`) stabilizes jumps, detects pauses, estimates speaking pace and remaining time, and shows phrase-sized look-ahead cues and skipped passages.

Optional Jev calls (`server/semantic.mjs`) help classify off-script speech, locate paraphrases or restarts, judge whether an important skipped sentence was already expressed, select outline cues from the script's own words, and propose slide mappings. Outlines are cached per paragraph. Online accuracy and latency have not been validated for this release.

The server checks `TYPESAFE_API_KEY` in the environment, then the app's Keychain entry (account `typesafe-ai`, service `local.claude-jev.teleprompter.jev`), then the legacy `TYPESAFE_API_KEY` Keychain item. The key is never sent to the browser. A “Jev available” health indicator means a key was found; it does not verify connectivity or model quality.

`TELEPROMPTER_JEV_MODEL` overrides the model. Cache keys include the model, prompt version, language, presentation title, and paragraph; `jev-latest` cache entries expire after 24 hours. `TELEPROMPTER_JEV_PRICE_PER_MTOK` enables a configured input-token cost estimate; no currency amount is shown without it. Request and response formats were checked against the [TypeSafe API documentation](https://docs.typesafe.ai/api); judgment thresholds still need real-presentation evaluation.

## Privacy

Script parsing, matching, and display run locally. On-device Apple recognition keeps audio on the Mac. With Jev enabled, relevant script passages and recognized text are sent to TypeSafe and may incur API charges. Disabling Jev cancels pending requests and uses local matching and outlines. Browser speech processing is handled by the browser vendor. See [PRIVACY.md](PRIVACY.md).

## Build from source

Source operation requires Node.js 24 or later and has no npm dependencies. Native builds additionally require an Apple Silicon Mac and the macOS 26 SDK / Xcode Command Line Tools.

```bash
git clone https://github.com/MarcusYF/smart-teleprompter.git
cd smart-teleprompter
npm start              # http://127.0.0.1:5217
npm run build:native   # Optional: compile the development speech helper
npm run build:app      # Create a standalone ZIP without replacing an installed app
```

The packaging script downloads a pinned official Node arm64 distribution, verifies its SHA-256, and bundles the runtime and licensing. Set `TELEPROMPTER_NODE_DIST` to an already downloaded official distribution for an offline build. Running `bash tools/make-app.sh` without output/archive options replaces the local installation; use `--archive` or `--output` for reviewable builds.

## Tests and validation

```bash
npm run test:all       # Regression tests and tracker stress tests; mocked Jev, no API charges
npm run test:http      # Temporary storage and random localhost port; HTTP/SSE and control leases
npm run test:e2e       # macOS speech synthesis -> Apple recognizer -> tracker; no Jev calls
npm run test:e2e -- --jev  # Optional paid integration test; start the server and check your quota
node test/builds-e2e.mjs --script notes.md --slides 3-6 --clicks 0,0,2,2,8,6
npm run build:app
node tools/verify-bundle.mjs /path/to/智能提词器.app
```

The animation test uses the real recognizer and a **simulated** slideshow. The bundle test relocates the app, makes the bundle read-only, and checks its embedded runtime, server, temporary script persistence, and speech-helper enumeration.

See [docs/VALIDATION.md](docs/VALIDATION.md) for current evidence, [CHANGELOG.md](CHANGELOG.md) for changes, and [HANDOFF.md](HANDOFF.md) for development context. GitHub Actions runs functional tests on Linux and strict tracker timing tests on an Apple Silicon Mac runner. A separate manual Mac workflow builds and verifies an archive. These workflows do not call paid Jev endpoints.

**Pending live acceptance:** real microphone use in noisy rooms, dual-display fullscreen presentations, physical clickers and mouse events, PowerPoint, online Jev quality and latency, and testing on another Mac. Animation state is inferred. `.key` import has no file picker or incremental note synchronization. Automated test success does not establish these live behaviors. Historical `test/qa/REPORT-*.md` files describe earlier versions; use the current validation document for release status.

## Repository layout

```text
server/        Local HTTP/SSE server, Jev client, semantics, slides, storage, native ASR bridge
public/        Browser UI and local parsing, tracking, rendering, outline and language modules
native/        Apple SpeechAnalyzer helper and build script
native/shell/  Mac window, floating presentation mode, shortcuts and menu-bar integration
tools/         App packaging, runtime download, bundle verification, launch and icon tooling
test/          Regression, stress, HTTP and optional native integration tests
data/          Development scripts and caches; local only, excluded from Git
output/        Built apps and archives; local only, excluded from Git
```
