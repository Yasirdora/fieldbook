import Foundation
#if canImport(Darwin)
import Darwin
#elseif canImport(Glibc)
import Glibc
#elseif canImport(Musl)
import Musl
#endif

/// Where the mailbox folder is. See the table in docs/FORMAT.md.
public enum MailboxLocation {
    /// `applicationSupport` is the app's Application Support folder (inside its container when sandboxed).
    public static func root(applicationSupport: URL, sandboxed: Bool, bundleId: String) -> URL {
        let base = applicationSupport.appendingPathComponent("Fieldbook", isDirectory: true)
        guard !sandboxed else { return base }
        return base
            .appendingPathComponent("mailbox", isDirectory: true)
            .appendingPathComponent(bundleId, isDirectory: true)
    }
}

/// Errors from mailbox writes.
public enum MailboxError: Error, Equatable {
    case unsafeName(String)
    case renameFailed(String)
}

/// The folder the app shares with the Mac, and every read and write in it.
/// All file work happens on this actor, never on the main thread.
public actor Mailbox {
    public static let defaultRotateBytes = 5 * 1024 * 1024
    public static let defaultMaxOutboxItems = 50
    static let rememberedCommands = 100

    public nonisolated let root: URL
    public nonisolated let runId: String
    private let rotateBytes: Int
    private let maxOutboxItems: Int
    private let onOutbox: (@Sendable () -> Void)?
    private let encoder = FieldbookJSON.encoder()
    private let decoder = FieldbookJSON.decoder()
    private var state: KitState
    private var eventsBytes: Int
    private var eventSeq = 0
    private var snapshotCounter = 0
    private var markCounter = 0

    /// Creates the folders if needed and loads the kit's counters.
    /// `onOutbox` runs after each outbox write (the kit posts a Darwin notification there).
    public init(
        root: URL,
        runId: String = UUID().uuidString,
        rotateBytes: Int = Mailbox.defaultRotateBytes,
        maxOutboxItems: Int = Mailbox.defaultMaxOutboxItems,
        onOutbox: (@Sendable () -> Void)? = nil
    ) throws {
        let fileManager = FileManager.default
        for name in ["inbox", "outbox", "snapshots", "metrickit"] {
            try fileManager.createDirectory(
                at: root.appendingPathComponent(name, isDirectory: true),
                withIntermediateDirectories: true
            )
        }
        self.root = root
        self.runId = runId
        self.rotateBytes = rotateBytes
        self.maxOutboxItems = maxOutboxItems
        self.onOutbox = onOutbox
        self.state = KitState.load(root: root)
        let eventsPath = root.appendingPathComponent("events.jsonl").path
        let size = (try? fileManager.attributesOfItem(atPath: eventsPath)[.size] as? NSNumber)?.intValue
        self.eventsBytes = size ?? 0
    }

    // MARK: Hello and events

    public func writeHello(_ hello: Hello) throws {
        try Self.writeAtomically(encoder.encode(hello), to: root.appendingPathComponent("hello.json"))
    }

    /// Appends one event to events.jsonl. Never throws: a failed write is dropped.
    @discardableResult
    public func record(_ payload: Event.Payload, at time: Date = Date()) -> Event {
        eventSeq += 1
        let event = Event(runId: runId, seq: eventSeq, time: time, payload: payload)
        if var line = try? encoder.encode(event) {
            line.append(0x0a)
            try? appendEventLine(line)
        }
        return event
    }

    private func appendEventLine(_ line: Data) throws {
        let events = root.appendingPathComponent("events.jsonl")
        if eventsBytes > 0, eventsBytes + line.count > rotateBytes {
            try rotateEvents(events)
        }
        let fileManager = FileManager.default
        if !fileManager.fileExists(atPath: events.path) {
            _ = fileManager.createFile(atPath: events.path, contents: nil)
        }
        let handle = try FileHandle(forWritingTo: events)
        defer { try? handle.close() }
        _ = try handle.seekToEnd()
        try handle.write(contentsOf: line)
        eventsBytes += line.count
    }

    private func rotateEvents(_ events: URL) throws {
        let older = root.appendingPathComponent("events.1.jsonl")
        let fileManager = FileManager.default
        if fileManager.fileExists(atPath: older.path) {
            try fileManager.removeItem(at: older)
        }
        try fileManager.moveItem(at: events, to: older)
        eventsBytes = 0
    }

    // MARK: Ids

    private var runPrefix: String { String(runId.lowercased().prefix(8)) }

    /// `5c1e0a2b-0004`: the run's first 8 characters and a counter.
    public func nextSnapshotId() -> String {
        snapshotCounter += 1
        return "\(runPrefix)-\(Self.padded(snapshotCounter, width: 4))"
    }

    /// The next mark number in this run, and its id (`5c1e0a2b-m3`).
    public func nextMark() -> (id: String, number: Int) {
        markCounter += 1
        return ("\(runPrefix)-m\(markCounter)", markCounter)
    }

    // MARK: Snapshots and MetricKit

    /// Writes the snapshot into a hidden folder, then renames it, so the Mac never sees half a snapshot.
    public func storeSnapshot(_ files: SnapshotFiles) throws {
        let id = files.info.id
        guard Self.isSafeName(id) else { throw MailboxError.unsafeName(id) }
        let snapshots = root.appendingPathComponent("snapshots", isDirectory: true)
        let staging = snapshots.appendingPathComponent(".tmp-\(id)", isDirectory: true)
        let fileManager = FileManager.default
        try? fileManager.removeItem(at: staging)
        try fileManager.createDirectory(at: staging, withIntermediateDirectories: true)
        try encoder.encode(files.info).write(to: staging.appendingPathComponent("snapshot.json"))
        if let tree = files.tree {
            try encoder.encode(tree).write(to: staging.appendingPathComponent("tree.json"))
        }
        if let ax = files.ax {
            try encoder.encode(ax).write(to: staging.appendingPathComponent("ax.json"))
        }
        if let state = files.state {
            try encoder.encode(state).write(to: staging.appendingPathComponent("state.json"))
        }
        if let png = files.renderedPNG {
            try png.write(to: staging.appendingPathComponent("screen-rendered.png"))
        }
        let destination = snapshots.appendingPathComponent(id, isDirectory: true)
        try? fileManager.removeItem(at: destination)
        try Self.moveReplacing(staging, to: destination)
    }

    /// Stores one MetricKit payload. Returns its path relative to the mailbox.
    public func storeMetricKit(_ data: Data, type: String, at time: Date = Date()) throws -> String {
        let millis = Int64(time.timeIntervalSince1970 * 1000)
        let relative = "metrickit/\(millis)-\(type).json"
        try Self.writeAtomically(data, to: root.appendingPathComponent(relative))
        return relative
    }

    // MARK: Outbox

    /// Writes one outbox item with the next sequence number.
    @discardableResult
    public func addOutbox(
        kind: OutboxItem.Kind,
        ok: Bool,
        message: String? = nil,
        command: Command? = nil,
        via: CommandEvent.Via? = nil,
        snapshotId: String? = nil,
        markId: String? = nil,
        file: String? = nil,
        at time: Date = Date()
    ) throws -> OutboxItem {
        let seq = state.nextOutboxSeq
        state.nextOutboxSeq += 1
        try saveState()
        let item = OutboxItem(
            seq: seq, runId: runId, time: time, kind: kind,
            commandId: command?.id, commandName: command?.name.rawValue, via: via,
            ok: ok, message: message, snapshotId: snapshotId, markId: markId, file: file
        )
        let name = "\(Self.padded(seq, width: 6))-\(kind.rawValue).json"
        try Self.writeAtomically(encoder.encode(item), to: root.appendingPathComponent("outbox/\(name)"))
        dropOldestOutboxItems()
        onOutbox?()
        return item
    }

    /// Deletes every outbox item up to `seq`, with the snapshot and MetricKit files it names.
    public func prune(upTo seq: Int) {
        for entry in outboxEntries() where entry.seq <= seq {
            remove(entry.url)
        }
    }

    private func dropOldestOutboxItems() {
        let entries = outboxEntries()
        guard entries.count > maxOutboxItems else { return }
        let dropped = entries.prefix(entries.count - maxOutboxItems)
        for entry in dropped {
            remove(entry.url)
        }
        record(.problem(Problem(
            location: "outbox",
            message: "The outbox was full, so the \(dropped.count) oldest items were deleted before the Mac copied them."
        )))
    }

    private func outboxEntries() -> [(seq: Int, url: URL)] {
        let outbox = root.appendingPathComponent("outbox", isDirectory: true)
        let names = (try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? []
        return names
            .filter { !$0.hasPrefix(".") && $0.hasSuffix(".json") }
            .compactMap { name -> (seq: Int, url: URL)? in
                guard let seq = Int(name.prefix { $0 != "-" }) else { return nil }
                return (seq, outbox.appendingPathComponent(name))
            }
            .sorted { $0.seq < $1.seq }
    }

    private func remove(_ outboxFile: URL) {
        let fileManager = FileManager.default
        if let data = try? Data(contentsOf: outboxFile), let item = try? decoder.decode(OutboxItem.self, from: data) {
            if let id = item.snapshotId, Self.isSafeName(id) {
                try? fileManager.removeItem(at: root.appendingPathComponent("snapshots/\(id)", isDirectory: true))
            }
            if let file = item.file, Self.isSafeMetricKitPath(file) {
                try? fileManager.removeItem(at: root.appendingPathComponent(file))
            }
        }
        try? fileManager.removeItem(at: outboxFile)
    }

    // MARK: Inbox

    /// Reads and deletes every command file in the inbox, oldest first.
    /// A command id seen before is skipped. A file that cannot be read is left alone while it is
    /// younger than `brokenFileGrace` seconds (the Mac may still be copying it), then deleted
    /// and reported as a problem.
    public func takeCommands(brokenFileGrace: TimeInterval = 2, now: Date = Date()) -> [Command] {
        let inbox = root.appendingPathComponent("inbox", isDirectory: true)
        let fileManager = FileManager.default
        let names = ((try? fileManager.contentsOfDirectory(atPath: inbox.path)) ?? [])
            .filter { !$0.hasPrefix(".") && $0.hasSuffix(".json") }
            .sorted()
        var commands: [Command] = []
        for name in names {
            let url = inbox.appendingPathComponent(name)
            guard let data = try? Data(contentsOf: url), let command = try? decoder.decode(Command.self, from: data) else {
                let modified = (try? fileManager.attributesOfItem(atPath: url.path)[.modificationDate] as? Date) ?? .distantPast
                if now.timeIntervalSince(modified) >= brokenFileGrace {
                    try? fileManager.removeItem(at: url)
                    record(.problem(Problem(location: "inbox", message: "Could not read the command file \(name), so it was deleted.")))
                }
                continue
            }
            try? fileManager.removeItem(at: url)
            guard command.formatVersion == FieldbookFormat.version else {
                record(.problem(Problem(
                    location: "inbox",
                    message: "\(name) has format version \(command.formatVersion); this probe reads version \(FieldbookFormat.version)."
                )))
                continue
            }
            guard !state.processedCommandIds.contains(command.id) else { continue }
            state.processedCommandIds.append(command.id)
            commands.append(command)
        }
        if state.processedCommandIds.count > Self.rememberedCommands {
            state.processedCommandIds.removeFirst(state.processedCommandIds.count - Self.rememberedCommands)
        }
        if !commands.isEmpty {
            try? saveState()
        }
        return commands.sorted { $0.seq < $1.seq }
    }

    // MARK: Kit state

    private func saveState() throws {
        try Self.writeAtomically(encoder.encode(state), to: root.appendingPathComponent("kit-state.json"))
    }

    // MARK: File helpers

    /// Writes to a hidden temporary file in the same folder, then renames it over the target.
    static func writeAtomically(_ data: Data, to url: URL) throws {
        let temporary = url.deletingLastPathComponent()
            .appendingPathComponent(".\(url.lastPathComponent).\(UUID().uuidString.prefix(8)).tmp")
        try data.write(to: temporary)
        try moveReplacing(temporary, to: url)
    }

    static func moveReplacing(_ source: URL, to destination: URL) throws {
        guard posixRename(source.path, destination.path) == 0 else {
            try? FileManager.default.removeItem(at: source)
            throw MailboxError.renameFailed(destination.lastPathComponent)
        }
    }

    static func padded(_ number: Int, width: Int) -> String {
        let digits = String(number)
        return digits.count >= width ? digits : String(repeating: "0", count: width - digits.count) + digits
    }

    static func isSafeName(_ name: String) -> Bool {
        !name.isEmpty && !name.hasPrefix(".") && !name.contains("/") && !name.contains("..")
    }

    static func isSafeMetricKitPath(_ path: String) -> Bool {
        path.hasPrefix("metrickit/") && !path.contains("..") && path.split(separator: "/").count == 2
    }
}

/// kit-state.json: counters that must survive a relaunch.
struct KitState: Codable, Sendable {
    var formatVersion: Int
    var nextOutboxSeq: Int
    var processedCommandIds: [String]

    static func load(root: URL) -> KitState {
        let decoder = FieldbookJSON.decoder()
        var state = (try? Data(contentsOf: root.appendingPathComponent("kit-state.json")))
            .flatMap { try? decoder.decode(KitState.self, from: $0) }
            ?? KitState(formatVersion: FieldbookFormat.version, nextOutboxSeq: 1, processedCommandIds: [])
        // If the counters were lost, never reuse a number that is still in the outbox.
        let outbox = root.appendingPathComponent("outbox", isDirectory: true)
        let highest = ((try? FileManager.default.contentsOfDirectory(atPath: outbox.path)) ?? [])
            .compactMap { name in Int(name.prefix { $0 != "-" }) }
            .max() ?? 0
        state.nextOutboxSeq = max(state.nextOutboxSeq, highest + 1)
        return state
    }
}

private func posixRename(_ source: String, _ destination: String) -> Int32 {
    #if canImport(Darwin)
    return Darwin.rename(source, destination)
    #elseif canImport(Glibc)
    return Glibc.rename(source, destination)
    #elseif canImport(Musl)
    return Musl.rename(source, destination)
    #else
    return -1
    #endif
}
