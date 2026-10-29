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
    static func points(_ value: CGFloat) -> Double {
        let number = Double(value)
        return number.isFinite ? (number * 100).rounded() / 100 : 0
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
