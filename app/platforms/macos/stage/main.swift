// margin-space (Margin Space.app, in Margin.app's Contents/Helpers): the owner of Margin's full-screen Spaces
// (DECISIONS.md "Margin's Space owned by a helper with no Dock icon", 2026-11-19).
//
// Why it exists: macOS hands the keyboard to a full-screen Space's owner whenever the menu bar comes down there (Wi-Fi,
// Bluetooth, battery: the window server's SetMenuBars, docs/PRIVATE-APIS.md). Only an app with a Dock icon can be an
// owner. So the Space Margin hosts apps in is started by this program's window, an app with no Dock icon
// (LSUIElement), and Margin's own windows join it as plain members: the Space has no owner, and the app Margin hosts
// keeps the keyboard.
//
// What it does, nothing more: one invisible window per Margin window that asks for one, put into full screen (its own
// Space), kept there, closed when asked. No timers, no polling, no drawing (the window is clear and at alpha 0), never
// key, never active. About 12 MB, no CPU while idle (measured 2026-11-19).
//
// Margin starts it (MarginStage.swift, a child process) and talks to it over its standard input and output, one line
// per message, numbers only:
//   Margin → it:   open <id> <display id>     a window for Margin's window <id> on that display, into full screen
//                  close <id>                 that window closed (its Space goes with it)
//   it → Margin:   window <id> <number>       the window exists (the window server's number)
//                  full <id>                  it's in full screen (its own Space)
//                  left <id>                  it left full screen (macOS took it out): it goes straight back in
//                  failed <id>                macOS didn't take it to full screen three times: given up
//                  resized <id> <w> <h>       its size changed (a tile change laid its Space out again)
//                  ready                      started
// Its input closed (Margin quit or crashed): it quits at once, and its Spaces close.

import AppKit

setvbuf(stdout, nil, _IOLBF, 0)

func say(_ line: String) {
    FileHandle.standardOutput.write(Data((line + "\n").utf8))
}

// Never key or main: the keyboard stays with the app Margin hosts (or Margin's own panel).
final class StageWindow: NSWindow {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

final class Stage: NSObject, NSWindowDelegate {
    let id: Int
    let window: StageWindow
    private var tries = 0
    private var closing = false

    init(id: Int, screen: NSScreen) {
        self.id = id
        let size = NSSize(width: 480, height: 320)
        let f = screen.frame
        window = StageWindow(contentRect: NSRect(x: f.midX - size.width / 2, y: f.midY - size.height / 2, width: size.width, height: size.height),
                             styleMask: [.titled, .resizable], backing: .buffered, defer: false, screen: screen)
        super.init()
        window.title = "Margin"
        window.isOpaque = false
        window.backgroundColor = .clear
        window.alphaValue = 0
        window.hasShadow = false
        window.isReleasedWhenClosed = false
        window.animationBehavior = .none
        window.collectionBehavior = [.fullScreenPrimary, .managed]
        window.delegate = self
        window.orderFrontRegardless()
        say("window \(id) \(window.windowNumber)")
        enter()
    }

    // Into full screen through AppKit's own accessibility setter (the same path as the AXFullScreen attribute): AppKit's
    // toggle is refused to an app that isn't active, this isn't.
    func enter() {
        guard !closing, !window.styleMask.contains(.fullScreen) else { return }
        tries += 1
        window.accessibilitySetValue(true, forAttribute: NSAccessibility.Attribute(rawValue: "AXFullScreen"))
    }

    func close() {
        closing = true
        window.delegate = nil
        window.close()
    }

    func windowDidEnterFullScreen(_ notification: Notification) {
        tries = 0
        say("full \(id)")
    }

    func windowDidFailToEnterFullScreen(_ window: NSWindow) {
        guard !closing else { return }
        guard tries < 3 else { return say("failed \(id)") }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3 * Double(tries)) { [weak self] in self?.enter() }
    }

    func windowDidExitFullScreen(_ notification: Notification) {
        guard !closing else { return }
        say("left \(id)")
        tries = 0
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.3) { [weak self] in self?.enter() }
    }

    func windowDidResize(_ notification: Notification) {
        guard !closing, window.styleMask.contains(.fullScreen) else { return }
        say("resized \(id) \(Int(window.frame.width)) \(Int(window.frame.height))")
    }
}

final class Helper {
    var stages: [Int: Stage] = [:]
    private var pending = ""

    func handle(_ line: String) {
        let parts = line.split(separator: " ").map(String.init)
        guard let verb = parts.first, parts.count >= 2, let id = Int(parts[1]) else { return }
        switch verb {
        case "open":
            stages[id]?.close()
            let display = parts.count >= 3 ? UInt32(parts[2]) : nil
            let screen = NSScreen.screens.first { ($0.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?.uint32Value == display }
                ?? NSScreen.main ?? NSScreen.screens.first
            guard let screen else { return say("failed \(id)") }
            stages[id] = Stage(id: id, screen: screen)
        case "close":
            stages.removeValue(forKey: id)?.close()
        default:
            break
        }
    }

    func read(_ data: Data) {
        guard !data.isEmpty else { exit(0) } // Margin's end of the pipe closed: Margin quit or crashed
        pending += String(decoding: data, as: UTF8.self)
        while let end = pending.firstIndex(of: "\n") {
            let line = String(pending[..<end])
            pending = String(pending[pending.index(after: end)...])
            handle(line)
        }
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let helper = Helper()
FileHandle.standardInput.readabilityHandler = { handle in
    let data = handle.availableData
    DispatchQueue.main.async { helper.read(data) }
}
signal(SIGPIPE, SIG_IGN)
say("ready")
app.run()
