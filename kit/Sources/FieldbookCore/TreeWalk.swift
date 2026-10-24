/// Counts nodes during a tree walk and stops it at a limit.
public struct NodeBudget: Sendable {
    /// The view tree and the accessibility tree each stop at this many nodes.
    public static let defaultLimit = 5000

    public let limit: Int
    public private(set) var used = 0
    /// True when at least one node was left out.
    public private(set) var truncated = false

    public init(limit: Int = NodeBudget.defaultLimit) {
        self.limit = limit
    }

    /// Takes one node from the budget. False when the budget is spent.
    public mutating func take() -> Bool {
        guard used < limit else {
            truncated = true
            return false
        }
        used += 1
        return true
    }
}

/// A depth-first tree walk that any source of nodes can use: UIKit views, AppKit views,
/// accessibility elements, or fakes in tests.
public enum TreeWalk {
    /// Builds the node for `source` and its children, depth first, until the budget is spent.
    /// Returns nil when the budget was already spent before `source`.
    public static func build<Source, Node>(
        _ source: Source,
        budget: inout NodeBudget,
        children: (Source) -> [Source],
        make: (Source, [Node]) -> Node
    ) -> Node? {
        guard budget.take() else { return nil }
        var built: [Node] = []
        for child in children(source) {
            guard let node = build(child, budget: &budget, children: children, make: make) else { break }
            built.append(node)
        }
        return make(source, built)
    }
}
