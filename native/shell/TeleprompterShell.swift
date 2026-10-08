// 智能提词器.app: a native window for the teleprompter page.
//
// Two modes:
//   editing     a normal window (keyboard works: edit scripts, settings)
//   presenting  a floating panel above everything, including a Keynote or
//               PowerPoint slide show, that never takes keyboard focus, so
//               the clicker keeps driving the slides. It covers the laptop
//               screen (or the lower half / right half / your own frame).
// Presenting starts automatically when a slide show starts playing (and the
// prompter view is open), and ends when it stops. Global hotkeys:
//   ⌃⌥Space  start/stop listening      ⌃⌥P  presenting on/off
//   ⌃⌥B      pause/resume speech-driven builds and slide advance
// During a show the app watches (never intercepts) clicker, keyboard and mouse
// input to the slide app and tells the page, so speech-driven builds and hand
// clicks share one count. Seeing key presses needs the Accessibility
// permission; mouse clicks do not.
// The app starts the local server (node server/main.mjs) when needed; speech
// is recognized on-device by the server's helper (microphone permission is
// asked for this app).

import AppKit
import ApplicationServices
import Carbon.HIToolbox
import WebKit
import Security

let kPort = 5217

final class PrompterPanel: NSPanel {
    var allowKey = true
    var unconstrained = false
    override var canBecomeKey: Bool { allowKey }
    override var canBecomeMain: Bool { allowKey }
    // presenting may cover the whole screen, menu bar and Dock included
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        unconstrained ? frameRect : super.constrainFrameRect(frameRect, to: screen)
    }
}

enum Layout: String, CaseIterable {
    case notes, full, bottom, right, free
    var title: String {
        switch self {
        case .notes: return "只盖演讲者备注区（保留幻灯片预览）"
        case .full: return "盖满笔记本屏幕"
        case .bottom: return "下半屏"
        case .right: return "右半屏"
        case .free: return "保持我调整的大小和位置"
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKScriptMessageHandler, WKUIDelegate, WKNavigationDelegate {
    var panel: PrompterPanel!
    var web: WKWebView!
    var statusItem: NSStatusItem!
    var serverProc: Process?
    var presenting = false
    var lastPlaying = false
    var webView = "editor"
    var listening = false
    var slideSource = "none"
    var hotKeys: [EventHotKeyRef?] = []
    var adjustingFrame = false // our own setFrame calls, not the user's drags
    var statusTitle = ""
    var presentItem: NSMenuItem!
    var autoItem: NSMenuItem!
    var listenItem: NSMenuItem!
    var layoutItems: [Layout: NSMenuItem] = [:]
    var opacityItems: [Int: NSMenuItem] = [:]
    var accessItem: NSMenuItem!
    let defaults = UserDefaults.standard
    var keyMonitor: Any?
    var mouseMonitor: Any?
    var axTrusted = false
    var switcherOpen = false // Keynote's slide switcher (typing a slide number)
    var switcherAt = Date.distantPast
    let serverInstance = UUID().uuidString
    let keychainService = "local.claude-jev.teleprompter.jev"

    var projectDir: String {
        Bundle.main.resourceURL!.appendingPathComponent("app").path
    }
    var dataDir: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("SmartTeleprompter", isDirectory: true)
    }
    var appTitle: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "开发版"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return "智能提词器 · v\(version)" + (build.map { " (\($0))" } ?? "")
    }
    func updateWindowTitle() {
        panel.title = appTitle + (presenting && !statusTitle.isEmpty ? " · \(statusTitle)" : "")
        panel.titleVisibility = .visible
    }
    var autoFloat: Bool {
        get { defaults.object(forKey: "autoFloat") as? Bool ?? true }
        set { defaults.set(newValue, forKey: "autoFloat") }
    }
    var layout: Layout {
        get { Layout(rawValue: defaults.string(forKey: "layout") ?? "notes") ?? .notes }
        set { defaults.set(newValue.rawValue, forKey: "layout") }
    }
    var opacity: Int {
        get { defaults.object(forKey: "opacity") as? Int ?? 100 }
        set { defaults.set(newValue, forKey: "opacity") }
    }

    // MARK: launch

    func applicationDidFinishLaunching(_ note: Notification) {
        NSApp.setActivationPolicy(.regular)
        buildMainMenu()
        buildStatusItem()
        buildPanel()
        registerHotKeys()
        startInputMonitors()
        startServerWatchdog()
        ensureServer { [weak self] ok in
            guard let self else { return }
            if ok {
                self.web.load(URLRequest(url: URL(string: "http://127.0.0.1:\(kPort)/?host=mac")!))
            } else {
                self.web.loadHTMLString("<body style='font:16px -apple-system;padding:40px;background:#111;color:#eee'>无法启动内置服务。请退出旧版提词器，检查端口 5217 是否被占用，然后重新打开。菜单中的‘打开数据文件夹’可查看 server.log。<br><br>Could not start the bundled server. Quit older copies and check port 5217. See server.log in the data folder.</body>", baseURL: nil)
            }
        }
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ app: NSApplication) -> Bool { true }

    func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
        panel.makeKeyAndOrderFront(nil)
        return true
    }

    func applicationWillTerminate(_ note: Notification) {
        serverProc?.terminate()
    }

    // URL scheme tp-shell://<command> (testing and automation)
    func application(_ app: NSApplication, open urls: [URL]) {
        for url in urls {
            let cmd = (url.host ?? "") + url.path
            switch cmd {
            case "present-on": setPresenting(true)
            case "present-off": setPresenting(false)
            case "toggle-present": setPresenting(!presenting)
            case "listen-toggle": toggleListening()
            case "builds-toggle": toggleBuilds()
            case let c where c.hasPrefix("manual-"): manual(String(c.dropFirst(7)))
            case "reload": web.reload()
            case let c where c.hasPrefix("layout-"):
                if let l = Layout(rawValue: String(c.dropFirst(7))) { chooseLayout(l) }
            case let c where c.hasPrefix("opacity-"):
                if let v = Int(c.dropFirst(8)) { chooseOpacity(v) }
            default: break
            }
        }
    }

    // MARK: server

    func health(_ cb: @escaping (Bool) -> Void) {
        var req = URLRequest(url: URL(string: "http://127.0.0.1:\(kPort)/api/ping")!)
        req.timeoutInterval = 0.8
        URLSession.shared.dataTask(with: req) { data, resp, _ in
            let info = data.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let ok = (resp as? HTTPURLResponse)?.statusCode == 200 && info?["instance"] as? String == self.serverInstance
            DispatchQueue.main.async { cb(ok) }
        }.resume()
    }

    func ensureServer(_ done: @escaping (Bool) -> Void) {
        health { [weak self] ok in
            guard let self else { return }
            if ok { return done(true) }
            self.startServer()
            self.waitHealthy(tries: 80, done)
        }
    }

    func waitHealthy(tries: Int, _ done: @escaping (Bool) -> Void) {
        health { [weak self] ok in
            if ok || tries <= 0 { return done(ok) }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { self?.waitHealthy(tries: tries - 1, done) }
        }
    }

    // If the server goes away (crash, idle exit, a quitting old instance), start
    // it again and reload the page.
    var serverMisses = 0
    func startServerWatchdog() {
        Timer.scheduledTimer(withTimeInterval: 3, repeats: true) { [weak self] _ in
            guard let self else { return }
            self.health { ok in
                if ok {
                    self.serverMisses = 0
                    return
                }
                self.serverMisses += 1
                if self.serverMisses == 2 {
                    if self.serverProc?.isRunning != true { self.startServer() }
                    self.waitHealthy(tries: 80) { up in if up { self.web.reload() } }
                }
            }
        }
    }

    func startServer() {
        guard serverProc?.isRunning != true else { return }
        let node = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/node").path
        guard FileManager.default.isExecutableFile(atPath: node) else { return }
        let p = Process()
        p.executableURL = URL(fileURLWithPath: node)
        p.arguments = ["server/main.mjs", "--idle-exit", "900"]
        p.currentDirectoryURL = URL(fileURLWithPath: projectDir)
        var env = ProcessInfo.processInfo.environment
        env["PATH"] = "/opt/homebrew/bin:/usr/local/bin:" + (env["PATH"] ?? "/usr/bin:/bin")
        env["PORT"] = String(kPort)
        env["HOST"] = "127.0.0.1"
        env["TELEPROMPTER_DATA"] = dataDir.path
        env["TELEPROMPTER_INSTANCE"] = serverInstance
        p.environment = env
        let logURL = dataDir.appendingPathComponent("server.log")
        try? FileManager.default.createDirectory(at: logURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        if let fh = try? FileHandle(forWritingTo: logURL) {
            fh.seekToEndOfFile()
            p.standardOutput = fh
            p.standardError = fh
        }
        do {
            try p.run()
            serverProc = p
        } catch {
            NSLog("teleprompter: cannot start server: \(error)")
        }
    }

    // MARK: window

    func buildPanel() {
        let frame = NSRect(x: 0, y: 0, width: 1180, height: 820)
        panel = PrompterPanel(contentRect: frame,
                              styleMask: [.titled, .closable, .miniaturizable, .resizable, .nonactivatingPanel],
                              backing: .buffered, defer: false)
        updateWindowTitle()
        panel.titlebarAppearsTransparent = true
        panel.isFloatingPanel = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = false
        panel.isReleasedWhenClosed = false
        panel.backgroundColor = NSColor(calibratedRed: 0.043, green: 0.047, blue: 0.059, alpha: 1)
        panel.appearance = NSAppearance(named: .darkAqua) // light title text on the dark window
        panel.delegate = self
        if let s = defaults.string(forKey: "editFrame"), NSRectFromString(s).width > 300 {
            panel.setFrame(NSRectFromString(s), display: false)
        } else {
            panel.center()
        }

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "tp")
        config.websiteDataStore = .default()
        web = WKWebView(frame: panel.contentView!.bounds, configuration: config)
        web.autoresizingMask = [.width, .height]
        web.uiDelegate = self
        web.navigationDelegate = self
        if #available(macOS 13.3, *) { web.isInspectable = true }
        panel.contentView!.addSubview(web)
        panel.makeKeyAndOrderFront(nil)
    }

    func targetScreen() -> NSScreen {
        let screens = NSScreen.screens
        if screens.count > 1, let builtIn = screens.first(where: { isBuiltIn($0) }) { return builtIn }
        return panel.screen ?? NSScreen.main ?? screens[0]
    }

    func isBuiltIn(_ s: NSScreen) -> Bool {
        let id = (s.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value ?? 0
        return CGDisplayIsBuiltin(id) != 0
    }

    func presentFrame() -> NSRect {
        let f = targetScreen().frame
        switch layout {
        case .notes:
            // Keynote's presenter display keeps the notes in a strip along the
            // bottom (measured: x 2.8%-97.2%, the lowest 28% of the screen),
            // below the current/next slide previews and the clock.
            if let s = defaults.string(forKey: "notesFrame") {
                let r = NSRectFromString(s)
                if r.width > 200 && r.height > 120 && NSScreen.screens.contains(where: { $0.frame.intersects(r) }) { return r }
            }
            return NSRect(x: (f.minX + f.width * 0.028).rounded(), y: f.minY,
                          width: (f.width * 0.944).rounded(), height: (f.height * 0.282).rounded())
        case .full: return f
        case .bottom: return NSRect(x: f.minX, y: f.minY, width: f.width, height: (f.height * 0.55).rounded())
        case .right: return NSRect(x: f.midX, y: f.minY, width: (f.width / 2).rounded(), height: f.height)
        case .free:
            if let s = defaults.string(forKey: "freeFrame") {
                let r = NSRectFromString(s)
                if r.width > 200 && r.height > 150 { return r }
            }
            return f
        }
    }

    func setPresenting(_ on: Bool) {
        if on == presenting { return }
        presenting = on
        if on {
            defaults.set(NSStringFromRect(panel.frame), forKey: "editFrame")
            panel.unconstrained = true
            panel.allowKey = false
            if panel.isKeyWindow { panel.resignKey() }
            // above a captured / full-screen slide show
            panel.level = NSWindow.Level(rawValue: Int(CGShieldingWindowLevel()) + 1)
            panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
            adjustingFrame = true
            panel.setFrame(presentFrame(), display: true)
            adjustingFrame = false
            panel.alphaValue = CGFloat(opacity) / 100
            for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(b)?.isHidden = true }
            panel.orderFrontRegardless()
            // give the keyboard back to the slide show (clicker keys)
            let ids = ["com.apple.Keynote", "com.apple.iWork.Keynote", "com.microsoft.Powerpoint"]
            if let slideApp = NSWorkspace.shared.runningApplications.first(where: { ids.contains($0.bundleIdentifier ?? "") && $0.isFinishedLaunching }) {
                if #available(macOS 14.0, *) { slideApp.activate() } else { slideApp.activate(options: []) }
            } else if NSApp.isActive {
                NSApp.deactivate()
            }
        } else {
            panel.allowKey = true
            panel.unconstrained = false
            panel.level = .normal
            panel.collectionBehavior = []
            panel.alphaValue = 1
            for b in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] { panel.standardWindowButton(b)?.isHidden = false }
            adjustingFrame = true
            if let s = defaults.string(forKey: "editFrame") { panel.setFrame(NSRectFromString(s), display: true) }
            adjustingFrame = false
        }
        updateWindowTitle()
        presentItem?.state = on ? .on : .off
        web.evaluateJavaScript("window.tpShell && tpShell.presenting(\(on))", completionHandler: nil)
    }

    func windowDidMove(_ note: Notification) { rememberFrame() }
    func windowDidResize(_ note: Notification) { rememberFrame() }
    func rememberFrame() {
        if presenting {
            // a moved or resized presenter window is remembered for its layout
            if layout == .free { defaults.set(NSStringFromRect(panel.frame), forKey: "freeFrame") }
            if layout == .notes && !adjustingFrame { defaults.set(NSStringFromRect(panel.frame), forKey: "notesFrame") }
        } else if panel.isVisible {
            defaults.set(NSStringFromRect(panel.frame), forKey: "editFrame")
        }
    }

    func chooseLayout(_ l: Layout) {
        if l == .free && presenting { defaults.set(NSStringFromRect(panel.frame), forKey: "freeFrame") }
        layout = l
        for (k, item) in layoutItems { item.state = k == l ? .on : .off }
        if presenting {
            adjustingFrame = true
            panel.setFrame(presentFrame(), display: true)
            adjustingFrame = false
        }
    }

    func chooseOpacity(_ v: Int) {
        opacity = max(30, min(100, v))
        for (k, item) in opacityItems { item.state = k == opacity ? .on : .off }
        if presenting { panel.alphaValue = CGFloat(opacity) / 100 }
    }

    func toggleListening() {
        web.evaluateJavaScript("window.tpShell && tpShell.toggleListening()", completionHandler: nil)
    }

    // MARK: page messages

    func userContentController(_ ucc: WKUserContentController, didReceive message: WKScriptMessage) {
        let origin = message.frameInfo.securityOrigin
        guard message.frameInfo.isMainFrame, origin.protocol == "http",
              origin.host == "127.0.0.1", origin.port == kPort else { return }
        guard let body = message.body as? [String: Any] else { return }
        if (body["type"] as? String) == "cmd" {
            if (body["cmd"] as? String) == "toggle-present" { setPresenting(!presenting) }
            if (body["cmd"] as? String) == "ask-input-access" { askInputAccess() }
            return
        }
        webView = body["view"] as? String ?? webView
        listening = body["listening"] as? Bool ?? listening
        slideSource = body["source"] as? String ?? slideSource
        let playing = body["playing"] as? Bool ?? false
        listenItem?.title = listening ? "停止收音  ⌃⌥空格" : "开始收音  ⌃⌥空格"
        if let st = body["title"] as? String, !st.isEmpty {
            statusTitle = st
            updateWindowTitle()
        }
        // auto: float while a slide show plays with the prompter open
        if autoFloat && playing != lastPlaying {
            if playing {
                // a show started: open the prompter if the editor is showing, then float
                if webView == "editor" {
                    web.evaluateJavaScript("window.tp && tp.api.startPrompter()", completionHandler: nil)
                }
                setPresenting(true)
            }
            if !playing && presenting { setPresenting(false) }
        }
        lastPlaying = playing
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.evaluateJavaScript("window.tpShell && tpShell.ready()", completionHandler: nil)
        reportInputAccess()
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.request.url?.absoluteString == "about:blank" {
            decisionHandler(.allow) // internally generated startup error page
            return
        }
        guard let url = navigationAction.request.url,
              url.scheme == "http", url.host == "127.0.0.1", url.port == kPort else {
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    // MARK: hand control of the show (observed, never intercepted)

    let slideApps = ["com.apple.Keynote", "com.apple.iWork.Keynote", "com.microsoft.Powerpoint"]

    func startInputMonitors() {
        axTrusted = AXIsProcessTrusted()
        mouseMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown]) { [weak self] e in self?.globalMouse(e) }
        keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { [weak self] e in self?.globalKey(e) }
        // the permission may be granted while the app runs
        Timer.scheduledTimer(withTimeInterval: 4, repeats: true) { [weak self] _ in
            guard let self else { return }
            let t = AXIsProcessTrusted()
            if t == self.axTrusted { return }
            self.axTrusted = t
            if let m = self.keyMonitor { NSEvent.removeMonitor(m) }
            self.keyMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.keyDown]) { [weak self] e in self?.globalKey(e) }
            self.reportInputAccess()
        }
    }

    func reportInputAccess() {
        accessItem?.state = axTrusted ? .on : .off
        web?.evaluateJavaScript("window.tpShell && tpShell.inputAccess && tpShell.inputAccess(\(axTrusted))", completionHandler: nil)
    }

    func askInputAccess() {
        let opts = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
        axTrusted = AXIsProcessTrustedWithOptions(opts)
        if !axTrusted, let url = URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") {
            NSWorkspace.shared.open(url)
        }
        reportInputAccess()
    }

    // the slide show is playing and has the keyboard
    var showFront: String? {
        guard lastPlaying, let id = NSWorkspace.shared.frontmostApplication?.bundleIdentifier, slideApps.contains(id) else { return nil }
        return id
    }

    func manual(_ kind: String) {
        guard ["next", "prev-build", "prev-slide", "next-slide", "jump"].contains(kind) else { return }
        web.evaluateJavaScript("window.tpShell && tpShell.manualInput && tpShell.manualInput('\(kind)')", completionHandler: nil)
    }

    // Keynote: → ↓ PageDown Space Return N = next build or slide; ⇧→ = next
    // without animation; ⇧↓ = next slide skipping builds; ← ↑ PageUp Delete P
    // = previous slide; ⇧← ⇧↑ = previous build; Home End = first/last;
    // digits open the slide switcher (Return jumps, Esc cancels).
    // PowerPoint: ← and PageUp step back one animation first.
    func globalKey(_ e: NSEvent) {
        guard let app = showFront else {
            switcherOpen = false
            return
        }
        if !e.modifierFlags.intersection([.command, .control, .option]).isEmpty { return }
        let shift = e.modifierFlags.contains(.shift)
        let k = Int(e.keyCode)
        // the switcher closes by itself after a while; do not stay deaf
        if switcherOpen && Date().timeIntervalSince(switcherAt) > 10 { switcherOpen = false }
        if switcherOpen {
            if k == kVK_Return || k == kVK_ANSI_KeypadEnter {
                switcherOpen = false
                manual("jump")
            } else if k == kVK_Escape {
                switcherOpen = false
            }
            return
        }
        let digits = [kVK_ANSI_0, kVK_ANSI_1, kVK_ANSI_2, kVK_ANSI_3, kVK_ANSI_4, kVK_ANSI_5, kVK_ANSI_6, kVK_ANSI_7, kVK_ANSI_8, kVK_ANSI_9,
                      kVK_ANSI_Keypad0, kVK_ANSI_Keypad1, kVK_ANSI_Keypad2, kVK_ANSI_Keypad3, kVK_ANSI_Keypad4, kVK_ANSI_Keypad5,
                      kVK_ANSI_Keypad6, kVK_ANSI_Keypad7, kVK_ANSI_Keypad8, kVK_ANSI_Keypad9]
        if digits.contains(k) && app != "com.microsoft.Powerpoint" {
            switcherOpen = true
            switcherAt = Date()
            return
        }
        let ppt = app == "com.microsoft.Powerpoint"
        switch k {
        case kVK_RightArrow: manual("next")
        case kVK_DownArrow: manual(shift ? "next-slide" : "next")
        case kVK_PageDown, kVK_Space, kVK_Return, kVK_ANSI_KeypadEnter, kVK_ANSI_N: manual("next")
        case kVK_LeftArrow, kVK_UpArrow: manual(shift || ppt ? "prev-build" : "prev-slide")
        case kVK_PageUp, kVK_Delete, kVK_ANSI_P: manual(ppt ? "prev-build" : "prev-slide")
        case kVK_Home, kVK_End: manual("jump")
        default: break
        }
    }

    // A click on the show advances it, except on the presenter display's top
    // bar (its buttons) and on windows of other apps (a show played in a
    // window). Clicks on this window never reach this monitor.
    func globalMouse(_ e: NSEvent) {
        guard let app = showFront else { return }
        switcherOpen = false
        let p = NSEvent.mouseLocation
        if let scr = NSScreen.screens.first(where: { NSMouseInRect(p, $0.frame, false) }), p.y > scr.frame.maxY - 70 { return }
        if let owner = windowOwner(at: p), let slidePid = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == app })?.processIdentifier,
           owner != slidePid { return }
        manual("next")
    }

    // The process that owns the topmost window under a point (screen
    // coordinates, origin bottom-left). Window bounds and owners need no
    // permission.
    func windowOwner(at p: NSPoint) -> pid_t? {
        guard let primary = NSScreen.screens.first else { return nil }
        let q = CGPoint(x: p.x, y: primary.frame.maxY - p.y) // CG: origin top-left
        guard let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] else { return nil }
        for w in list {
            // a playing show can sit at a very high window level: no layer filter,
            // only invisible overlays are skipped
            guard let b = w[kCGWindowBounds as String] as? [String: CGFloat], (w[kCGWindowAlpha as String] as? Double ?? 1) > 0.01 else { continue }
            let r = CGRect(x: b["X"] ?? 0, y: b["Y"] ?? 0, width: b["Width"] ?? 0, height: b["Height"] ?? 0)
            if r.contains(q), let pid = w[kCGWindowOwnerPID as String] as? pid_t {
                if pid == ProcessInfo.processInfo.processIdentifier { continue }
                return pid
            }
        }
        return nil
    }

    // JS dialogs (the editor asks before discarding changes)
    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.addButton(withTitle: "确定")
        a.addButton(withTitle: "取消")
        completionHandler(a.runModal() == .alertFirstButtonReturn)
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let a = NSAlert()
        a.messageText = message
        a.runModal()
        completionHandler()
    }

    // MARK: menus

    func item(_ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = [.command]) -> NSMenuItem {
        let i = NSMenuItem(title: title, action: action, keyEquivalent: key)
        i.keyEquivalentModifierMask = mods
        i.target = action.map { _ in self as AnyObject }
        return i
    }

    func buildMainMenu() {
        let main = NSMenu()
        let appItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "关于 智能提词器", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        appMenu.addItem(.separator())
        appMenu.addItem(item("配置 Jev API 密钥… / Configure Jev…", #selector(menuConfigureJev)))
        appMenu.addItem(item("打开数据文件夹 / Open data folder", #selector(menuDataFolder)))
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "隐藏 智能提词器", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
        appMenu.addItem(.separator())
        appMenu.addItem(withTitle: "退出 智能提词器", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appItem.submenu = appMenu
        main.addItem(appItem)

        // standard editing so ⌘C / ⌘V / ⌘Z work in the script editor
        let editItem = NSMenuItem()
        let edit = NSMenu(title: "编辑")
        edit.addItem(withTitle: "撤销", action: Selector(("undo:")), keyEquivalent: "z")
        let redo = edit.addItem(withTitle: "重做", action: Selector(("redo:")), keyEquivalent: "z")
        redo.keyEquivalentModifierMask = [.command, .shift]
        edit.addItem(.separator())
        edit.addItem(withTitle: "剪切", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        edit.addItem(withTitle: "拷贝", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        edit.addItem(withTitle: "粘贴", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        edit.addItem(withTitle: "全选", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = edit
        main.addItem(editItem)

        let viewItem = NSMenuItem()
        let view = NSMenu(title: "显示")
        view.addItem(item("演讲模式（悬浮在放映之上）", #selector(menuTogglePresent), "p", [.command, .shift]))
        view.addItem(item("重新载入", #selector(menuReload), "r"))
        viewItem.submenu = view
        main.addItem(viewItem)
        NSApp.mainMenu = main
    }

    func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        if let b = statusItem.button {
            b.image = NSImage(systemSymbolName: "text.alignleft", accessibilityDescription: "智能提词器")
            b.toolTip = "智能提词器"
        }
        let m = NSMenu()
        m.addItem(item("显示提词器", #selector(menuShow)))
        m.addItem(.separator())
        presentItem = item("演讲模式（悬浮在放映之上）  ⌃⌥P", #selector(menuTogglePresent))
        m.addItem(presentItem)
        autoItem = item("放映开始时自动进入演讲模式", #selector(menuToggleAuto))
        autoItem.state = autoFloat ? .on : .off
        m.addItem(autoItem)
        listenItem = item("开始收音  ⌃⌥空格", #selector(menuListen))
        m.addItem(listenItem)
        m.addItem(item("暂停/恢复语音控制动画和翻页  ⌃⌥B", #selector(menuToggleBuilds)))
        accessItem = item("同步翻页器和键盘（辅助功能权限）…", #selector(menuAccess))
        accessItem.state = axTrusted ? .on : .off
        m.addItem(accessItem)
        m.addItem(.separator())
        let layoutMenu = NSMenu()
        for l in Layout.allCases {
            let i = item(l.title, #selector(menuLayout(_:)))
            i.representedObject = l.rawValue
            i.state = l == layout ? .on : .off
            layoutItems[l] = i
            layoutMenu.addItem(i)
        }
        layoutMenu.addItem(.separator())
        layoutMenu.addItem(item("备注区位置恢复默认", #selector(menuResetNotes)))
        let layoutItem = NSMenuItem(title: "演讲模式的位置", action: nil, keyEquivalent: "")
        layoutItem.submenu = layoutMenu
        m.addItem(layoutItem)
        let opMenu = NSMenu()
        for v in [100, 90, 80, 70, 60] {
            let i = item("\(v)%", #selector(menuOpacity(_:)))
            i.tag = v
            i.state = v == opacity ? .on : .off
            opacityItems[v] = i
            opMenu.addItem(i)
        }
        let opItem = NSMenuItem(title: "演讲模式的不透明度", action: nil, keyEquivalent: "")
        opItem.submenu = opMenu
        m.addItem(opItem)
        m.addItem(.separator())
        m.addItem(item("退出 智能提词器", #selector(menuQuit)))
        statusItem.menu = m
    }

    @objc func menuShow() {
        if presenting { panel.orderFrontRegardless() } else {
            NSApp.activate(ignoringOtherApps: true)
            panel.makeKeyAndOrderFront(nil)
        }
    }
    @objc func menuTogglePresent() { setPresenting(!presenting) }
    @objc func menuToggleAuto() {
        autoFloat.toggle()
        autoItem.state = autoFloat ? .on : .off
    }
    @objc func menuListen() { toggleListening() }
    @objc func menuToggleBuilds() { toggleBuilds() }
    @objc func menuAccess() { askInputAccess() }
    func toggleBuilds() {
        web.evaluateJavaScript("window.tpShell && tpShell.toggleBuilds && tpShell.toggleBuilds()", completionHandler: nil)
    }
    @objc func menuReload() { web.reload() }
    @objc func menuDataFolder() {
        try? FileManager.default.createDirectory(at: dataDir, withIntermediateDirectories: true)
        NSWorkspace.shared.open(dataDir)
    }
    @objc func menuConfigureJev() {
        NSApp.activate(ignoringOtherApps: true)
        let alert = NSAlert()
        alert.messageText = "Jev API 密钥 / Jev API key"
        alert.informativeText = "可选功能：密钥保存在 macOS 钥匙串。Jev 会接收相关讲稿片段和识别文字；不配置也可本地跟读。保存后请重新打开应用。\nOptional: stored in macOS Keychain. Jev receives relevant script excerpts and transcripts. Restart after saving."
        let field = NSSecureTextField(frame: NSRect(x: 0, y: 0, width: 380, height: 26))
        alert.accessoryView = field
        alert.addButton(withTitle: "保存 / Save")
        alert.addButton(withTitle: "取消 / Cancel")
        alert.addButton(withTitle: "移除应用密钥 / Remove app key")
        alert.window.initialFirstResponder = field
        let result = alert.runModal()
        let query: [String: Any] = [kSecClass as String: kSecClassGenericPassword,
                                    kSecAttrService as String: keychainService,
                                    kSecAttrAccount as String: "typesafe-ai"]
        var status: OSStatus = errSecSuccess
        if result == .alertFirstButtonReturn {
            let value = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty else { return }
            let attributes = [kSecValueData as String: Data(value.utf8)]
            status = SecItemUpdate(query as CFDictionary, attributes as CFDictionary)
            if status == errSecItemNotFound {
                status = SecItemAdd(query.merging(attributes) { _, new in new } as CFDictionary, nil)
            }
        } else if result == .alertThirdButtonReturn {
            status = SecItemDelete(query as CFDictionary)
            if status == errSecItemNotFound { status = errSecSuccess }
        } else { return }
        field.stringValue = ""
        let notice = NSAlert()
        notice.messageText = status == errSecSuccess ? "已更新，请重新打开应用 / Updated; restart the app" : "钥匙串更新失败 / Keychain update failed (\(status))"
        notice.runModal()
    }
    @objc func menuQuit() { NSApp.terminate(nil) }
    @objc func menuLayout(_ sender: NSMenuItem) {
        if let raw = sender.representedObject as? String, let l = Layout(rawValue: raw) { chooseLayout(l) }
    }
    @objc func menuOpacity(_ sender: NSMenuItem) { chooseOpacity(sender.tag) }
    @objc func menuResetNotes() {
        defaults.removeObject(forKey: "notesFrame")
        if presenting && layout == .notes {
            adjustingFrame = true
            panel.setFrame(presentFrame(), display: true)
            adjustingFrame = false
        }
    }

    // MARK: global hotkeys (no accessibility permission needed)

    func registerHotKeys() {
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, event, userData -> OSStatus in
            var hk = EventHotKeyID()
            GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID), nil,
                              MemoryLayout<EventHotKeyID>.size, nil, &hk)
            let me = Unmanaged<AppDelegate>.fromOpaque(userData!).takeUnretainedValue()
            DispatchQueue.main.async {
                if hk.id == 1 { me.toggleListening() }
                if hk.id == 2 { me.setPresenting(!me.presenting) }
                if hk.id == 3 { me.toggleBuilds() }
            }
            return noErr
        }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), nil)
        let mods = UInt32(controlKey | optionKey)
        for (id, key) in [(UInt32(1), kVK_Space), (UInt32(2), kVK_ANSI_P), (UInt32(3), kVK_ANSI_B)] {
            var ref: EventHotKeyRef?
            RegisterEventHotKey(UInt32(key), mods, EventHotKeyID(signature: OSType(0x5450_4B59), id: id), GetApplicationEventTarget(), 0, &ref)
            hotKeys.append(ref)
        }
    }
}

@main
enum Main {
    static func main() {
        let app = NSApplication.shared
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
