#if canImport(UIKit)
import FieldbookCore
import UIKit

/// What VoiceOver can reach in UIKit windows, for ax.json.
///
/// An object's children are its `accessibilityElements` when it has some (source `uikit.element`,
/// often SwiftUI content), else its subviews (source `uikit.view`). An accessibility element is a
/// leaf: VoiceOver does not look inside it. Plain views in between are skipped, so the tree holds
/// elements, and containers only as structure.
@MainActor
enum AccessibilityTreeCapture {
    /// One object in the walk and the way the walk reached it.
    struct Item {
        let object: NSObject
        let source: AXNode.Source
    }

    /// The search through plain views stops at this depth, in case the view tree is very deep.
    private static let maxSkippedDepth = 100

    static func capture(windows: [UIWindow], redaction: Redaction) -> AXTree {
        var budget = NodeBudget()
        var reached = ReachedObjects()
        var trees: [WindowTree<AXNode>] = []
        for (index, window) in windows.enumerated() {
            let screenSpace = window.windowScene?.screen.coordinateSpace
            _ = reached.isNew(window)
            let root = TreeWalk.build(
                Item(object: window, source: .uikitView),
                budget: &budget,
                // `accessibilityElements` can list any object, even one the walk has
                // already reached, so each object is walked only the first time.
                children: { item in children(of: item).filter { reached.isNew($0.object) } },
                make: { item, children in
                    node(for: item, children: children, window: window, screenSpace: screenSpace, redaction: redaction)
                }
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
        return AXTree(limit: budget.limit, nodes: budget.used, truncated: budget.truncated, windows: trees)
    }

    // MARK: Children

    static func children(of item: Item) -> [Item] {
        let object = item.object
        if object.isAccessibilityElement, !(object is UIWindow) {
            return []
        }
        if let elements = object.accessibilityElements, !elements.isEmpty {
            return elements
                .compactMap { $0 as? NSObject }
                .filter { isReachable($0) }
                .map { Item(object: $0, source: .uikitElement) }
        }
        guard let view = object as? UIView else { return [] }
        return reachableViews(in: view.subviews, depth: 0).map { Item(object: $0, source: .uikitView) }
    }

    /// The nearest views that are elements or containers. A plain view is skipped and its
    /// subviews take its place.
    private static func reachableViews(in views: [UIView], depth: Int) -> [UIView] {
        guard depth < maxSkippedDepth else { return [] }
        return views.flatMap { view -> [UIView] in
            guard isReachable(view) else { return [] }
            if isNode(view) { return [view] }
            return reachableViews(in: view.subviews, depth: depth + 1)
        }
    }

    private static func isNode(_ view: UIView) -> Bool {
        view.isAccessibilityElement
            || !(view.accessibilityElements ?? []).isEmpty
            || view.accessibilityContainerType != UIAccessibilityContainerType.none
    }

    /// False for objects VoiceOver cannot reach: hidden ones and fully transparent views.
    private static func isReachable(_ object: NSObject) -> Bool {
        if object.accessibilityElementsHidden { return false }
        guard let view = object as? UIView else { return true }
        return !view.isHidden && view.alpha > 0.01
    }

    // MARK: Nodes

    private static func node(
        for item: Item,
        children: [AXNode],
        window: UIWindow,
        screenSpace: (any UICoordinateSpace)?,
        redaction: Redaction
    ) -> AXNode {
        let object = item.object
        return AXNode(
            source: item.source,
            type: Describe.typeName(of: object),
            frame: windowFrame(object.accessibilityFrame, window: window, screenSpace: screenSpace),
            id: Describe.nonEmpty(identifier(of: object)),
            label: Describe.nonEmpty(object.accessibilityLabel).map { redaction.redact($0) },
            value: value(of: object, redaction: redaction),
            traits: TraitNames.names(of: object.accessibilityTraits),
            children: children
        )
    }

    /// The element's accessibilityIdentifier. UIKit views declare it through
    /// UIAccessibilityIdentification; SwiftUI's elements answer the getter without declaring
    /// the protocol (measured on iOS 26.5), so any element that responds to it is asked.
    private static func identifier(of object: NSObject) -> String? {
        if let identified = object as? UIAccessibilityIdentification {
            return identified.accessibilityIdentifier
        }
        guard object.responds(to: #selector(getter: UIAccessibilityIdentification.accessibilityIdentifier)) else {
            return nil
        }
        return object.value(forKey: "accessibilityIdentifier") as? String
    }

    /// The accessibility value. A password field gives none: its value is one bullet per
    /// typed character, which would tell the password's length.
    private static func value(of object: NSObject, redaction: Redaction) -> RedactedText? {
        guard !PasswordViews.contains(object) else { return nil }
        return Describe.nonEmpty(object.accessibilityValue).map { redaction.redact($0) }
    }

    /// `accessibilityFrame` is in screen coordinates; the JSON wants window points.
    private static func windowFrame(_ frame: CGRect, window: UIWindow, screenSpace: (any UICoordinateSpace)?) -> LayoutRect {
        guard let screenSpace else { return LayoutRect(frame) }
        return LayoutRect(window.convert(frame, from: screenSpace))
    }
}
#endif
