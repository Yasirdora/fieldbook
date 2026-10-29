#if canImport(UIKit)
import FieldbookCore
import UIKit

/// The view tree of UIKit windows, for tree.json.
@MainActor
enum ViewTreeCapture {
    static func capture(windows: [UIWindow], redaction: Redaction) -> ViewTree {
        var budget = NodeBudget()
        var trees: [WindowTree<ViewNode>] = []
        for (index, window) in windows.enumerated() {
            let root = TreeWalk.build(
                window as UIView,
                budget: &budget,
                children: { $0.subviews },
                make: { view, children in node(for: view, children: children, window: index, redaction: redaction) }
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

    private static func node(for view: UIView, children: [ViewNode], window: Int, redaction: Redaction) -> ViewNode {
        ViewNode(
            type: Describe.typeName(of: view),
            frame: LayoutRect(view.convert(view.bounds, to: nil)),
            window: window,
            hidden: view.isHidden,
            alpha: Double(view.alpha),
            interactive: view.isUserInteractionEnabled,
            ax: accessibility(of: view, redaction: redaction),
            text: text(of: view).map { redaction.redact($0) },
            scroll: scroll(of: view),
            children: children
        )
    }

    private static func accessibility(of view: UIView, redaction: Redaction) -> AXInfo? {
        let info = AXInfo(
            id: Describe.nonEmpty(view.accessibilityIdentifier),
            label: Describe.nonEmpty(view.accessibilityLabel).map { redaction.redact($0) },
            value: Describe.nonEmpty(view.accessibilityValue).map { redaction.redact($0) },
            traits: TraitNames.names(of: view.accessibilityTraits)
        )
        return info.isEmpty ? nil : info
    }

    /// The text the view shows itself. Password fields give none.
    private static func text(of view: UIView) -> String? {
        switch view {
        case let label as UILabel: label.text
        case let field as UITextField: field.isSecureTextEntry ? nil : field.text
        case let textView as UITextView: textView.text
        case let button as UIButton: button.currentTitle ?? button.configuration?.title
        default: nil
        }
    }

    private static func scroll(of view: UIView) -> ScrollInfo? {
        guard let scrollView = view as? UIScrollView else { return nil }
        let offset = scrollView.contentOffset
        let size = scrollView.contentSize
        return ScrollInfo(
            offset: LayoutPoint(x: LayoutRect.points(offset.x), y: LayoutRect.points(offset.y)),
            content: LayoutSize(w: LayoutRect.points(size.width), h: LayoutRect.points(size.height))
        )
    }
}
#endif
