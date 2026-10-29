/// A Swift value that can turn itself into a JSON value.
/// The app uses it to report values it only knows at run time, for example `JSONValue(page)`.
public protocol JSONValueConvertible {
    /// This value as JSON.
    var jsonValue: JSONValue { get }
}

extension JSONValue {
    /// Makes a JSON value from a Swift value: a number, text, a truth value, an optional,
    /// an array or a dictionary with text keys. `nil` becomes `null`.
    public init(_ value: some JSONValueConvertible) {
        self = value.jsonValue
    }
}

extension JSONValue: JSONValueConvertible {
    public var jsonValue: JSONValue { self }
}

extension Bool: JSONValueConvertible {
    public var jsonValue: JSONValue { .bool(self) }
}

extension Int: JSONValueConvertible {
    public var jsonValue: JSONValue { .number(Double(self)) }
}

extension Double: JSONValueConvertible {
    public var jsonValue: JSONValue { .number(self) }
}

extension String: JSONValueConvertible {
    public var jsonValue: JSONValue { .string(self) }
}

extension Optional: JSONValueConvertible where Wrapped: JSONValueConvertible {
    public var jsonValue: JSONValue {
        switch self {
        case .some(let value): value.jsonValue
        case .none: .null
        }
    }
}

extension Array: JSONValueConvertible where Element: JSONValueConvertible {
    public var jsonValue: JSONValue { .array(map(\.jsonValue)) }
}

extension Dictionary: JSONValueConvertible where Key == String, Value: JSONValueConvertible {
    public var jsonValue: JSONValue { .object(mapValues(\.jsonValue)) }
}
