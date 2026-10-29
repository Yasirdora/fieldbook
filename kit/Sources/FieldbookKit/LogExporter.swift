#if canImport(UIKit) || canImport(AppKit)
import FieldbookCore
import Foundation
import OSLog

/// Reads new log entries of this process from the unified log. It is an actor, so the slow
/// log store work never runs on the main thread.
actor LogExporter {
    /// What one read found.
    struct Batch: Sendable {
        var lines: [LogLine] = []
        /// Set once, when the log store could not be read. After that the exporter stops trying.
        var problem: Problem?
    }

    /// At most this many entries per read. The rest follow on the next read.
    private static let maxEntriesPerRead = 500

    private var store: OSLogStore?
    private var gaveUp = false
    /// The time of the newest entry already exported.
    private var after: Date

    init(after: Date) {
        self.after = after
    }

    func read() -> Batch {
        guard !gaveUp else { return Batch() }
        do {
            return try Batch(lines: newLines(from: openStore()))
        } catch {
            gaveUp = true
            let message = "Could not read the log store, so no more logs are exported: \(error.localizedDescription)"
            return Batch(problem: Problem(location: "logs", message: message))
        }
    }

    private func openStore() throws -> OSLogStore {
        if let store { return store }
        let opened = try OSLogStore(scope: .currentProcessIdentifier)
        store = opened
        return opened
    }

    private func newLines(from store: OSLogStore) throws -> [LogLine] {
        let entries = try store.getEntries(at: store.position(date: after))
        var lines: [LogLine] = []
        for case let entry as OSLogEntryLog in entries where entry.date > after {
            lines.append(Self.line(for: entry))
            if lines.count == Self.maxEntriesPerRead { break }
        }
        if let newest = lines.last {
            after = newest.logTime
        }
        return lines
    }

    private static func line(for entry: OSLogEntryLog) -> LogLine {
        let message = Redaction.cutLog(entry.composedMessage)
        return LogLine(
            level: levelName(entry.level),
            subsystem: entry.subsystem,
            category: entry.category,
            message: message.text,
            cut: message.cut,
            logTime: entry.date
        )
    }

    private static func levelName(_ level: OSLogEntryLog.Level) -> String {
        switch level {
        case .undefined: "undefined"
        case .debug: "debug"
        case .info: "info"
        case .notice: "notice"
        case .error: "error"
        case .fault: "fault"
        @unknown default: "undefined"
        }
    }
}
#endif
