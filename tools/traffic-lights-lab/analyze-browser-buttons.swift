// Independent offline pixel analysis. No live backend reads this output.
import Foundation
let args = CommandLine.arguments
guard args.count == 4, let width = Int(args[2]), let height = Int(args[3]), width >= 320, height >= 320 else { fatalError("VIDEO WIDTH HEIGHT") }
let process = Process(), pipe = Pipe()
process.executableURL = URL(fileURLWithPath: "/opt/homebrew/bin/ffmpeg")
process.arguments = ["-loglevel", "error", "-i", args[1], "-fps_mode", "passthrough", "-enc_time_base", "1:1000000", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"]
process.standardOutput = pipe
try process.run()
let bytesPerFrame = width * height * 3, roi = 320
var index = 0
while true {
    var data = Data()
    while data.count < bytesPerFrame {
        let chunk = try pipe.fileHandleForReading.read(upToCount: bytesPerFrame - data.count) ?? Data()
        if chunk.isEmpty { break }; data.append(chunk)
    }
    if data.isEmpty { break }
    guard data.count == bytesPerFrame else { fatalError("partial frame") }
    var groups: [[[String: Int]]] = []
    data.withUnsafeBytes { raw in
        let p = raw.bindMemory(to: UInt8.self)
        for color in 0..<2 {
            var mask = [UInt8](repeating: 0, count: roi * roi)
            for y in 0..<roi { for x in 0..<roi {
                let offset = (y * width + x) * 3, r = Int(p[offset]), g = Int(p[offset+1]), b = Int(p[offset+2])
                let selected = color == 0 ? (r > 140 && r * 10 > g * 14 && r * 10 > b * 15) : (g > 110 && g * 10 > r * 14 && g * 10 > b * 12)
                if selected { mask[y * roi + x] = 1 }
            }}
            var components: [[String: Int]] = []
            for start in mask.indices where mask[start] == 1 {
                var queue = [start], cursor = 0, minX = roi, minY = roi, maxX = 0, maxY = 0, sumX = 0, sumY = 0
                mask[start] = 0
                while cursor < queue.count {
                    let current = queue[cursor], x = current % roi, y = current / roi; cursor += 1
                    minX = min(minX,x); minY = min(minY,y); maxX = max(maxX,x); maxY = max(maxY,y); sumX += x; sumY += y
                    for n in [current-1,current+1,current-roi,current+roi] where n >= 0 && n < mask.count && abs(n % roi - x) <= 1 && mask[n] == 1 { mask[n] = 0; queue.append(n) }
                }
                if queue.count >= 35 && queue.count <= 300 && maxX-minX >= 7 && maxX-minX <= 21 && maxY-minY >= 7 && maxY-minY <= 21 {
                    components.append(["pixels": queue.count, "centerX": sumX/queue.count, "centerY": sumY/queue.count, "left": minX, "top": minY, "right": maxX, "bottom": maxY])
                }
            }
            groups.append(components)
        }
    }
    var pairs: [[[String: Int]]] = []
    for red in groups[0] { for green in groups[1] {
        if abs(red["centerY"]!-green["centerY"]!) <= 3 && (40...60).contains(green["centerX"]!-red["centerX"]!) { pairs.append([red,green]) }
    }}
    var middleCounts: [Int] = [], middleDeltas: [Double] = []
    for pair in pairs {
        let x = (pair[0]["centerX"]! + pair[1]["centerX"]!)/2, y = (pair[0]["centerY"]! + pair[1]["centerY"]!)/2
        var count = 0, inside = 0.0, outside = 0.0, ni = 0.0, no = 0.0
        for dy in -10...10 { for dx in -10...10 {
            let distance = dx*dx+dy*dy
            if distance > 100 { continue }
            if x+dx < 0 || x+dx >= width || y+dy < 0 || y+dy >= height { continue }
            let o = ((y+dy)*width+x+dx)*3
            let brightness = Double(max(data[o],data[o+1],data[o+2]))
            if distance <= 16 { inside += brightness; ni += 1; if brightness > 65 { count += 1 } }
            if distance >= 64 { outside += brightness; no += 1 }
        }}
        middleCounts.append(count); middleDeltas.append(ni > 0 && no > 0 ? inside/ni-outside/no : 0)
    }
    let row: [String: Any] = ["frame": index, "redComponents": groups[0], "greenComponents": groups[1], "trafficLightPairs": pairs, "visiblePair": !pairs.isEmpty, "middleContrastSamples": middleCounts, "middleContrastDelta": middleDeltas, "threeDiscEvidence": middleDeltas.contains { abs($0) > 7 }]
    print(String(decoding: try JSONSerialization.data(withJSONObject: row, options: .sortedKeys), as: UTF8.self)); index += 1
}
process.waitUntilExit()
guard process.terminationStatus == 0 else { fatalError("decoder failed") }
