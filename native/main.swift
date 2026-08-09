import Cocoa
import WebKit

/**
 MacScheduler — native AppKit shell around the web UI.

 Activation model:
   - Opening the custom `macscheduler://` URL scheme (or the loopback URL)
     brings the already-running app to the foreground.
   - Closing the window quits the app and terminates the child Node server,
     so nothing keeps running in the background.
 */

let MAC_SCHEDULER_PORT = 8742
let MAC_SCHEDULER_URL = "http://127.0.0.1:\(MAC_SCHEDULER_PORT)"

final class AppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate {
    private var window: NSWindow!
    private var webView: WKWebView!
    private var server: Process?
    private var serverReady = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        registerURLScheme()
        startServer()
        buildWindow()
        pollForServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    // MARK: - URL scheme activation (macscheduler:// and http://127.0.0.1:8742)
    private func registerURLScheme() {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleURLEvent(_:withReplyEvent:)),
            forEventClass: AEEventClass(kInternetEventClass),
            andEventID: AEEventID(kAEGetURL)
        )
    }

    @objc func handleURLEvent(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        activate()
    }

    private func activate() {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        window.makeMain()
        if serverReady { reload() }
    }

    // MARK: - Node server lifecycle
    private func startServer() {
        let resources = Bundle.main.resourcePath ?? ""
        let serverPath = (resources as NSString).appendingPathComponent("server.js")

        var env = ProcessInfo.processInfo.environment
        env["MAC_SCHEDULER_PORT"] = String(MAC_SCHEDULER_PORT)
        env["MAC_SCHEDULER_NATIVE"] = "1"

        let p = Process()
        p.executableURL = URL(fileURLWithPath: findNode())
        p.arguments = [serverPath]
        p.currentDirectoryPath = resources
        p.environment = env

        let err = Pipe()
        p.standardError = err
        err.fileHandleForReading.readabilityHandler = { h in
            if let s = String(data: h.availableData, encoding: .utf8), !s.isEmpty {
                NSLog("[server] %@", s.trimmingCharacters(in: .whitespacesAndNewlines))
            }
        }
        try? p.run()
        server = p
    }

    private func findNode() -> String {
        let home = NSHomeDirectory()
        let candidates = [
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
            "\(home)/.local/bin/node",
            "\(home)/.hermes/node/bin/node",
            Bundle.main.resourcePath?.appending("/node"),
        ].compactMap { $0 }
        if let c = candidates.first(where: { FileManager.default.isExecutableFile(atPath: $0) }) {
            return c
        }
        return "/opt/homebrew/bin/node"
    }

    private func pollForServer() {
        DispatchQueue.global().async {
            var tries = 0
            while tries < 50 && !self.serverUp() {
                tries += 1
                Thread.sleep(forTimeInterval: 0.25)
            }
            DispatchQueue.main.async {
                self.serverReady = self.serverUp()
                if self.serverReady { self.reload() }
            }
        }
    }

    private func serverUp() -> Bool {
        guard let url = URL(string: MAC_SCHEDULER_URL + "/api") else { return false }
        var req = URLRequest(url: url)
        req.timeoutInterval = 1
        let sem = DispatchSemaphore(value: 0)
        var up = false
        URLSession.shared.dataTask(with: req) { _, resp, _ in
            if let r = resp as? HTTPURLResponse, r.statusCode == 200 { up = true }
            sem.signal()
        }.resume()
        let _ = sem.wait(timeout: .now() + 1.2)
        return up
    }

    private func reload() {
        if let url = URL(string: MAC_SCHEDULER_URL) {
            webView?.load(URLRequest(url: url))
        }
    }

    // MARK: - Window
    private func buildWindow() {
        let rect = NSRect(x: 0, y: 0, width: 1180, height: 780)
        window = NSWindow(
            contentRect: rect,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = "Mac Scheduler"
        window.titlebarAppearsTransparent = true
        window.titleVisibility = .hidden
        window.center()
        window.setFrameAutosaveName("MacSchedulerWindow")
        window.delegate = self
        window.isReleasedWhenClosed = false

        webView = WKWebView(frame: window.contentView!.bounds)
        webView.autoresizingMask = [.width, .height]
        webView.navigationDelegate = self
        webView.setValue(false, forKey: "drawsBackground")
        window.contentView?.addSubview(webView)
        window.makeKeyAndOrderFront(nil)
    }

    // MARK: - Delegates
    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowWillClose(_ notification: Notification) {
        NSApp.terminate(nil)
    }

    func applicationWillTerminate(_ notification: Notification) {
        server?.terminate()
        server = nil
    }
}

// Entry point (no @main attribute to keep swiftc happy with top-level code)
let application = NSApplication.shared
let delegate = AppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
