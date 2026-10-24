import Foundation

/// snapshot.json: what one snapshot holds and how long it took.
public struct Snapshot: Codable, Sendable, Equatable {
    public enum Reason: String, Codable, Sendable {
        case mark, command
    }

    /// The parts a snapshot can hold.
    public enum Part: String, Codable, Sendable, CaseIterable {
        case tree, ax, state, rendered
    }

    /// How many nodes a tree has, and whether the walk stopped early.
    public struct Count: Codable, Sendable, Equatable {
        public var nodes: Int
        public var truncated: Bool
        public init(nodes: Int, truncated: Bool) {
            self.nodes = nodes
            self.truncated = truncated
        }
    }

    public var formatVersion: Int
    public var id: String
    public var time: Date
    public var reason: Reason
    public var markId: String?
    public var commandId: String?
    public var ms: Int
    public var parts: [Part]
    public var tree: Count?
    public var ax: Count?
    public var problems: [String]

    public init(
        id: String,
        time: Date,
        reason: Reason,
        markId: String? = nil,
        commandId: String? = nil,
        ms: Int,
        parts: [Part],
        tree: Count?,
        ax: Count?,
        problems: [String] = []
    ) {
        self.formatVersion = FieldbookFormat.version
        self.id = id
        self.time = time
        self.reason = reason
        self.markId = markId
        self.commandId = commandId
        self.ms = ms
        self.parts = parts
        self.tree = tree
        self.ax = ax
        self.problems = problems
    }
}

/// tree.json and ax.json: one root node per window, and the node count.
public struct Tree<Node: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var formatVersion: Int
    public var limit: Int
    public var nodes: Int
    public var truncated: Bool
    public var windows: [WindowTree<Node>]

    public init(limit: Int, nodes: Int, truncated: Bool, windows: [WindowTree<Node>]) {
        self.formatVersion = FieldbookFormat.version
        self.limit = limit
        self.nodes = nodes
        self.truncated = truncated
        self.windows = windows
    }
}

/// One window and its tree.
public struct WindowTree<Node: Codable & Sendable & Equatable>: Codable, Sendable, Equatable {
    public var index: Int
    /// The macOS window number (`NSWindow.windowNumber`); nil on iOS.
    public var number: Int?
    public var isKey: Bool
    public var title: RedactedText?
    /// The window's frame on the screen.
    public var frame: Rect
    public var root: Node

    public init(index: Int, number: Int?, isKey: Bool, title: RedactedText?, frame: Rect, root: Node) {
        self.index = index
        self.number = number
        self.isKey = isKey
        self.title = title
        self.frame = frame
        self.root = root
    }
}

public typealias ViewTree = Tree<ViewNode>
public typealias AXTree = Tree<AXNode>

/// One view in tree.json.
public struct ViewNode: Codable, Sendable, Equatable {
    public var type: String
    /// In window points.
    public var frame: Rect
    public var window: Int
    public var hidden: Bool
    public var alpha: Double
    /// Takes touches (iOS) or clicks (macOS: always true).
    public var interactive: Bool
    public var ax: AXInfo?
    public var text: RedactedText?
    public var scroll: ScrollInfo?
    public var children: [ViewNode]

    public init(
        type: String,
        frame: Rect,
        window: Int,
        hidden: Bool,
        alpha: Double,
        interactive: Bool,
        ax: AXInfo?,
        text: RedactedText?,
        scroll: ScrollInfo?,
        children: [ViewNode]
    ) {
        self.type = type
        self.frame = frame
        self.window = window
        self.hidden = hidden
        self.alpha = alpha
        self.interactive = interactive
        self.ax = ax
        self.text = text
        self.scroll = scroll
        self.children = children
    }
}

/// The accessibility facts of a view.
public struct AXInfo: Codable, Sendable, Equatable {
    public var id: String?
    public var label: RedactedText?
    public var value: RedactedText?
    public var traits: [String]

    public init(id: String?, label: RedactedText?, value: RedactedText?, traits: [String]) {
        self.id = id
        self.label = label
        self.value = value
        self.traits = traits
    }

    /// True when there is nothing worth storing.
    public var isEmpty: Bool { id == nil && label == nil && value == nil && traits.isEmpty }
}

/// Where a scroll view is scrolled to, and how big its content is.
public struct ScrollInfo: Codable, Sendable, Equatable {
    public var offset: Point
    public var content: Size
    public init(offset: Point, content: Size) {
        self.offset = offset
        self.content = content
    }
}

/// One element in ax.json: what VoiceOver can reach.
public struct AXNode: Codable, Sendable, Equatable {
    /// Where the node came from.
    public enum Source: String, Codable, Sendable {
        case uikitView = "uikit.view"
        case uikitElement = "uikit.element"
        case appkitChildren = "appkit.children"
    }

    public var source: Source
    public var type: String
    /// In window points.
    public var frame: Rect
    public var id: String?
    public var label: RedactedText?
    public var value: RedactedText?
    public var traits: [String]
    public var children: [AXNode]

    public init(
        source: Source,
        type: String,
        frame: Rect,
        id: String?,
        label: RedactedText?,
        value: RedactedText?,
        traits: [String],
        children: [AXNode]
    ) {
        self.source = source
        self.type = type
        self.frame = frame
        self.id = id
        self.label = label
        self.value = value
        self.traits = traits
        self.children = children
    }
}

/// state.json: the app's own state, as the app reported it.
public struct StateDump: Codable, Sendable, Equatable {
    public var formatVersion: Int
    public var time: Date
    public var providers: [String: JSONValue]
    /// Provider name → what went wrong.
    public var problems: [String: String]

    public init(time: Date, providers: [String: JSONValue], problems: [String: String]) {
        self.formatVersion = FieldbookFormat.version
        self.time = time
        self.providers = providers
        self.problems = problems
    }
}

/// Everything one snapshot folder holds, ready to be written.
public struct SnapshotFiles: Sendable {
    public var info: Snapshot
    public var tree: ViewTree?
    public var ax: AXTree?
    public var state: StateDump?
    public var renderedPNG: Data?

    public init(info: Snapshot, tree: ViewTree? = nil, ax: AXTree? = nil, state: StateDump? = nil, renderedPNG: Data? = nil) {
        self.info = info
        self.tree = tree
        self.ax = ax
        self.state = state
        self.renderedPNG = renderedPNG
    }
}
