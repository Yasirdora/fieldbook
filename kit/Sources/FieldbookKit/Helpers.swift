#if canImport(UIKit) || canImport(AppKit)
import CoreGraphics
import FieldbookCore

extension LayoutRect {
    /// A rect for the JSON files. The caller makes sure the origin is already top left.
    init(_ rect: CGRect) {
        self.init(
            x: Self.points(rect.origin.x),
            y: Self.points(rect.origin.y),
            w: Self.points(rect.size.width),
            h: Self.points(rect.size.height)
        )
    }

    /// Rounded to 1/100 point: longer fractions only add noise. JSON has no infinity,
    /// and some frames are infinite (for example a null rect), so those become 0.
    /// The check comes after the math: a huge finite value, such as the origin of
    /// `CGRect.infinite`, turns into infinity when multiplied by 100.
    static func points(_ value: CGFloat) -> Double {
        let rounded = (Double(value) * 100).rounded() / 100
        return rounded.isFinite ? rounded : 0
    }
}

/// The objects a tree walk has already reached, so each object is walked once. Without it,
/// two accessibility containers that list each other would make the walk go thousands of
/// levels deep, which can overflow the main thread's stack.
/// The objects stay alive until the walk ends, so no new object can take the address
/// (and the `ObjectIdentifier`) of one that was already reached.
struct ReachedObjects {
    private var objects: [ObjectIdentifier: AnyObject] = [:]

    /// True the first time `object` is passed in, false after that.
    mutating func isNew(_ object: AnyObject) -> Bool {
        let id = ObjectIdentifier(object)
        guard objects[id] == nil else { return false }
        objects[id] = object
        return true
    }
}

/// Small text helpers for the tree walks.
enum Describe {
    /// The type name without generic arguments. SwiftUI types can have names thousands of
    /// characters long; `_UIHostingView<ModifiedContent<…>>` becomes `_UIHostingView`.
    static func typeName(of value: Any) -> String {
        let name = String(describing: type(of: value))
        return String(name.prefix { $0 != "<" })
    }

    /// nil for nil and for empty text.
    static func nonEmpty(_ text: String?) -> String? {
        guard let text, !text.isEmpty else { return nil }
        return text
    }
}
#endif
