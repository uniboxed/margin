// Launch-scoped private AppKit configuration; no library loading or preference writes.
import AppKit
import ApplicationServices
import Darwin

extension VisualRun {
    func selectOwnedFixtureTab() async throws {
        guard name == "chrome" || name == "edge", let window=axWindow else { return }
        if (read(window,"AXTitle").1 as? String)?.contains("Traffic-light visual test") == true { return }
        var queue:[(AXUIElement,Int)]=[(window,0)], visited=0
        while !queue.isEmpty && visited<600 {
            let (element,depth)=queue.removeFirst();visited+=1
            let role=read(element,"AXRole").1 as? String ?? ""
            let title=read(element,"AXTitle").1 as? String ?? ""
            let description=read(element,"AXDescription").1 as? String ?? ""
            if role == "AXRadioButton", title.contains("Traffic-light visual test") || description.hasPrefix("Traffic-light visual test") {
                let result=AXUIElementPerformAction(element,"AXPress" as CFString)
                log("select-owned-fixture-tab",["result":result.rawValue,"role":role,"title":title])
                try check(result == .success,"fixture tab selection failed");try await pause(0.5);return
            }
            if depth<12, let children=read(element,"AXChildren").1 as? [AXUIElement] { queue += children.map { ($0,depth+1) } }
        }
        throw Failure("exact owned fixture tab not found")
    }
    func cornerSnapshot(_ label: String, expected: CGSize? = nil) throws {
        guard let window = axWindow else { throw Failure("missing corner test window") }
        if name == "chrome" || name == "edge" {
            try check((read(window,"AXTitle").1 as? String)?.contains("Traffic-light visual test") == true,"browser fixture page is not the visible tab")
        }
        let (result, fullscreen) = read(window, "AXFullScreen")
        try check(result == .success && fullscreen as? Bool == false, "window is not confirmed windowed")
        guard let value = read(window, "AXSize").1, CFGetTypeID(value) == AXValueGetTypeID() else { throw Failure("AX size absent") }
        var size = CGSize.zero
        try check(AXValueGetValue(value as! AXValue, .cgSize, &size), "invalid AX size")
        if let expected { try check(abs(size.width-expected.width) < 1 && abs(size.height-expected.height) < 1, "resize did not reach expected size") }
        let buttons = try ["AXCloseButton", "AXMinimizeButton", "AXZoomButton"].map { name -> [String: Any] in
            guard let button = read(window, name).1, CFGetTypeID(button) == AXUIElementGetTypeID() else { throw Failure("missing native control " + name) }
            return ["name": name, "enabled": read(button as! AXUIElement, "AXEnabled").1 as? Bool ?? false]
        }
        log("corner-snapshot", ["label": label, "windowed": true, "size": [size.width,size.height], "buttons": buttons])
    }
    func runCornerLaunch() async throws {
        externalCaption = "Native corner configuration at launch. No library, image cover or saved preference change."
        let number = try await createExternal()
        try await selectOwnedFixtureTab()
        try await capture.start(pid: targetPID!, number: number, url: directory.appendingPathComponent(name + "-raw.mp4"))
        phase(cornerLaunchOverride == true ? "Private launch override 0.01" : "Standard launch control")
        try cornerSnapshot("startup"); try await pause(1.5)
        guard let originalSize else { throw Failure("missing original window size") }
        var original = CGSize.zero
        try check(AXValueGetValue(originalSize as! AXValue, .cgSize, &original), "original size invalid")
        try resizeExternal(); try await pause(0.7)
        phase("Resized — same native launch configuration")
        try cornerSnapshot("resized", expected: CGSize(width: original.width+80,height: original.height+45))
        try await pause(1.5)
        restoreExternal(); try await pause(0.7)
        phase("Original size restored")
        try cornerSnapshot("size-restored", expected: original); try await pause(1.5)
        try await capture.stop()
        log("recording-finished", ["completeFrames": capture.state.3, "video": name + "-raw.mp4"])
    }
}

@main struct CornerLaunchMain {
    @MainActor static func main() async {
        setbuf(stdout,nil)
        let args = CommandLine.arguments
        guard let ci=args.firstIndex(of:"--case"), args.count>ci+1, ["textedit","preview","chrome","edge"].contains(args[ci+1]),
              let oi=args.firstIndex(of:"--output"), args.count>oi+1 else {
            print("Usage: --case textedit|preview|chrome|edge --output NEW_DIRECTORY [--override-corners] [--run]"); return
        }
        let name=args[ci+1], override=args.contains("--override-corners"), directory=URL(fileURLWithPath:args[oi+1],isDirectory:true)
        guard args.contains("--run") else {
            print("DRY: fresh \(name), launch override=\(override), exact-window sampled recording, AX resize/restore, close app and remove temporary document. Existing sessions refused; no saved preferences or libraries changed.");return
        }
        do {
            var length=0;sysctlbyname("kern.osversion",nil,&length,nil,0)
            var bytes=[CChar](repeating:0,count:length);sysctlbyname("kern.osversion",&bytes,&length,nil,0)
            try check(String(cString:bytes)=="25G342" && AXIsProcessTrusted() && CGPreflightScreenCaptureAccess(),"requires 25G342, AX and capture access")
            try check(!FileManager.default.fileExists(atPath:directory.path),"output exists; preserve earlier evidence")
            try FileManager.default.createDirectory(at:directory,withIntermediateDirectories:true)
            NSApplication.shared.setActivationPolicy(.accessory);NSApplication.shared.finishLaunching()
            let run=VisualRun(name:name,directory:directory);run.cornerLaunchOverride=override
            let watchdog=Task { @MainActor in
                do { try await pause(45) } catch { return }
                run.log("failure",["description":"45-second watchdog"])
                await run.cleanup();exit(3)
            }
            do { try await run.runCornerLaunch(); await run.cleanup();watchdog.cancel() }
            catch { run.log("failure",["description":String(describing:error)]);try? await run.capture.stop();await run.cleanup();watchdog.cancel();exit(2) }
        } catch { print("REFUSED: \(error)");exit(2) }
    }
}
