import Foundation

/// One line of events.jsonl: an envelope and one payload. See docs/FORMAT.md.
public struct Event: Sendable, Equatable {
    public var formatVersion: Int
    public var runId: String
    public var seq: Int
    public var time: Date
    public var payload: Payload

    public init(runId: String, seq: Int, time: Date, payload: Payload) {
        self.formatVersion = FieldbookFormat.version
        self.runId = runId
        self.seq = seq
        self.time = time
        self.payload = payload
    }

    /// What happened. The JSON key of the payload is the kind's name.
    public enum Payload: Sendable, Equatable {
        case launch(Launch)
        case lifecycle(Lifecycle)
        case log(LogLine)
        case hang(Hang)
        case memory(Memory)
        case mark(Mark)
        case note(Note)
        case snapshot(SnapshotEvent)
        case command(CommandEvent)
        case metricKit(MetricKitEvent)
        case problem(Problem)

        public var kind: String {
            switch self {
            case .launch: "launch"
            case .lifecycle: "lifecycle"
            case .log: "log"
            case .hang: "hang"
            case .memory: "memory"
            case .mark: "mark"
            case .note: "note"
            case .snapshot: "snapshot"
            case .command: "command"
            case .metricKit: "metrickit"
            case .problem: "problem"
            }
        }
    }
}

extension Event: Codable {
    private enum CodingKeys: String, CodingKey {
        case formatVersion, runId, seq, time, kind
        case launch, lifecycle, log, hang, memory, mark, note, snapshot, command, problem
        case metricKit = "metrickit"
    }

    public init(from decoder: any Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        formatVersion = try container.decode(Int.self, forKey: .formatVersion)
        runId = try container.decode(String.self, forKey: .runId)
        seq = try container.decode(Int.self, forKey: .seq)
        time = try container.decode(Date.self, forKey: .time)
        let kind = try container.decode(String.self, forKey: .kind)
        switch kind {
        case "launch": payload = .launch(try container.decode(Launch.self, forKey: .launch))
        case "lifecycle": payload = .lifecycle(try container.decode(Lifecycle.self, forKey: .lifecycle))
        case "log": payload = .log(try container.decode(LogLine.self, forKey: .log))
        case "hang": payload = .hang(try container.decode(Hang.self, forKey: .hang))
        case "memory": payload = .memory(try container.decode(Memory.self, forKey: .memory))
        case "mark": payload = .mark(try container.decode(Mark.self, forKey: .mark))
        case "note": payload = .note(try container.decode(Note.self, forKey: .note))
        case "snapshot": payload = .snapshot(try container.decode(SnapshotEvent.self, forKey: .snapshot))
        case "command": payload = .command(try container.decode(CommandEvent.self, forKey: .command))
        case "metrickit": payload = .metricKit(try container.decode(MetricKitEvent.self, forKey: .metricKit))
        case "problem": payload = .problem(try container.decode(Problem.self, forKey: .problem))
        default:
            throw DecodingError.dataCorruptedError(forKey: .kind, in: container, debugDescription: "Unknown event kind: \(kind)")
        }
    }

    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(formatVersion, forKey: .formatVersion)
        try container.encode(runId, forKey: .runId)
        try container.encode(seq, forKey: .seq)
        try container.encode(time, forKey: .time)
        try container.encode(payload.kind, forKey: .kind)
        switch payload {
        case .launch(let value): try container.encode(value, forKey: .launch)
        case .lifecycle(let value): try container.encode(value, forKey: .lifecycle)
        case .log(let value): try container.encode(value, forKey: .log)
        case .hang(let value): try container.encode(value, forKey: .hang)
        case .memory(let value): try container.encode(value, forKey: .memory)
        case .mark(let value): try container.encode(value, forKey: .mark)
        case .note(let value): try container.encode(value, forKey: .note)
        case .snapshot(let value): try container.encode(value, forKey: .snapshot)
        case .command(let value): try container.encode(value, forKey: .command)
        case .metricKit(let value): try container.encode(value, forKey: .metricKit)
        case .problem(let value): try container.encode(value, forKey: .problem)
        }
    }
}

/// Time from process start to the first time the app became active.
public struct Launch: Codable, Sendable, Equatable {
    public var ms: Int
    public init(ms: Int) { self.ms = ms }
}

/// The app became active, inactive, or went to the background.
public struct Lifecycle: Codable, Sendable, Equatable {
    public enum State: String, Codable, Sendable {
        case active, inactive, background
    }
    public var state: State
    public init(state: State) { self.state = state }
}

/// One log entry of this process, cut to 500 characters.
public struct LogLine: Codable, Sendable, Equatable {
    public var level: String
    public var subsystem: String
    public var category: String
    public var message: String
    public var cut: Bool
    public var logTime: Date

    public init(level: String, subsystem: String, category: String, message: String, cut: Bool, logTime: Date) {
        self.level = level
        self.subsystem = subsystem
        self.category = category
        self.message = message
        self.cut = cut
        self.logTime = logTime
    }
}

/// The main thread did not answer for `ms` milliseconds.
public struct Hang: Codable, Sendable, Equatable {
    public var start: Date
    public var ms: Int
    public init(start: Date, ms: Int) {
        self.start = start
        self.ms = ms
    }
}

/// Memory footprint (`phys_footprint`) and the highest value seen in this run, in bytes.
public struct Memory: Codable, Sendable, Equatable {
    public var footprint: UInt64
    public var peak: UInt64
    public init(footprint: UInt64, peak: UInt64) {
        self.footprint = footprint
        self.peak = peak
    }
}

/// A moment a tester marked: by shaking the phone, with ⌃⌥⌘M on the Mac, or by a command.
public struct Mark: Codable, Sendable, Equatable {
    public enum Source: String, Codable, Sendable {
        case shake, key, command
    }
    public var id: String
    public var number: Int
    public var name: String?
    public var source: Source
    public var snapshotId: String
    public var commandId: String?

    public init(id: String, number: Int, name: String?, source: Source, snapshotId: String, commandId: String?) {
        self.id = id
        self.number = number
        self.name = name
        self.source = source
        self.snapshotId = snapshotId
        self.commandId = commandId
    }
}

/// What the tester typed in the "What did you see?" sheet.
public struct Note: Codable, Sendable, Equatable {
    public var markId: String
    public var text: String
    public init(markId: String, text: String) {
        self.markId = markId
        self.text = text
    }
}

/// A snapshot was stored in snapshots/<id>/.
public struct SnapshotEvent: Codable, Sendable, Equatable {
    public var id: String
    public var reason: Snapshot.Reason
    public var ms: Int
    public var nodes: Int
    public var axNodes: Int
    public var truncated: Bool

    public init(id: String, reason: Snapshot.Reason, ms: Int, nodes: Int, axNodes: Int, truncated: Bool) {
        self.id = id
        self.reason = reason
        self.ms = ms
        self.nodes = nodes
        self.axNodes = axNodes
        self.truncated = truncated
    }
}

/// The app read a command from its inbox.
public struct CommandEvent: Codable, Sendable, Equatable {
    /// How the app learned about the command.
    public enum Via: String, Codable, Sendable {
        case notification, poll
    }
    public var id: String
    public var name: String
    public var via: Via
    public init(id: String, name: String, via: Via) {
        self.id = id
        self.name = name
        self.via = via
    }
}

/// MetricKit delivered a payload, stored at `file` (relative to the mailbox).
public struct MetricKitEvent: Codable, Sendable, Equatable {
    public var file: String
    public var type: String
    public init(file: String, type: String) {
        self.file = file
        self.type = type
    }
}

/// Something inside Fieldbook went wrong. The app goes on.
public struct Problem: Codable, Sendable, Equatable {
    public var location: String
    public var message: String

    private enum CodingKeys: String, CodingKey {
        case location = "where"
        case message
    }

    public init(location: String, message: String) {
        self.location = location
        self.message = message
    }
}
