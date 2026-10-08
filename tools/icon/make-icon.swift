// Draws the app icon (1024x1024 PNG): a dark rounded square with three
// script lines, the current one highlighted, and a red "listening" dot.
import AppKit

let size: CGFloat = 1024
let img = NSImage(size: NSSize(width: size, height: size))
img.lockFocus()
let ctx = NSGraphicsContext.current!.cgContext
// macOS icon grid: 824x824 body centered, corner radius ~185
let body = NSRect(x: 100, y: 100, width: 824, height: 824)
let path = NSBezierPath(roundedRect: body, xRadius: 185, yRadius: 185)
ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -12), blur: 28, color: NSColor.black.withAlphaComponent(0.35).cgColor)
NSColor(calibratedRed: 0.09, green: 0.10, blue: 0.13, alpha: 1).setFill()
path.fill()
ctx.restoreGState()
path.addClip()
let grad = NSGradient(starting: NSColor(calibratedRed: 0.16, green: 0.17, blue: 0.22, alpha: 1),
                      ending: NSColor(calibratedRed: 0.05, green: 0.05, blue: 0.07, alpha: 1))!
grad.draw(in: body, angle: -90)

func bar(_ y: CGFloat, _ w: CGFloat, _ color: NSColor, glow: Bool = false) {
    let r = NSRect(x: 230, y: y, width: w, height: 70)
    let p = NSBezierPath(roundedRect: r, xRadius: 35, yRadius: 35)
    if glow {
        ctx.saveGState()
        ctx.setShadow(offset: .zero, blur: 40, color: color.withAlphaComponent(0.8).cgColor)
        color.setFill()
        p.fill()
        ctx.restoreGState()
    }
    color.setFill()
    p.fill()
}
bar(600, 520, NSColor(calibratedRed: 1.0, green: 0.84, blue: 0.04, alpha: 1), glow: true) // current phrase
bar(470, 400, NSColor(calibratedWhite: 0.92, alpha: 1))
bar(340, 470, NSColor(calibratedWhite: 0.45, alpha: 1))
bar(210, 300, NSColor(calibratedWhite: 0.30, alpha: 1))
// reading-line marker
let tri = NSBezierPath()
tri.move(to: NSPoint(x: 150, y: 600))
tri.line(to: NSPoint(x: 150, y: 670))
tri.line(to: NSPoint(x: 200, y: 635))
tri.close()
NSColor(calibratedRed: 1.0, green: 0.84, blue: 0.04, alpha: 0.9).setFill()
tri.fill()
// listening dot
let dot = NSBezierPath(ovalIn: NSRect(x: 735, y: 735, width: 96, height: 96))
ctx.saveGState()
ctx.setShadow(offset: .zero, blur: 30, color: NSColor.systemRed.withAlphaComponent(0.9).cgColor)
NSColor(calibratedRed: 1.0, green: 0.3, blue: 0.3, alpha: 1).setFill()
dot.fill()
ctx.restoreGState()
img.unlockFocus()

let rep = NSBitmapImageRep(data: img.tiffRepresentation!)!
let png = rep.representation(using: .png, properties: [:])!
try! png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]))
print("icon written")
