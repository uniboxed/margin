// Launch-checked macOS Now Playing bridge for hosted Margin apps (Track 2 M2.4).
// Dynamically probes Apple's private MediaRemote.framework via dlopen/dlsym at
// launch. If any symbol is missing on a future macOS release, `available` is
// false and the Mini Player gracefully falls back to Safari tab audio only.

import Foundation
import Darwin

struct NowPlayingSnapshot: Equatable {
    let pid: pid_t
    let title: String
    let artist: String
    let playing: Bool
    let artworkDataURL: String?
}

enum NowPlayingCommand: UInt32 {
    case play = 0
    case pause = 1
    case togglePlayPause = 2
    case nextTrack = 4
    case previousTrack = 5
}

final class NowPlayingBridge {
    private typealias GetInfoFn = @convention(c) (DispatchQueue, @escaping (CFDictionary?) -> Void) -> Void
    private typealias GetPIDFn = @convention(c) (DispatchQueue, @escaping (Int32) -> Void) -> Void
    private typealias GetPlayingFn = @convention(c) (DispatchQueue, @escaping (Bool) -> Void) -> Void
    private typealias SendCmdFn = @convention(c) (UInt32, CFDictionary?) -> Bool

    private let handle: UnsafeMutableRawPointer?
    private let getInfo: GetInfoFn?
    private let getPID: GetPIDFn?
    private let getPlaying: GetPlayingFn?
    private let sendCmd: SendCmdFn?

    let available: Bool

    init() {
        let path = "/System/Library/PrivateFrameworks/MediaRemote.framework/MediaRemote"
        let h = dlopen(path, RTLD_LAZY)
        self.handle = h
        guard let h else {
            self.getInfo = nil
            self.getPID = nil
            self.getPlaying = nil
            self.sendCmd = nil
            self.available = false
            return
        }
        func sym<T>(_ name: String, as type: T.Type) -> T? {
            guard let ptr = dlsym(h, name) else { return nil }
            return unsafeBitCast(ptr, to: type)
        }
        let info = sym("MRMediaRemoteGetNowPlayingInfo", as: GetInfoFn.self)
        let pid = sym("MRMediaRemoteGetNowPlayingApplicationPID", as: GetPIDFn.self)
        let playing = sym("MRMediaRemoteGetNowPlayingApplicationIsPlaying", as: GetPlayingFn.self)
        let send = sym("MRMediaRemoteSendCommand", as: SendCmdFn.self)
        self.getInfo = info
        self.getPID = pid
        self.getPlaying = playing
        self.sendCmd = send
        self.available = (info != nil && pid != nil && playing != nil && send != nil)
    }

    deinit {
        if let handle { dlclose(handle) }
    }

    /// Reads the current Now Playing snapshot ONLY if the active media client PID
    /// belongs to one of Margin's hosted apps (`hostedPIDs`).
    func read(hostedPIDs: Set<pid_t>, completion: @escaping @MainActor (NowPlayingSnapshot?) -> Void) {
        guard available, !hostedPIDs.isEmpty, let getPID, let getPlaying, let getInfo else {
            Task { @MainActor in completion(nil) }
            return
        }
        let q = DispatchQueue.global(qos: .utility)
        getPID(q) { pid in
            guard pid > 0, hostedPIDs.contains(pid) else {
                Task { @MainActor in completion(nil) }
                return
            }
            getPlaying(q) { isPlaying in
                getInfo(q) { rawInfo in
                    let dict = rawInfo as? [String: Any] ?? [:]
                    let title = (dict["kMRMediaRemoteNowPlayingInfoTitle"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    let artist = (dict["kMRMediaRemoteNowPlayingInfoArtist"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                    var artURL: String? = nil
                    if let data = dict["kMRMediaRemoteNowPlayingInfoArtworkData"] as? Data, !data.isEmpty, data.count <= 96 * 1024 {
                        let mime = (dict["kMRMediaRemoteNowPlayingInfoArtworkMIMEType"] as? String) ?? "image/jpeg"
                        if mime == "image/png" || mime == "image/jpeg" {
                            artURL = "data:\(mime);base64,\(data.base64EncodedString())"
                        }
                    }
                    let snap = NowPlayingSnapshot(pid: pid, title: title, artist: artist, playing: isPlaying, artworkDataURL: artURL)
                    Task { @MainActor in completion(snap) }
                }
            }
        }
    }

    @discardableResult
    func send(_ command: NowPlayingCommand) -> Bool {
        guard available, let sendCmd else { return false }
        return sendCmd(command.rawValue, nil)
    }
}
