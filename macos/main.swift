// Manuscript.app: a native window around the local writing desk.
// It starts server.js when it opens, shows it in its own window, and stops it on quit.
// Build with ./macos/build.sh
import Cocoa
import WebKit

let port = 4747
let baseURL = URL(string: "http://localhost:\(port)/")!
let logDir = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Library/Logs/Manuscript")

func log(_ message: String) {
    let line = "\(ISO8601DateFormatter().string(from: Date())) \(message)\n"
    let file = logDir.appendingPathComponent("app.log")
    try? FileManager.default.createDirectory(at: logDir, withIntermediateDirectories: true)
    if let handle = try? FileHandle(forWritingTo: file) {
        handle.seekToEndOfFile()
        handle.write(line.data(using: .utf8)!)
        try? handle.close()
    } else {
        try? line.write(to: file, atomically: true, encoding: .utf8)
    }
}

struct LaunchError: Error { let message: String }

final class AppDelegate: NSObject, NSApplicationDelegate, WKNavigationDelegate, WKUIDelegate, WKDownloadDelegate, WKScriptMessageHandler {
    var window: NSWindow!
    var web: WKWebView!
    var server: Process?
    var quitting = false
    var loaded = false
    var downloads: [ObjectIdentifier: URL] = [:]

    // MARK: launch

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()

        let config = WKWebViewConfiguration()
        // Report page errors to ~/Library/Logs/Manuscript/app.log.
        let reporter = """
        window.addEventListener('error', function (e) {
          window.webkit.messageHandlers.log.postMessage('JS error: ' + e.message + ' at ' + (e.filename || '') + ':' + (e.lineno || ''));
        });
        window.addEventListener('unhandledrejection', function (e) {
          window.webkit.messageHandlers.log.postMessage('JS rejection: ' + (e.reason && e.reason.message || e.reason));
        });
        """
        config.userContentController.addUserScript(WKUserScript(source: reporter, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        config.userContentController.add(self, name: "log")

        web = WKWebView(frame: .zero, configuration: config)
        web.navigationDelegate = self
        web.uiDelegate = self
        let zoom = UserDefaults.standard.double(forKey: "pageZoom")
        if zoom > 0 { web.pageZoom = zoom }

        window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
                          styleMask: [.titled, .closable, .miniaturizable, .resizable],
                          backing: .buffered, defer: false)
        window.title = "Manuscript"
        window.isReleasedWhenClosed = false
        window.minSize = NSSize(width: 720, height: 480)
        window.contentView = web
        window.center()
        window.setFrameAutosaveName("ManuscriptMainWindow")
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)

        showMessage("Opening your manuscript…", detail: "")
        ping { up in
            if up {
                log("server already running; attaching")
                self.loadApp()
                return
            }
            do {
                try self.startServer()
                self.waitForServer(triesLeft: 80)
            } catch let error as LaunchError {
                self.showMessage("Manuscript could not start", detail: error.message)
            } catch {
                self.showMessage("Manuscript could not start", detail: error.localizedDescription)
            }
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    // Save whatever is still unsaved before the app goes away.
    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        quitting = true
        guard loaded else { return .terminateNow }
        var replied = false
        let finish = {
            if replied { return }
            replied = true
            NSApp.reply(toApplicationShouldTerminate: true)
        }
        web.callAsyncJavaScript("if (typeof save === 'function') { await save(); }", arguments: [:], in: nil, in: .page) { _ in finish() }
        DispatchQueue.main.asyncAfter(deadline: .now() + 3) { finish() }
        return .terminateLater
    }

    func applicationWillTerminate(_ notification: Notification) {
        if let server = server, server.isRunning {
            server.terminate()
            log("server stopped")
        }
    }

    // MARK: the local server

    func ping(_ done: @escaping (Bool) -> Void) {
        var request = URLRequest(url: baseURL.appendingPathComponent("api/books"))
        request.timeoutInterval = 1.5
        request.cachePolicy = .reloadIgnoringLocalCacheData
        URLSession.shared.dataTask(with: request) { _, response, _ in
            let ok = (response as? HTTPURLResponse)?.statusCode == 200
            DispatchQueue.main.async { done(ok) }
        }.resume()
    }

    func waitForServer(triesLeft: Int) {
        ping { up in
            if up { self.loadApp(); return }
            if let server = self.server, !server.isRunning {
                self.showMessage("Manuscript could not start", detail: "The server stopped as soon as it started. Details are in \(logDir.path)/server.log")
                return
            }
            if triesLeft <= 0 {
                self.showMessage("Manuscript could not start", detail: "The server did not answer on port \(port).")
                return
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.waitForServer(triesLeft: triesLeft - 1) }
        }
    }

    func startServer() throws {
        let fm = FileManager.default
        let info = Bundle.main.infoDictionary ?? [:]
        let home = fm.homeDirectoryForCurrentUser.path

        // The app can sit next to server.js, or anywhere else (it remembers where it was built).
        let folders = [Bundle.main.bundleURL.deletingLastPathComponent().path, info["ManuscriptHome"] as? String ?? ""]
        guard let folder = folders.first(where: { !$0.isEmpty && fm.fileExists(atPath: $0 + "/server.js") }) else {
            throw LaunchError(message: "The Manuscript folder (the one with server.js and your books) was not found at \(folders.last ?? ""). If you moved it, run macos/build.sh there again.")
        }
        let nodes = [info["NodePath"] as? String ?? "", "\(home)/.local/bin/node", "/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        guard let node = nodes.first(where: { !$0.isEmpty && fm.isExecutableFile(atPath: $0) }) else {
            throw LaunchError(message: "Node.js was not found. Install it from nodejs.org, then open Manuscript again.")
        }

        try fm.createDirectory(at: logDir, withIntermediateDirectories: true)
        let logFile = logDir.appendingPathComponent("server.log")
        fm.createFile(atPath: logFile.path, contents: nil)
        let out = try FileHandle(forWritingTo: logFile)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: node)
        process.arguments = ["server.js"]
        process.currentDirectoryURL = URL(fileURLWithPath: folder)
        var env = ProcessInfo.processInfo.environment
        env["PORT"] = String(port)
        process.environment = env
        process.standardOutput = out
        process.standardError = out
        process.terminationHandler = { p in
            DispatchQueue.main.async {
                log("server exited with status \(p.terminationStatus)")
                if !self.quitting && self.loaded {
                    self.showMessage("The Manuscript server stopped", detail: "Your writing is saved. Quit and open Manuscript again.")
                }
            }
        }
        try process.run()
        server = process
        log("started server: \(node) in \(folder)")
    }

    // MARK: pages

    func loadApp() {
        loaded = true
        web.load(URLRequest(url: baseURL, cachePolicy: .reloadIgnoringLocalCacheData))
    }

    func showMessage(_ title: String, detail: String) {
        let esc = { (s: String) in s.replacingOccurrences(of: "&", with: "&amp;").replacingOccurrences(of: "<", with: "&lt;") }
        let html = """
        <!doctype html><meta charset="utf-8"><meta name="color-scheme" content="light dark">
        <style>
          html, body { height: 100%; margin: 0; }
          body { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center;
                 font: 14px -apple-system, sans-serif; color: #55534d; background: #efeeea; padding: 0 40px; }
          h1 { font: 600 22px "Iowan Old Style", Palatino, Georgia, serif; color: #1d1d1b; margin: 0 0 8px; }
          p { max-width: 520px; line-height: 1.5; margin: 0; }
          @media (prefers-color-scheme: dark) { body { background: #151617; color: #b0ada5; } h1 { color: #e6e3dc; } }
        </style>
        <h1>\(esc(title))</h1><p>\(esc(detail))</p>
        """
        web.loadHTMLString(html, baseURL: nil)
    }

    func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
        log(String(describing: message.body))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard webView.url?.host == "localhost" else { return }
        webView.evaluateJavaScript("document.title") { title, _ in log("loaded \(webView.url?.absoluteString ?? "") title=\(title ?? "")") }
        selfTest()
    }

    // Self-test hook: MANUSCRIPT_DEBUG_SNAPSHOT=/path/to.png (and optionally MANUSCRIPT_DEBUG_JS, an
    // async script body) runs the script in the page, logs its result, saves a picture of the
    // window's contents, and quits. Does nothing in normal use.
    var selfTested = false
    func selfTest() {
        let env = ProcessInfo.processInfo.environment
        guard !selfTested, let path = env["MANUSCRIPT_DEBUG_SNAPSHOT"] else { return }
        selfTested = true
        let js = env["MANUSCRIPT_DEBUG_JS"] ?? "await new Promise(r => setTimeout(r, 1500)); return document.title"
        web.callAsyncJavaScript(js, arguments: [:], in: nil, in: .page) { result in
            log("self-test: \(result)")
            self.web.takeSnapshot(with: nil) { image, _ in
                if let tiff = image?.tiffRepresentation, let rep = NSBitmapImageRep(data: tiff),
                   let png = rep.representation(using: .png, properties: [:]) {
                    try? png.write(to: URL(fileURLWithPath: path))
                }
                NSApp.terminate(nil)
            }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        log("navigation failed: \(error.localizedDescription)")
        if loaded && !quitting { showMessage("Manuscript lost its server", detail: "Quit and open Manuscript again. Your writing is saved.") ; loaded = false }
    }

    // MARK: links and downloads

    func webView(_ webView: WKWebView, decidePolicyFor action: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if action.shouldPerformDownload { decisionHandler(.download); return }
        if let url = action.request.url, let scheme = url.scheme, ["http", "https"].contains(scheme), url.host != "localhost" {
            NSWorkspace.shared.open(url)       // anything that is not the app opens in the browser
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, decidePolicyFor response: WKNavigationResponse, decisionHandler: @escaping (WKNavigationResponsePolicy) -> Void) {
        let disposition = (response.response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition") ?? ""
        decisionHandler(disposition.lowercased().hasPrefix("attachment") || !response.canShowMIMEType ? .download : .allow)
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) { download.delegate = self }
    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) { download.delegate = self }

    func download(_ download: WKDownload, decideDestinationUsing response: URLResponse, suggestedFilename: String, completionHandler: @escaping (URL?) -> Void) {
        let panel = NSSavePanel()
        panel.nameFieldStringValue = suggestedFilename
        panel.directoryURL = FileManager.default.urls(for: .downloadsDirectory, in: .userDomainMask).first
        panel.beginSheetModal(for: window) { result in
            guard result == .OK, let url = panel.url else { completionHandler(nil); return }
            try? FileManager.default.removeItem(at: url)   // the panel already asked about replacing
            self.downloads[ObjectIdentifier(download)] = url
            completionHandler(url)
        }
    }

    func downloadDidFinish(_ download: WKDownload) {
        if let url = downloads.removeValue(forKey: ObjectIdentifier(download)) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        }
    }

    func download(_ download: WKDownload, didFailWithError error: Error, resumeData: Data?) {
        downloads.removeValue(forKey: ObjectIdentifier(download))
        log("download failed: \(error.localizedDescription)")
    }

    // MARK: panels the page can ask for

    func webView(_ webView: WKWebView, runOpenPanelWith parameters: WKOpenPanelParameters, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping ([URL]?) -> Void) {
        let panel = NSOpenPanel()
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.canChooseDirectories = false
        panel.beginSheetModal(for: window) { result in completionHandler(result == .OK ? panel.urls : nil) }
    }

    func webView(_ webView: WKWebView, runJavaScriptAlertPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping () -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.beginSheetModal(for: window) { _ in completionHandler() }
    }

    func webView(_ webView: WKWebView, runJavaScriptConfirmPanelWithMessage message: String, initiatedByFrame frame: WKFrameInfo, completionHandler: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = message
        alert.addButton(withTitle: "OK")
        alert.addButton(withTitle: "Cancel")
        alert.beginSheetModal(for: window) { completionHandler($0 == .alertFirstButtonReturn) }
    }

    // MARK: menu

    // Find lives in the page (it searches the chapter and the whole book); the menu just opens it.
    func page(_ script: String) { if loaded { web.evaluateJavaScript("if (typeof openFind === 'function') { \(script) }", completionHandler: nil) } }
    @objc func findInPage(_ sender: Any?) { page("openFind()") }
    @objc func findNext(_ sender: Any?) { page("findStep(1)") }
    @objc func findPrevious(_ sender: Any?) { page("findStep(-1)") }
    @objc func reloadPage(_ sender: Any?) { if loaded { web.reload() } }
    @objc func zoomIn(_ sender: Any?) { setZoom(web.pageZoom + 0.1) }
    @objc func zoomOut(_ sender: Any?) { setZoom(web.pageZoom - 0.1) }
    @objc func zoomReset(_ sender: Any?) { setZoom(1) }
    func setZoom(_ value: CGFloat) {
        web.pageZoom = min(2, max(0.6, value))
        UserDefaults.standard.set(Double(web.pageZoom), forKey: "pageZoom")
    }
    @objc func showBooksFolder(_ sender: Any?) {
        let info = Bundle.main.infoDictionary ?? [:]
        for folder in [Bundle.main.bundleURL.deletingLastPathComponent().path, info["ManuscriptHome"] as? String ?? ""] {
            let books = folder + "/books"
            if FileManager.default.fileExists(atPath: books) { NSWorkspace.shared.open(URL(fileURLWithPath: books)); return }
        }
    }

    func buildMenu() {
        let main = NSMenu()
        func menu(_ title: String, _ build: (NSMenu) -> Void) {
            let item = NSMenuItem()
            let sub = NSMenu(title: title)
            build(sub)
            item.submenu = sub
            main.addItem(item)
        }
        func add(_ m: NSMenu, _ title: String, _ action: Selector?, _ key: String = "", _ mods: NSEvent.ModifierFlags = .command, target: AnyObject? = nil) {
            let item = m.addItem(withTitle: title, action: action, keyEquivalent: key)
            item.keyEquivalentModifierMask = mods
            item.target = target
        }
        menu("Manuscript") { m in
            add(m, "About Manuscript", #selector(NSApplication.orderFrontStandardAboutPanel(_:)))
            m.addItem(.separator())
            add(m, "Hide Manuscript", #selector(NSApplication.hide(_:)), "h")
            add(m, "Hide Others", #selector(NSApplication.hideOtherApplications(_:)), "h", [.command, .option])
            add(m, "Show All", #selector(NSApplication.unhideAllApplications(_:)))
            m.addItem(.separator())
            add(m, "Quit Manuscript", #selector(NSApplication.terminate(_:)), "q")
        }
        menu("File") { m in
            add(m, "Show Books Folder in Finder", #selector(showBooksFolder(_:)), target: self)
            m.addItem(.separator())
            add(m, "Close Window", #selector(NSWindow.performClose(_:)), "w")
        }
        menu("Edit") { m in
            add(m, "Undo", Selector(("undo:")), "z")
            add(m, "Redo", Selector(("redo:")), "z", [.command, .shift])
            m.addItem(.separator())
            add(m, "Cut", #selector(NSText.cut(_:)), "x")
            add(m, "Copy", #selector(NSText.copy(_:)), "c")
            add(m, "Paste", #selector(NSText.paste(_:)), "v")
            add(m, "Paste and Match Style", #selector(NSTextView.pasteAsPlainText(_:)), "v", [.command, .option, .shift])
            add(m, "Select All", #selector(NSText.selectAll(_:)), "a")
            m.addItem(.separator())
            add(m, "Find…", #selector(findInPage(_:)), "f", target: self)
            add(m, "Find Next", #selector(findNext(_:)), "g", target: self)
            add(m, "Find Previous", #selector(findPrevious(_:)), "g", [.command, .shift], target: self)
        }
        menu("View") { m in
            add(m, "Actual Size", #selector(zoomReset(_:)), "0", target: self)
            add(m, "Zoom In", #selector(zoomIn(_:)), "+", target: self)
            add(m, "Zoom Out", #selector(zoomOut(_:)), "-", target: self)
            m.addItem(.separator())
            add(m, "Reload", #selector(reloadPage(_:)), "r", target: self)
            add(m, "Enter Full Screen", #selector(NSWindow.toggleFullScreen(_:)), "f", [.command, .control])
        }
        menu("Window") { m in
            add(m, "Minimize", #selector(NSWindow.performMiniaturize(_:)), "m")
            add(m, "Zoom", #selector(NSWindow.performZoom(_:)))
            NSApp.windowsMenu = m
        }
        NSApp.mainMenu = main
    }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
