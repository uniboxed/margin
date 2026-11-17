// Independent measurement only: no AX, event injection, or target-window changes.
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
    @MainActor func record(rect: CGRect, output: String, ready: String, phase: String, seconds: Double) async throws {
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
        let filter = SCContentFilter(display: display, excludingWindows: [])
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
        try json(["phase": phase, "ok": true], to: ready)
        try await Task.sleep(nanoseconds: UInt64(seconds * 1e9))
        try await stream.stopCapture()
        startLimit = Date().addingTimeInterval(4)
        while !state.2 && state.3 == nil && startLimit.timeIntervalSinceNow > 0 { try await Task.sleep(nanoseconds: 10_000_000) }
        let result = state
        try json(["completeFramePTS": result.0, "recordingStarted": result.1, "recordingFinished": result.2,
                  "error": result.3 as Any? ?? NSNull(), "requestedFPS": 60, "scale": scale,
                  "sourceRect": ["x": rect.minX, "y": rect.minY, "width": rect.width, "height": rect.height],
                  "measurementOnly": true], to: output + ".json")
        guard result.2 && result.3 == nil && result.0.count > 3 else { throw RecorderError(message: "recording failed") }
    }
}
@main struct Main {
    @MainActor static func main() async {
        let args = CommandLine.arguments
        if args.count == 2 && args[1] == "--preflight" { try? json(["screenCapturePreflight": CGPreflightScreenCaptureAccess()]); return }
        guard args.count == 7, args[1] == "--run" else { try? json(["plan": "Independent 60fps-requested display-crop measurement of owned test canvas. Existing Screen Recording access required; no permission request, AX, target mutation, or generic screen recording."]); return }
        let fields = args[2].split(separator: ",").compactMap { Double($0) }
        guard fields.count == 4, fields.allSatisfy(\.isFinite), let seconds = Double(args[6]), seconds > 0, seconds <= 6,
              args[3].contains("/test-results/traffic-lights-no-ax-"), args[4].contains("/test-results/traffic-lights-no-ax-") else { exit(2) }
        NSApplication.shared.setActivationPolicy(.accessory); NSApplication.shared.finishLaunching()
        do { try await Measurement().record(rect: CGRect(x: fields[0], y: fields[1], width: fields[2], height: fields[3]), output: args[3], ready: args[4], phase: args[5], seconds: seconds) }
        catch { try? json(["phase": args[5], "ok": false, "error": String(describing: error)], to: args[4]); try? json(["error": String(describing: error)]); exit(2) }
    }
}
