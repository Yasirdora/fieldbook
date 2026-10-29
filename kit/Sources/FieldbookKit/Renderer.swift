#if canImport(UIKit)
import UIKit

/// Draws a window into a PNG image. The image is labelled "rendered": the app drew it itself,
/// so it can differ from what the screen showed (for example under Liquid Glass).
@MainActor
enum Renderer {
    /// At most 2 pixels per point. The image stays sharp enough to read, and a 3x screen
    /// would take more than twice as long to encode.
    private static let maxScale: CGFloat = 2

    static func png(of window: UIWindow) -> Data? {
        let format = UIGraphicsImageRendererFormat(for: window.traitCollection)
        format.scale = min(format.scale, maxScale)
        // 8 bits per color in sRGB. Wide color would give 16-bit PNGs that the Mac's
        // pixel-diff script does not read.
        format.preferredRange = .standard
        let bounds = window.bounds
        let renderer = UIGraphicsImageRenderer(bounds: bounds, format: format)
        var drawn = false
        let data = renderer.pngData { _ in
            drawn = window.drawHierarchy(in: bounds, afterScreenUpdates: false)
        }
        return drawn ? data : nil
    }
}

#elseif canImport(AppKit)
import AppKit

/// Draws a window's content view into a PNG image. The image is labelled "rendered": the app
/// drew it itself, so it can differ from what the screen showed. The title bar is not part of it.
@MainActor
enum Renderer {
    static func png(of window: NSWindow) -> Data? {
        guard let view = window.contentView else { return nil }
        let bounds = view.bounds
        guard let bitmap = view.bitmapImageRepForCachingDisplay(in: bounds) else { return nil }
        view.cacheDisplay(in: bounds, to: bitmap)
        return bitmap.representation(using: .png, properties: [:])
    }
}
#endif
