#if canImport(AppKit) && !canImport(UIKit)
import AppKit
import FieldbookCore

/// The view tree of AppKit windows, for tree.json.
@MainActor
enum ViewTreeCapture {
    static func capture(windows: [NSWindow], redaction: Redaction) -> ViewTree {
        var budget = NodeBudget()
        var trees: [WindowTree<ViewNode>] = []
        for (index, window) in windows.enumerated() {
            guard let top = topView(of: window) else { continue }
            let root = TreeWalk.build(
                top,
                budget: &budget,
                children: { $0.subviews },
                make: { view, children in node(for: view, children: children, window: window, index: index, redaction: redaction) }
            )
            guard let root else { break }
            trees.append(WindowTree(
                index: index,
                number: AppWindows.number(of: window),
                isKey: window.isKeyWindow,
                title: AppWindows.title(of: window, redaction: redaction),
                frame: AppWindows.screenFrame(of: window),
                root: root
            ))
        }
        return ViewTree(limit: budget.limit, nodes: budget.used, truncated: budget.truncated, windows: trees)
    }

    /// The view that holds the whole window, title bar and toolbar included: the content
    /// view's superview (the frame view), or the content view when it has no superview.
    private static func topView(of window: NSWindow) -> NSView? {
        window.contentView?.superview ?? window.contentView
    }

    private static func node(for view: NSView, children: [ViewNode], window: NSWindow, index: Int, redaction: Redaction) -> ViewNode {
        let isPassword = PasswordViews.contains(view)
        return ViewNode(
            type: Describe.typeName(of: view),
            frame: AppWindows.topLeft(view.convert(view.bounds, to: nil), in: window),
            window: index,
            hidden: view.isHidden,
            alpha: Double(view.alphaValue),
            // AppKit has no flag for this, so it is always true (see docs/FORMAT.md).
            interactive: true,
            ax: accessibility(of: view, showsValue: !isPassword, redaction: redaction),
            text: isPassword ? nil : text(of: view).map { redaction.redact($0) },
            scroll: scroll(of: view),
            children: children
        )
    }

    private static func accessibility(of view: NSView, showsValue: Bool, redaction: Redaction) -> AXInfo? {
        let label = Describe.nonEmpty(view.accessibilityLabel()) ?? Describe.nonEmpty(view.accessibilityTitle())
        let value = showsValue ? AccessibilityText.value(view.accessibilityValue()) : nil
        let info = AXInfo(
            id: Describe.nonEmpty(view.accessibilityIdentifier()),
            label: label.map { redaction.redact($0) },
            value: value.map { redaction.redact($0) },
            traits: TraitNames.names(of: view)
        )
        return info.isEmpty ? nil : info
    }

    /// The text the view shows itself. Password views are handled by `PasswordViews`.
    private static func text(of view: NSView) -> String? {
        switch view {
        case let field as NSTextField: field.stringValue
        case let button as NSButton: button.title
        case let textView as NSTextView: textView.string
        default: nil
        }
    }

    private static func scroll(of view: NSView) -> ScrollInfo? {
        guard let scrollView = view as? NSScrollView else { return nil }
        let offset = scrollView.contentView.bounds.origin
        let size = scrollView.documentView?.frame.size ?? .zero
        return ScrollInfo(
            offset: LayoutPoint(x: LayoutRect.points(offset.x), y: LayoutRect.points(offset.y)),
            content: LayoutSize(w: LayoutRect.points(size.width), h: LayoutRect.points(size.height))
        )
    }
}

/// Password fields, for the view tree and the accessibility tree. They give no text and no
/// accessibility value.
@MainActor
enum PasswordViews {
    /// True for a password field, for every view inside one, and for its field editor.
    /// While the tester types, AppKit puts the field editor (an NSTextView that holds the typed
    /// characters) inside the field and makes the field its delegate.
    static func contains(_ view: NSView) -> Bool {
        if let editor = view as? NSTextView, editor.isFieldEditor, editor.delegate is NSSecureTextField {
            return true
        }
        var current: NSView? = view
        while let candidate = current {
            if candidate is NSSecureTextField { return true }
            current = candidate.superview
        }
        return false
    }
}

/// Turns an accessibility value (text, a number, or something else) into text.
enum AccessibilityText {
    static func value(_ value: Any?) -> String? {
        guard let value else { return nil }
        switch value {
        case let text as String: return Describe.nonEmpty(text)
        case let number as NSNumber: return number.stringValue
        default: return nil
        }
    }
}
#endif
