// Research fixture only; never compiled into Margin.app. See README.md for the bounded finding.
// All windows are transparent, off every display and owned by this executable or its own child.
// This does not test Mission Control or native full screen. Return codes are not acknowledgements.
import AppKit
import CoreGraphics
import Darwin

guard CommandLine.arguments.contains("--run") || CommandLine.arguments.contains("--child") else {
    print("Build-only/dry run: --run creates three invisible off-screen test windows in two owned processes, then closes them. No browser or Space is changed.")
    exit(0)
}
var buildSize=0
_ = sysctlbyname("kern.osversion",nil,&buildSize,nil,0)
var buildBytes=[CChar](repeating:0,count:max(buildSize,1))
_ = sysctlbyname("kern.osversion",&buildBytes,&buildSize,nil,0)
guard String(cString:buildBytes) == "26B131" else {
    print("Refused: these private signatures were checked only on macOS build 26B131")
    exit(2)
}
DispatchQueue.global().asyncAfter(deadline:.now()+12) { _exit(3) }
func panel(_ x: CGFloat) -> NSPanel {
    let p = NSPanel(contentRect: NSRect(x: x, y: -20000, width: 800, height: 600), styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
    p.alphaValue = 0
    p.ignoresMouseEvents = true
    guard NSScreen.screens.allSatisfy({ !$0.frame.intersects(p.frame) }) else { p.close(); exit(2) }
    p.isReleasedWhenClosed = false
    p.collectionBehavior = [.managed, .fullScreenAuxiliary, .ignoresCycle]
    p.orderFront(nil)
    guard NSScreen.screens.allSatisfy({ !$0.frame.intersects(p.frame) }) else { p.close(); exit(2) }
    return p
}
NSApplication.shared.setActivationPolicy(.accessory)
if CommandLine.arguments.contains("--child") {
    let p = panel(-20000)
    print("window \(p.windowNumber)"); fflush(stdout)
    DispatchQueue.main.asyncAfter(deadline: .now() + 8) { p.close(); exit(0) }
    NSApplication.shared.run()
    exit(0)
}
guard let handle = dlopen("/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight", RTLD_NOW) else { exit(2) }
func fn<T>(_ name: String, _ type: T.Type) -> T {
    guard let symbol=dlsym(handle,name) else { print("Unavailable: \(name)"); exit(2) }
    return unsafeBitCast(symbol,to:type)
}
typealias Main = @convention(c) () -> UInt32
typealias Pair = @convention(c) (UInt32,UInt32,UInt32) -> Int32
typealias Order = @convention(c) (UInt32,UInt32,UInt32,Int32) -> Int32
typealias Remove = @convention(c) (UInt32,UInt32) -> Int32
typealias Associated = @convention(c) (UInt32,UInt32) -> Unmanaged<CFArray>?
let cid = fn("SLSMainConnectionID",Main.self)()
let associated = fn("SLSCopyAssociatedWindows",Associated.self)
func associations(_ id: UInt32) -> String {
    guard let list = associated(cid,id)?.takeRetainedValue() else { return "unknown" }
    return String(describing:list as NSArray)
}
typealias Group = @convention(c) (UInt32,UInt32,CFString,UnsafeMutablePointer<UnsafeMutablePointer<UInt32>?>,UnsafeMutablePointer<Int32>) -> Int32
let copyGroup = fn("SLSCopyWindowGroup",Group.self)
func group(_ id: UInt32) -> String {
    var ids: UnsafeMutablePointer<UInt32>?, count: Int32 = 0
    let result = copyGroup(cid,id,"movementGroup" as CFString,&ids,&count)
    defer { if let ids { free(ids) } }
    guard result == 0, count >= 0, count < 4096, count == 0 || ids != nil else { return "error \(result), count \(count)" }
    return String(describing: ids.map { Array(UnsafeBufferPointer(start:$0,count:Int(count))) } ?? [])
}
typealias Query = @convention(c) (UInt32,CFArray,Int32) -> Unmanaged<CFTypeRef>?
typealias Iterator = @convention(c) (CFTypeRef) -> Unmanaged<CFTypeRef>?
typealias Advance = @convention(c) (CFTypeRef) -> Bool
typealias GetID = @convention(c) (CFTypeRef) -> UInt32
func parentOf(_ wid: UInt32) -> String {
    let ids = [NSNumber(value:wid)] as CFArray
    guard let q=fn("SLSWindowQueryWindows",Query.self)(cid,ids,1)?.takeRetainedValue(),
          let it=fn("SLSWindowQueryResultCopyWindows",Iterator.self)(q)?.takeRetainedValue(),
          fn("SLSWindowIteratorAdvance",Advance.self)(it),
          fn("SLSWindowIteratorGetWindowID",GetID.self)(it) == wid else { return "unknown" }
    return "\(fn("SLSWindowIteratorGetParentID",GetID.self)(it))"
}
let parent = panel(-20000), local = panel(-18000)
let parentId = UInt32(parent.windowNumber), localId = UInt32(local.windowNumber)
print("own parent \(parentId), own local \(localId), before \(associations(parentId))")
parent.addChildWindow(local, ordered:.above)
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
print("public same-process child \(associations(parentId)), movement \(group(parentId)), parentOfLocal \(parentOf(localId))")
parent.removeChildWindow(local)
RunLoop.main.run(until:Date().addingTimeInterval(0.2))
let child = Process(), out = Pipe()
child.executableURL = URL(fileURLWithPath:CommandLine.arguments[0]); child.arguments=["--child"]; child.standardOutput=out
try child.run()
let line = String(decoding:out.fileHandleForReading.availableData,as:UTF8.self)
guard line.hasPrefix("window "), let other = UInt32(line.trimmingCharacters(in:.whitespacesAndNewlines).dropFirst(7)) else { child.terminate(); exit(2) }
typealias Owner = @convention(c) (UInt32,UInt32,UnsafeMutablePointer<UInt32>) -> Int32
typealias OwnerPID = @convention(c) (UInt32,UnsafeMutablePointer<pid_t>) -> Int32
var owner: UInt32=0, ownerPid: pid_t=0
let gotOwner=fn("SLSGetWindowOwner",Owner.self)(cid,other,&owner)
let gotPid=fn("SLSConnectionGetPID",OwnerPID.self)(owner,&ownerPid)
guard child.isRunning, gotOwner == 0, gotPid == 0, ownerPid == child.processIdentifier else {
    print("Refused: child window ownership was not confirmed (\(gotOwner)/\(gotPid), pid \(ownerPid))")
    child.terminate(); child.waitUntilExit(); parent.close(); local.close(); exit(2)
}
print("own cross-process child \(other), pid \(child.processIdentifier)")
let movement = fn("SLSAddWindowToWindowMovementGroup",Pair.self)
let ordering = fn("SLSAddWindowToWindowOrderingGroup",Order.self)
let removeMove = fn("SLSRemoveWindowFromWindowMovementGroup",Pair.self)
let removeOrder = fn("SLSRemoveFromOrderingGroup",Remove.self)
let lm = movement(cid,parentId,localId), lo = ordering(cid,parentId,localId,1)
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
print("private same process \(lm)/\(lo), movement \(group(parentId)), associated \(associations(parentId))")
_ = removeMove(cid,parentId,localId); _ = removeOrder(cid,localId)
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
let moveResult = movement(cid,parentId,other)
let orderResult = ordering(cid,parentId,other,1)
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
print("cross process add: movement \(moveResult), ordering \(orderResult), associated \(associations(parentId))")
if moveResult == 0 { print("remove movement \(removeMove(cid,parentId,other))") }
if orderResult == 0 { print("remove ordering \(removeOrder(cid,other))") }
let reverseMove = movement(cid,other,parentId), reverseOrder = ordering(cid,other,parentId,1)
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
print("foreign parent own child \(reverseMove)/\(reverseOrder), movement \(group(other)), assoc parent \(associations(other)), assoc child \(associations(parentId)), actual parent \(parentOf(parentId))")
_ = removeMove(cid,other,parentId); _ = removeOrder(cid,parentId)
typealias Create = @convention(c) (UInt32) -> Unmanaged<CFTypeRef>?
typealias TxMove = @convention(c) (CFTypeRef,UInt32,UInt32) -> Void
typealias TxOrder = @convention(c) (CFTypeRef,UInt32,Int32,UInt32) -> Void
typealias Commit = @convention(c) (CFTypeRef,Int32) -> Void
if let transaction = fn("SLSTransactionCreate",Create.self)(cid)?.takeRetainedValue() {
    fn("SLSTransactionAddWindowToWindowOrderingGroup",TxOrder.self)(transaction,parentId,1,other)
    fn("SLSTransactionAddWindowToWindowMovementGroup",TxMove.self)(transaction,other,parentId)
    fn("SLSTransactionCommit",Commit.self)(transaction,1)
    RunLoop.main.run(until:Date().addingTimeInterval(0.1))
    print("transaction foreign parent own child sent, movement \(group(other)), assoc parent \(associations(other)), assoc child \(associations(parentId)), actual parent \(parentOf(parentId))")
}
let setParent = fn("SLSSetWindowParent",Pair.self)
let parentResult = setParent(cid,parentId,other)
RunLoop.main.run(until:Date().addingTimeInterval(0.1))
print("cross process own-child setParent \(parentResult), associated foreign parent \(associations(other)), own child \(associations(parentId)), actual parent \(parentOf(parentId))")
parent.close(); local.close(); child.terminate(); child.waitUntilExit()
print("owned child ended \(child.terminationStatus)")
