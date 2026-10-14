// Redraw a PNG into an opaque bitmap and write it back out.
// iOS app icons must have no alpha channel; App Store Connect rejects one that
// does, even when every pixel is fully opaque.
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3 else {
    FileHandle.standardError.write(Data("usage: flatten-png <in.png> <out.png>\n".utf8))
    exit(2)
}
let inURL = URL(fileURLWithPath: args[1])
let outURL = URL(fileURLWithPath: args[2])

guard let src = CGImageSourceCreateWithURL(inURL as CFURL, nil),
      let image = CGImageSourceCreateImageAtIndex(src, 0, nil)
else {
    FileHandle.standardError.write(Data("could not read \(inURL.path)\n".utf8))
    exit(1)
}

let width = image.width, height = image.height
guard let ctx = CGContext(
    data: nil, width: width, height: height,
    bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue
) else {
    FileHandle.standardError.write(Data("could not create bitmap context\n".utf8))
    exit(1)
}
// Paint white first so any stray transparency lands on a defined colour
// rather than whatever the encoder happens to leave behind.
ctx.setFillColor(CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1))
ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))

guard let flattened = ctx.makeImage(),
      let dest = CGImageDestinationCreateWithURL(
          outURL as CFURL, UTType.png.identifier as CFString, 1, nil)
else {
    FileHandle.standardError.write(Data("could not write \(outURL.path)\n".utf8))
    exit(1)
}
CGImageDestinationAddImage(dest, flattened, nil)
guard CGImageDestinationFinalize(dest) else {
    FileHandle.standardError.write(Data("could not finalize \(outURL.path)\n".utf8))
    exit(1)
}
