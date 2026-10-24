import Foundation

/// Version numbers of the Fieldbook formats and of this probe.
public enum FieldbookFormat {
    /// The format version written into every file. See docs/FORMAT.md.
    public static let version = 1
    /// The version of the in-app probe (FieldbookKit).
    public static let probeVersion = "0.1.0"
}

/// The JSON settings every Fieldbook file uses: sorted keys, ISO 8601 dates in UTC with milliseconds.
public enum FieldbookJSON {
    public static func encoder() -> JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        encoder.dateEncodingStrategy = .custom { date, encoder in
            var container = encoder.singleValueContainer()
            try container.encode(FieldbookJSON.string(from: date))
        }
        return encoder
    }

    public static func decoder() -> JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .custom { decoder in
            let container = try decoder.singleValueContainer()
            let text = try container.decode(String.self)
            guard let date = FieldbookJSON.date(from: text) else {
                throw DecodingError.dataCorruptedError(in: container, debugDescription: "Not an ISO 8601 date: \(text)")
            }
            return date
        }
        return decoder
    }

    /// `2026-11-04T10:15:02.123Z`
    public static func string(from date: Date) -> String {
        date.formatted(Date.ISO8601FormatStyle(includingFractionalSeconds: true))
    }

    /// Reads a date with or without milliseconds.
    public static func date(from text: String) -> Date? {
        if let date = try? Date.ISO8601FormatStyle(includingFractionalSeconds: true).parse(text) {
            return date
        }
        return try? Date.ISO8601FormatStyle().parse(text)
    }
}

/// Splits the text of events.jsonl into complete lines.
public enum EventLines {
    /// Every non-empty line that ends with a line break. A last line without one may
    /// still be in the middle of being written, so it is left out.
    public static func completeLines(in text: String) -> [String] {
        var parts = text.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        // After the last "\n" comes either "" (complete) or an unfinished line.
        parts.removeLast()
        return parts.filter { !$0.isEmpty }
    }
}
