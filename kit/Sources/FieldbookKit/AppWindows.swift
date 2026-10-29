#if canImport(UIKit)
import FieldbookCore
import UIKit

typealias PlatformWindow = UIWindow

/// The app's windows that are on screen.
@MainActor
enum AppWindows {
    /// The visible windows of every scene in the foreground, lowest window level first.
    static func foreground() -> [UIWindow] {
        UIApplication.shared.connectedScenes
            .compactMap { $0 as? UIWindowScene }
            .filter { $0.activationState == .foregroundActive || $0.activationState == .foregroundInactive }
            .flatMap { $0.windows }
            .filter { !$0.isHidden }
            .sorted { $0.windowLevel.rawValue < $1.windowLevel.rawValue }
    }

    static func key(in windows: [UIWindow]) -> UIWindow? {
        windows.first(where: { $0.isKeyWindow }) ?? windows.last
    }

    /// iOS windows have no title in the tree; macOS windows do.
    static func title(of window: UIWindow, redaction: Redaction) -> RedactedText? {
        nil
    }

    /// The window's frame on the screen.
    static func screenFrame(of window: UIWindow) -> LayoutRect {
        LayoutRect(window.frame)
    }

    /// The window number the Mac uses for a capture. iOS has none.
    static func number(of window: UIWindow) -> Int? {
        nil
    }
}

#elseif canImport(AppKit)
import AppKit
import FieldbookCore

typealias PlatformWindow = NSWindow

/// The app's windows that are on screen.
@MainActor
enum AppWindows {
    static func foreground() -> [NSWindow] {
        NSApplication.shared.windows.filter { $0.isVisible }
    }

    static func key(in windows: [NSWindow]) -> NSWindow? {
        windows.first(where: { $0.isKeyWindow }) ?? windows.first(where: { $0.isMainWindow }) ?? windows.first
    }

    static func title(of window: NSWindow, redaction: Redaction) -> RedactedText? {
        window.title.isEmpty ? nil : redaction.redact(window.title)
    }

    /// The window's frame on the screen, with the origin at the top left of the main screen.
    static func screenFrame(of window: NSWindow) -> LayoutRect {
        let frame = window.frame
        let screenHeight = NSScreen.screens.first?.frame.height ?? 0
        return LayoutRect(CGRect(x: frame.minX, y: screenHeight - frame.maxY, width: frame.width, height: frame.height))
    }

    static func number(of window: NSWindow) -> Int? {
        window.windowNumber
    }

    /// A rect in window coordinates (origin bottom left) turned so the origin is top left.
    static func topLeft(_ rect: CGRect, in window: NSWindow) -> LayoutRect {
        LayoutRect(CGRect(x: rect.minX, y: window.frame.height - rect.maxY, width: rect.width, height: rect.height))
    }
}
#endif
