// Independent offline measurement only. Locate the known fixture's teal content, then inspect
// every native button disc at its independently reported local coordinates.
import Foundation
import Darwin
let args = CommandLine.arguments
guard (args.count == 6 || args.count == 7), let width = Int(args[2]), let height = Int(args[3]), let scale = Double(args[4]),
      width > 0, height > 0, scale > 0 else { fatalError("VIDEO WIDTH HEIGHT SCALE TRUTH_JSON") }
let radiusPoints = args.count == 7 ? Double(args[6])! : 6.0
guard radiusPoints >= 6 && radiusPoints <= 8 else { fatalError("invalid measurement radius") }
let truths = try String(contentsOfFile: args[5], encoding: .utf8).split(separator: "\n").map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
let truth = truths.first { $0["stage"] as? String == "native-truth" }!
let rect = truth["serverBounds"] as! [NSNumber]
let frame: [String: NSNumber] = ["height": rect[3]]
let titlebarHeight = rect[3].doubleValue - (truth["contentHeight"] as! NSNumber).doubleValue
let buttons = (truth["buttons"] as! [[String: Any]]).map { row -> (Double, Double) in
    let r = Dictionary(uniqueKeysWithValues: zip(["x", "y", "width", "height"], row["localFrame"] as! [NSNumber]))
    return (r["x"]!.doubleValue + r["width"]!.doubleValue / 2,
            frame["height"]!.doubleValue - r["y"]!.doubleValue - r["height"]!.doubleValue / 2)
}
let process = Process(), pipe = Pipe()
process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
process.arguments = ["-loglevel", "error", "-i", args[1], "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
process.standardOutput = pipe
try process.run()
let count = width * height * 3
var index = 0
while true {
    var data = Data()
    while data.count < count {
        let chunk = try pipe.fileHandleForReading.read(upToCount: count - data.count) ?? Data()
        if chunk.isEmpty { break }; data.append(chunk)
    }
    if data.isEmpty { break }
    guard data.count == count else { fatalError("partial raw frame") }
    var rowCounts = [Int](repeating: 0, count: height), colCounts = [Int](repeating: 0, count: width)
    let result: [String: Any] = data.withUnsafeBytes { raw in
        let p = raw.bindMemory(to: UInt8.self)
        for y in 0..<height {
            for x in 0..<width {
                let o = (y * width + x) * 3, r = Int(p[o]), g = Int(p[o+1]), b = Int(p[o+2])
                if g > 110 && b > 110 && r + 45 < g && r + 45 < b { rowCounts[y] += 1; colCounts[x] += 1 }
            }
        }
        let maxRow = rowCounts.max()!, maxCol = colCounts.max()!
        guard maxRow > 100, maxCol > 100,
              let left = colCounts.firstIndex(where: { $0 * 100 > maxCol * 65 }),
              let bodyTop = rowCounts.firstIndex(where: { $0 * 100 > maxRow * 65 }) else {
            return ["frame": index, "validFixture": false]
        }
        let top = Double(bodyTop) - titlebarHeight * scale // independent owner geometry, never detector geometry
        var bright: [Int] = [], colored: [Int] = [], contrast: [Int] = []
        for (x, y) in buttons {
            let centerX = Double(left) + x * scale, centerY = top + y * scale
            let radius = radiusPoints * scale
            var uncovered = 0, colorCount = 0, contrastCount = 0
            for sy in Int(floor(centerY-radius))...Int(ceil(centerY+radius)) {
                for sx in Int(floor(centerX-radius))...Int(ceil(centerX+radius)) {
                    guard sx >= 0, sx < width, sy >= 0, sy < height,
                          pow(Double(sx)-centerX, 2) + pow(Double(sy)-centerY, 2) < radius*radius else { continue }
                    let o = (sy * width + sx) * 3
                    let hi = max(p[o], p[o+1], p[o+2]), lo = min(p[o], p[o+1], p[o+2])
                    if hi > 120 { uncovered += 1 }
                    if hi > 100 && Int(hi) - Int(lo) > 45 { colorCount += 1 }
                    if hi > 65 { contrastCount += 1 }
                }
            }
            bright.append(uncovered); colored.append(colorCount); contrast.append(contrastCount)
        }
        return ["frame": index, "validFixture": true, "sampleRadiusPoints": radiusPoints, "estimatedWindowLeft": left,
                "estimatedWindowTop": top, "brightSamples": bright, "coloredSamples": colored, "contrastSamples": contrast,
                "allDiscsCovered": bright.allSatisfy { $0 == 0 }]
    }
    print(String(decoding: try JSONSerialization.data(withJSONObject: result, options: .sortedKeys), as: UTF8.self))
    index += 1
}
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("ffmpeg failed") }
