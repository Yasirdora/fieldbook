#if canImport(AppKit) && !canImport(UIKit)
import AppKit
import FieldbookCore

/// What VoiceOver can reach in AppKit windows, for ax.json.
///
/// Children come from `accessibilityChildren()` (source `appkit.children`). An object that is not
/// an accessibility element (AppKit "ignores" it) is skipped, and its own children take its place.
/// Unlike UIKit, an AppKit element can have children (a group, a list, a table).
@MainActor
enum AccessibilityTreeCapture {
    /// The search through ignored objects stops at this depth, in case the tree is very deep.
    private static let maxSkippedDepth = 100

    static func capture(windows: [NSWindow], redaction: Redaction) -> AXTree {
        var budget = NodeBudget()
        var trees: [WindowTree<AXNode>] = []
        for (index, window) in windows.enumerated() {
            let top: any NSAccessibilityProtocol = window
            let root = TreeWalk.build(
                top,
                budget: &budget,
                children: { children(of: $0) },
                make: { element, children in node(for: element, children: children, window: window, redaction: redaction) }
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

    static func children(of element: any NSAccessibilityProtocol) -> [any NSAccessibilityProtocol] {
        reachable(element.accessibilityChildren() ?? [], depth: 0)
    }

    private static func reachable(_ objects: [Any], depth: Int) -> [any NSAccessibilityProtocol] {
        guard depth < maxSkippedDepth else { return [] }
        return objects
            .compactMap { $0 as? any NSAccessibilityProtocol }
            .flatMap { child -> [any NSAccessibilityProtocol] in
                if child.isAccessibilityElement() { return [child] }
                return reachable(child.accessibilityChildren() ?? [], depth: depth + 1)
            }
    }

    // MARK: Nodes

    private static func node(
        for element: any NSAccessibilityProtocol,
        children: [AXNode],
        window: NSWindow,
        redaction: Redaction
    ) -> AXNode {
        let label = Describe.nonEmpty(element.accessibilityLabel()) ?? Describe.nonEmpty(element.accessibilityTitle())
        return AXNode(
            source: .appkitChildren,
            type: Describe.typeName(of: element),
            frame: windowFrame(element.accessibilityFrame(), window: window),
            id: Describe.nonEmpty(element.accessibilityIdentifier()),
            label: label.map { redaction.redact($0) },
            value: AccessibilityText.value(element.accessibilityValue()).map { redaction.redact($0) },
            traits: TraitNames.names(of: element),
            children: children
        )
    }

    /// `accessibilityFrame()` is in screen coordinates with the origin at the bottom left.
    /// The JSON wants window points with the origin at the top left.
    private static func windowFrame(_ frame: NSRect, window: NSWindow) -> LayoutRect {
        AppWindows.topLeft(window.convertFromScreen(frame), in: window)
    }
}
#endif
