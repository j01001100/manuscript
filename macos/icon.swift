// Draws the Manuscript app icon as a 1024px PNG. Used by build.sh.
import Cocoa

let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "icon.png"
let size = 1024
let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size, bitsPerSample: 8, samplesPerPixel: 4,
                           hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)

// The standard macOS icon plate: 824pt rounded square inside a 1024pt canvas.
let plate = NSRect(x: 100, y: 100, width: 824, height: 824)
let shape = NSBezierPath(roundedRect: plate, xRadius: 186, yRadius: 186)
NSGradient(colors: [NSColor(srgbRed: 0.17, green: 0.47, blue: 0.45, alpha: 1), NSColor(srgbRed: 0.08, green: 0.27, blue: 0.26, alpha: 1)])!
    .draw(in: shape, angle: -90)

// A sheet of paper, slightly raised.
let page = NSRect(x: 292, y: 232, width: 440, height: 560)
let shadow = NSShadow()
shadow.shadowColor = NSColor.black.withAlphaComponent(0.28)
shadow.shadowBlurRadius = 30
shadow.shadowOffset = NSSize(width: 0, height: -12)
NSGraphicsContext.saveGraphicsState()
shadow.set()
NSColor(srgbRed: 0.992, green: 0.988, blue: 0.976, alpha: 1).setFill()
NSBezierPath(roundedRect: page, xRadius: 22, yRadius: 22).fill()
NSGraphicsContext.restoreGraphicsState()

// A serif M as the first letter on the page, then lines of text.
let font = NSFont(name: "IowanOldStyle-Bold", size: 250) ?? NSFont(name: "Georgia-Bold", size: 250) ?? NSFont.boldSystemFont(ofSize: 250)
let ink = NSColor(srgbRed: 0.09, green: 0.29, blue: 0.28, alpha: 1)
let letter = NSAttributedString(string: "M", attributes: [.font: font, .foregroundColor: ink])
let bounds = letter.size()
letter.draw(at: NSPoint(x: page.midX - bounds.width / 2, y: page.maxY - 60 - bounds.height + 30))

NSColor(srgbRed: 0.09, green: 0.29, blue: 0.28, alpha: 0.22).setFill()
for (i, width) in [320.0, 320.0, 320.0, 190.0].enumerated() {
    let y = 452.0 - Double(i) * 52.0
    NSBezierPath(roundedRect: NSRect(x: 352, y: y, width: width, height: 16), xRadius: 8, yRadius: 8).fill()
}

NSGraphicsContext.restoreGraphicsState()
try! rep.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: out))
