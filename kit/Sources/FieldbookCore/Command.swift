import Foundation

/// A command from the Mac, read from inbox/<seq>-<name>.json.
public struct Command: Codable, Sendable, Equatable {
    public enum Name: String, Codable, Sendable {
        case mark, snapshot, ping, ack
    }

    /// The arguments. Which ones matter depends on the name.
    public struct Args: Codable, Sendable, Equatable {
        /// mark: the name of the mark.
        public var name: String?
        /// mark: show the "What did you see?" sheet.
        public var ask: Bool?
        /// snapshot: which parts to take (all when missing).
        public var parts: [Snapshot.Part]?
        /// ack: every outbox item up to this sequence number was copied.
        public var upTo: Int?

        public init(name: String? = nil, ask: Bool? = nil, parts: [Snapshot.Part]? = nil, upTo: Int? = nil) {
            self.name = name
            self.ask = ask
            self.parts = parts
            self.upTo = upTo
        }
    }

    public var formatVersion: Int
    public var id: String
    public var seq: Int
    public var name: Name
    public var sentAt: Date
    public var args: Args

    public init(id: String, seq: Int, name: Name, sentAt: Date, args: Args = Args()) {
        self.formatVersion = FieldbookFormat.version
        self.id = id
        self.seq = seq
        self.name = name
        self.sentAt = sentAt
        self.args = args
    }
}

/// One item in outbox/: something the app made for the Mac.
public struct OutboxItem: Codable, Sendable, Equatable {
    public enum Kind: String, Codable, Sendable {
        case result, mark, metrickit
    }

    public var formatVersion: Int
    public var seq: Int
    public var runId: String
    public var time: Date
    public var kind: Kind
    public var commandId: String?
    public var commandName: String?
    public var via: CommandEvent.Via?
    public var ok: Bool
    public var message: String?
    public var snapshotId: String?
    public var markId: String?
    /// A file relative to the mailbox, for example a MetricKit payload.
    public var file: String?

    public init(
        seq: Int,
        runId: String,
        time: Date,
        kind: Kind,
        commandId: String? = nil,
        commandName: String? = nil,
        via: CommandEvent.Via? = nil,
        ok: Bool,
        message: String? = nil,
        snapshotId: String? = nil,
        markId: String? = nil,
        file: String? = nil
    ) {
        self.formatVersion = FieldbookFormat.version
        self.seq = seq
        self.runId = runId
        self.time = time
        self.kind = kind
        self.commandId = commandId
        self.commandName = commandName
        self.via = via
        self.ok = ok
        self.message = message
        self.snapshotId = snapshotId
        self.markId = markId
        self.file = file
    }

    /// Writes every key. A missing value is written as null, as docs/FORMAT.md shows.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(formatVersion, forKey: .formatVersion)
        try container.encode(seq, forKey: .seq)
        try container.encode(runId, forKey: .runId)
        try container.encode(time, forKey: .time)
        try container.encode(kind, forKey: .kind)
        try container.encode(commandId, forKey: .commandId)
        try container.encode(commandName, forKey: .commandName)
        try container.encode(via, forKey: .via)
        try container.encode(ok, forKey: .ok)
        try container.encode(message, forKey: .message)
        try container.encode(snapshotId, forKey: .snapshotId)
        try container.encode(markId, forKey: .markId)
        try container.encode(file, forKey: .file)
    }
}
