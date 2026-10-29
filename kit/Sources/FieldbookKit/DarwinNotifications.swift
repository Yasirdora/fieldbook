#if canImport(UIKit) || canImport(AppKit)
import CoreFoundation
import Foundation

/// Darwin notifications: system-wide signals with a name and no data. The Mac posts
/// `fieldbook.<bundle id>.inbox` after it puts a command into the inbox; the app posts
/// `fieldbook.<bundle id>.outbox` after it writes an outbox item.
@MainActor
enum DarwinNotifications {
    private static var onInbox: (@MainActor () -> Void)?

    nonisolated static func inboxName(bundleId: String) -> String {
        "fieldbook.\(bundleId).inbox"
    }

    nonisolated static func outboxName(bundleId: String) -> String {
        "fieldbook.\(bundleId).outbox"
    }

    /// Calls `handler` on the main actor each time the inbox notification arrives.
    static func observeInbox(bundleId: String, handler: @escaping @MainActor () -> Void) {
        onInbox = handler
        addObserver(name: inboxName(bundleId: bundleId))
    }

    /// Posts a notification. Safe to call from any thread.
    nonisolated static func post(_ name: String) {
        CFNotificationCenterPostNotification(
            CFNotificationCenterGetDarwinNotifyCenter(),
            CFNotificationName(rawValue: name as CFString),
            nil,
            nil,
            true
        )
    }

    /// A C callback cannot capture anything, so it reaches the handler through a static
    /// property, on the main actor.
    private nonisolated static func addObserver(name: String) {
        CFNotificationCenterAddObserver(
            CFNotificationCenterGetDarwinNotifyCenter(),
            nil,
            { _, _, _, _, _ in
                Task { @MainActor in
                    DarwinNotifications.onInbox?()
                }
            },
            name as CFString,
            nil,
            .deliverImmediately
        )
    }
}
#endif
