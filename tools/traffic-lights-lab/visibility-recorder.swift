// Independent test measurement only: no AX, event injection, target changes or detector feedback.
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreMedia
import Darwin

func json(_ value: [String: Any], to path: String? = nil) throws {
    let data = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
    if let path { try data.write(to: URL(fileURLWithPath: path), options: .atomic) }
    else { print(String(decoding: data, as: UTF8.self)) }
}
struct RecorderError: Error { let message: String }
final class Measurement: NSObject, SCStreamOutput, SCStreamDelegate, SCRecordingOutputDelegate, @unchecked Sendable {
    private let lock = NSLock()
    private var stamps: [Double] = [], ended = false, began = false, error: String?
    var state: ([Double], Bool, Bool, String?) { lock.lock(); defer { lock.unlock() }; return (stamps, began, ended, error) }
    func recordingOutputDidStartRecording(_ output: SCRecordingOutput) { lock.lock(); began = true; lock.unlock() }
    func recordingOutputDidFinishRecording(_ output: SCRecordingOutput) { lock.lock(); ended = true; lock.unlock() }
    func recordingOutput(_ output: SCRecordingOutput, didFailWithError failure: Error) { lock.lock(); error = String(describing: failure); lock.unlock() }
    func stream(_ stream: SCStream, didStopWithError failure: Error) { lock.lock(); error = String(describing: failure); lock.unlock() }
    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sample.isValid else { return }
        let info = (CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first
        guard (info?[.status] as? Int) == SCFrameStatus.complete.rawValue else { return }
        lock.lock(); stamps.append(CMTimeGetSeconds(sample.presentationTimeStamp)); lock.unlock()
    }
    @MainActor func record(rect: CGRect, output: String, ready: String, phase: String, seconds: Double, pids: Set<pid_t>, stop: String) async throws {
        guard CGPreflightScreenCaptureAccess() else { throw RecorderError(message: "measurement host lacks existing Screen Recording access; no request made") }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { CGDisplayBounds($0.displayID).contains(rect) }) else { throw RecorderError(message: "canvas must fit on one display") }
        let displayRect = CGDisplayBounds(display.displayID)
        let scale = Double(CGDisplayPixelsWide(display.displayID)) / displayRect.width
        let config = SCStreamConfiguration()
        config.sourceRect = rect.offsetBy(dx: -displayRect.minX, dy: -displayRect.minY)
        config.width = Int(rect.width * scale) / 2 * 2; config.height = Int(rect.height * scale) / 2 * 2
        config.minimumFrameInterval = CMTime(value: 1, timescale: 60)
        config.queueDepth = 5; config.showsCursor = false
        config.capturesAudio = false; config.captureMicrophone = false
        let apps = content.applications.filter { pids.contains($0.processID) }
        // Display-crop measurement avoids the window-sharing titlebar control
        // observed with the app-filtered first attempt. The driver provides an
        // owned opaque backdrop behind the target for the entire crop.
        let filter = SCContentFilter(display: display, excludingWindows: [])
        filter.includeMenuBar = false
        let stream = SCStream(filter: filter, configuration: config, delegate: self)
        let recordingConfig = SCRecordingOutputConfiguration()
        recordingConfig.outputURL = URL(fileURLWithPath: output)
        recordingConfig.outputFileType = .mp4; recordingConfig.videoCodecType = .h264
        let recording = SCRecordingOutput(configuration: recordingConfig, delegate: self)
        try stream.addRecordingOutput(recording)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: DispatchQueue(label: "no-ax.measurement.frames"))
        try await stream.startCapture()
        var startLimit = Date().addingTimeInterval(4)
        while (!state.1 || state.0.isEmpty) && state.3 == nil && startLimit.timeIntervalSinceNow > 0 {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        guard state.1 && !state.0.isEmpty else { try? await stream.stopCapture(); throw RecorderError(message: "recording did not start") }
        try json(["phase": phase, "ok": true, "readyUptime": ProcessInfo.processInfo.systemUptime], to: ready)
        let stopAt = Date().addingTimeInterval(seconds)
        while stopAt.timeIntervalSinceNow > 0 && !FileManager.default.fileExists(atPath: stop) {
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        try await stream.stopCapture()
        startLimit = Date().addingTimeInterval(4)
        while !state.2 && state.3 == nil && startLimit.timeIntervalSinceNow > 0 { try await Task.sleep(nanoseconds: 10_000_000) }
        let result = state
        try json(["completeFramePTS": result.0, "recordingStarted": result.1, "recordingFinished": result.2,
                  "error": result.3 as Any? ?? NSNull(), "requestedFPS": 60, "scale": scale,
                  "sourceRect": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
                  "measurementOnly": true, "targetPIDs": pids.sorted(), "shareableTargetPIDs": apps.map(\.processID).sorted(), "filteredComposition": false, "ownedBackdropDisplayCrop": true, "width": config.width, "height": config.height], to: output + ".json")
        guard result.2 && result.3 == nil && result.0.count > 3 else { throw RecorderError(message: "recording failed") }
    }
}
@main struct Main {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "--preflight" { try? json(["screenCapturePreflight": CGPreflightScreenCaptureAccess()]); return }
        guard args.count == 3, args[1] == "--run" else { try? json(["plan": "Independent ScreenCaptureKit measurement only. --run PLAN_JSON uses a bounded display crop over an owned backdrop/target, no menu/audio/cursor. No AX, event injection or output feedback to detector."]); return }
        let planPath = args[2]
        guard planPath.contains("/test-results/button-visibility-recorded-") else { exit(2) }
        NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.finishLaunching()
        do {
            let plan = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: planPath))) as! [String: Any]
            let r = plan["rect"] as! [Double], output = plan["output"] as! String, ready = plan["ready"] as! String
            let pids = Set((plan["pids"] as! [Int32]).map { pid_t($0) }), seconds = plan["seconds"] as! Double
            guard r.count == 4, seconds > 0, seconds <= 45, !pids.isEmpty, pids.count <= 3,
                  output.contains("/test-results/button-visibility-recorded-"), ready.contains("/test-results/button-visibility-recorded-") else { exit(2) }
            try await Measurement().record(rect: CGRect(x: r[0], y: r[1], width: r[2], height: r[3]), output: output, ready: ready, phase: "validation", seconds: seconds, pids: pids, stop: plan["stop"] as! String)
        }
        catch { try? json(["error": String(describing: error)]); exit(2) }
    }
}
