import AppKit
let args=CommandLine.arguments
let image=NSImage(size:NSSize(width:1280,height:220))
image.lockFocusFlipped(true)
NSColor(srgbRed:0.05,green:0.085,blue:0.14,alpha:1).setFill(); NSRect(x:0,y:0,width:1280,height:220).fill()
func draw(_ text:String,_ x:Double,_ y:Double,_ size:Double,_ color:NSColor,_ bold:Bool=false) {
 (text as NSString).draw(in:NSRect(x:x,y:y,width:680,height:90),withAttributes:[.font:NSFont.systemFont(ofSize:size,weight:bold ? .semibold : .regular),.foregroundColor:color])
}
draw("MAGNIFIED RECORDED TITLE BAR",20,12,17,.lightGray)
draw(args[2],570,17,27,.white,true)
draw(args[3],570,60,18,NSColor(srgbRed:0.65,green:0.8,blue:0.96,alpha:1))
draw(args[4],570,104,22,.white,true)
draw("Raw recording preserved; annotations stay outside the window.",570,174,15,.lightGray)
image.unlockFocus()
let bitmap=NSBitmapImageRep(data:image.tiffRepresentation!)!
try bitmap.representation(using:.png,properties:[:])!.write(to:URL(fileURLWithPath:args[1]))
