#if canImport(UIKit)
import FieldbookCore
import UIKit

/// Tells when the app becomes active, inactive, or goes to the background.
@MainActor
final class LifecycleObserver: NSObject {
    private let onChange: @MainActor (Lifecycle.State) -> Void

    init(onChange: @escaping @MainActor (Lifecycle.State) -> Void) {
        self.onChange = onChange
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didBecomeActive(_:)), name: UIApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(willResignActive(_:)), name: UIApplication.willResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didEnterBackground(_:)), name: UIApplication.didEnterBackgroundNotification, object: nil)
    }

    /// True when the app is active right now. Do not call before the app object exists.
    static var isAppActive: Bool {
        UIApplication.shared.applicationState == .active
    }

    @objc private func didBecomeActive(_ notification: Notification) { onChange(.active) }
    @objc private func willResignActive(_ notification: Notification) { onChange(.inactive) }
    @objc private func didEnterBackground(_ notification: Notification) { onChange(.background) }
}

#elseif canImport(AppKit)
import AppKit
import FieldbookCore

/// Tells when the app becomes active, inactive, or is hidden (the Mac's "background").
@MainActor
final class LifecycleObserver: NSObject {
    private let onChange: @MainActor (Lifecycle.State) -> Void

    init(onChange: @escaping @MainActor (Lifecycle.State) -> Void) {
        self.onChange = onChange
        super.init()
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didBecomeActive(_:)), name: NSApplication.didBecomeActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didResignActive(_:)), name: NSApplication.didResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(didHide(_:)), name: NSApplication.didHideNotification, object: nil)
    }

    /// True when the app is active right now.
    static var isAppActive: Bool {
        NSApplication.shared.isActive
    }

    @objc private func didBecomeActive(_ notification: Notification) { onChange(.active) }
    @objc private func didResignActive(_ notification: Notification) { onChange(.inactive) }
    @objc private func didHide(_ notification: Notification) { onChange(.background) }
}
#endif
