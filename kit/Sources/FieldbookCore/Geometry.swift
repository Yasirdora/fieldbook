// These names start with "Layout" because macOS already has C types named Rect, Point and Size
// (MacTypes.h, reached through AppKit). Plain names would be ambiguous in files that import both.

/// A rectangle in points. The origin is top left. In JSON this is a *rect*.
public struct LayoutRect: Codable, Sendable, Equatable {
    public var x: Double
    public var y: Double
    public var w: Double
    public var h: Double

    public init(x: Double, y: Double, w: Double, h: Double) {
        self.x = x
        self.y = y
        self.w = w
        self.h = h
    }
}

/// A point in points.
public struct LayoutPoint: Codable, Sendable, Equatable {
    public var x: Double
    public var y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }
}

/// A size in points.
public struct LayoutSize: Codable, Sendable, Equatable {
    public var w: Double
    public var h: Double

    public init(w: Double, h: Double) {
        self.w = w
        self.h = h
    }
}
