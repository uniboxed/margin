// Owned off-screen control only. No browser/window mutation outside this executable.
import AppKit
import CoreGraphics
import Darwin
if !CommandLine.arguments.contains("--run") { print("Dry run: --run creates one transparent off-screen panel, changes only its own transform, restores it and closes it."); exit(0) }
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
DispatchQueue.global().asyncAfter(deadline: .now() + 8) { _exit(3) }
let p = NSPanel(contentRect: NSRect(x: -20000, y: -20000, width: 800, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
p.alphaValue = 0.01; p.ignoresMouseEvents = true; p.backgroundColor = .clear
p.orderFront(nil)
let id = CGWindowID(p.windowNumber)
let sky = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW)!
func fn<T>(_ name: String, _ type: T.Type) -> T { guard let f = dlsym(sky,name) else { fatalError("missing \(name)") }; return unsafeBitCast(f,to:type) }
typealias CID = @convention(c) () -> UInt32
typealias Bounds = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<CGRect>) -> Int32
typealias Get = @convention(c) (UInt32, UInt32, UnsafeMutablePointer<CGAffineTransform>) -> Int32
typealias Set = @convention(c) (UInt32, UInt32, CGAffineTransform) -> Int32
let cid = fn("SLSMainConnectionID", CID.self)()
let bounds = fn("SLSGetWindowBounds", Bounds.self), get = fn("SLSGetWindowTransform", Get.self), set = fn("SLSSetWindowTransform", Set.self)
func info() -> [String:Any]? {
    (CGWindowListCopyWindowInfo([.optionAll],0) as? [[String:Any]])?.first { ($0[kCGWindowNumber as String] as? NSNumber)?.uint32Value == id }
}
func read(_ stage:String) {
    var b = CGRect.zero, t = CGAffineTransform.identity
    let br = bounds(cid,id,&b), tr = get(cid,id,&t)
    let i = info() ?? [:]
    print("\(stage): boundsResult=\(br) bounds=\(b) transformResult=\(tr) transform=\(t) cg=\(i[kCGWindowBounds as String] ?? "unknown")")
}
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
guard let i=info(), (i[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == getpid(), let raw=i[kCGWindowBounds as String], let r=CGRect(dictionaryRepresentation:raw as! CFDictionary), !NSScreen.screens.contains(where: { screen in
    let h=NSScreen.screens[0].frame.height
    let cg=CGRect(x:screen.frame.minX,y:h-screen.frame.maxY,width:screen.frame.width,height:screen.frame.height)
    return cg.intersects(r)
}) else { p.close(); exit(2) }
var original = CGAffineTransform.identity
let got=get(cid,id,&original)
guard got==0 else { p.close(); exit(2) }
read("before")
var scaled=CGAffineTransform(scaleX:2,y:2)
scaled.tx = -r.minX*2; scaled.ty = -r.minY*2
print("owned-set: \(set(cid,id,scaled))")
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
read("scaled")
print("restore: \(set(cid,id,original))")
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
read("restored")
p.close()
print("closed own panel")
