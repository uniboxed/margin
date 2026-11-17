// A theme with macOS's real materials (Liquid Glass), seen with nothing on screen: tools/glass-shots/run.sh.
//
// One page in a WKWebView, in a borderless window far outside every display, in an accessory app (no Dock icon,
// never active). WebKit's system appearance is turned on for the view as Margin.app does it for a theme that asks
// (app/platforms/macos/shell/OverlayWebView.swift OverlaySystemAppearance), so `-apple-visual-effect` is known and
// the page gets real material layers. What comes out:
//   --capture x.png  the window server's own picture of the window (CGWindowListCreateImage of this process's own
//                    window: no Screen Recording needed, and the only picture with the glass in it; WKWebView's
//                    takeSnapshot draws the page without its materials)
//   --layers         the material layers in the view's layer tree, with their frames and corner radii: each should be
//                    its element's box (a glass layer grows with an outer shadow, an outline or a child past the box)
//   --js 'expr'      run in the page first; its value printed
// One page per process: a second web view in one process didn't get its layers (2026-11-17).
//   shot <file.html> [--size WxH] [--system on|off] [--light|--dark] [--wait seconds] [--best] [--layers] [--js expr] [--capture x.png]
import AppKit
import WebKit

let args = Array(CommandLine.arguments.dropFirst())
func opt(_ name: String) -> String? { if let i = args.firstIndex(of: name), i + 1 < args.count { return args[i + 1] }; return nil }
func flag(_ name: String) -> Bool { args.contains(name) }
guard let first = args.first, !first.hasPrefix("--") else { print("shot <file.html> [options]"); exit(64) }
let file = URL(fileURLWithPath: first)
let size = (opt("--size") ?? "1512x982").split(separator: "x").compactMap { Double($0) }.map { CGFloat($0) }
guard size.count == 2 else { print("--size WxH"); exit(64) }
setvbuf(stdout, nil, _IONBF, 0)

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
if flag("--dark") { app.appearance = NSAppearance(named: .darkAqua) } else if flag("--light") { app.appearance = NSAppearance(named: .aqua) }

typealias SetBool = @convention(c) (AnyObject, Selector, Bool) -> Void
func set(_ target: AnyObject, _ selector: String, _ value: Bool) -> Bool {
  let sel = NSSelectorFromString(selector)
  guard target.responds(to: sel), let imp = class_getMethodImplementation(type(of: target), sel) else { return false }
  unsafeBitCast(imp, to: SetBool.self)(target, sel, value)
  return true
}

let configuration = WKWebViewConfiguration()
configuration.websiteDataStore = .nonPersistent()
let window = NSWindow(contentRect: NSRect(x: -30000, y: -30000, width: size[0], height: size[1]), styleMask: .borderless, backing: .buffered, defer: false)
window.isOpaque = false
window.backgroundColor = .clear
let view = WKWebView(frame: NSRect(x: 0, y: 0, width: size[0], height: size[1]), configuration: configuration)
view.setValue(false, forKey: "drawsBackground")
if (opt("--system") ?? "on") == "on", !set(view, "_setUseSystemAppearance:", true) { print("this WebKit has no system appearance switch: the plain look") }
// Off every display WebKit takes the page for hidden and stops drawing after its first frame: not this view.
_ = set(view, "_setWindowOcclusionDetectionEnabled:", false)
window.contentView = view
window.orderFrontRegardless()
view.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())

func materials(_ layer: CALayer, _ out: inout [String]) {
  let type = String(describing: Swift.type(of: layer))
  if type.contains("MaterialHosting") || type.contains("MTMaterialLayer") {
    let box = layer.convert(layer.bounds, to: nil)
    // (The view's layer is flipped against the page: y from the page's top.)
    let top = size[1] - box.maxY
    let name = (layer.name ?? "").replacingOccurrences(of: #"0x[0-9a-f]+ "#, with: "", options: .regularExpression)
    out.append("  \(Int(box.minX.rounded())),\(Int(top.rounded())) \(Int(box.width.rounded()))×\(Int(box.height.rounded())) \(type.contains("MT") ? "blur material" : "glass")\(layer.opacity != 1 ? " opacity \(layer.opacity)" : "") \(name)")
  }
  for sub in layer.sublayers ?? [] { materials(sub, &out) }
}

func capture(_ path: String) {
  typealias Create = @convention(c) (CGRect, UInt32, UInt32, UInt32) -> Unmanaged<CGImage>?
  guard let symbol = dlsym(UnsafeMutableRawPointer(bitPattern: -2), "CGWindowListCreateImage") else { print("no CGWindowListCreateImage on this macOS"); return }
  // This window alone (8), its bounds without a shadow (1), at the display's scale (8) or at 1× (16).
  guard let image = unsafeBitCast(symbol, to: Create.self)(.null, 8, UInt32(window.windowNumber), 1 | (flag("--best") ? 8 : 16))?.takeRetainedValue(),
        let data = NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:]) else { print("no picture of the window"); return }
  do { try data.write(to: URL(fileURLWithPath: path)); print("picture \(image.width)×\(image.height): \(path)") } catch { print("couldn't write \(path): \(error)") }
}

func finish() {
  if flag("--layers") {
    var lines: [String] = []
    if let layer = view.layer { materials(layer, &lines) }
    print("material layers: \(lines.count)")
    for line in lines { print(line) }
  }
  if let path = opt("--capture") { capture(path) }
  exit(0)
}

DispatchQueue.main.asyncAfter(deadline: .now() + (Double(opt("--wait") ?? "3") ?? 3)) {
  guard let js = opt("--js") else { return finish() }
  view.evaluateJavaScript(js) { value, error in
    print("js: \(value.map { "\($0)" } ?? "nil")\(error.map { " (\($0.localizedDescription))" } ?? "")")
    DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { finish() }
  }
}
DispatchQueue.main.asyncAfter(deadline: .now() + 40) { print("timed out"); exit(2) }
app.run()
