/// A piece of on-screen text. By default only its length and a short fingerprint are kept.
public struct RedactedText: Codable, Sendable, Equatable {
    /// Number of Unicode scalars (code points).
    public var length: Int
    /// First 8 hex characters of the SHA-256 of the UTF-8 bytes.
    public var sha256_8: String
    /// The text itself, only when the app was launched with `-FieldbookText full`.
    public var text: String?

    public init(length: Int, sha256_8: String, text: String? = nil) {
        self.length = length
        self.sha256_8 = sha256_8
        self.text = text
    }
}

/// How the kit treats text it finds in views. See "Redacted text" in docs/FORMAT.md.
public struct Redaction: Codable, Sendable, Equatable {
    public enum Mode: String, Codable, Sendable {
        case hashed
        case full
    }

    /// Log messages longer than this are cut.
    public static let logLimit = 500

    public var mode: Mode

    public init(mode: Mode = .hashed) {
        self.mode = mode
    }

    /// Full text only when the arguments contain `-FieldbookText full`, exactly.
    public static func fromArguments(_ arguments: [String]) -> Redaction {
        guard let index = arguments.firstIndex(of: "-FieldbookText"), index + 1 < arguments.count else {
            return Redaction(mode: .hashed)
        }
        return Redaction(mode: arguments[index + 1] == "full" ? .full : .hashed)
    }

    public func redact(_ text: String) -> RedactedText {
        RedactedText(
            length: text.unicodeScalars.count,
            sha256_8: String(SHA256.hex(text).prefix(8)),
            text: mode == .full ? text : nil
        )
    }

    /// The message cut to `logLimit` characters, and whether it was cut.
    public static func cutLog(_ message: String) -> (text: String, cut: Bool) {
        guard message.count > logLimit else { return (message, false) }
        return (String(message.prefix(logLimit)), true)
    }
}
