import Foundation
import Testing
@testable import FieldbookCore

/// The Swift side reads the shared fixtures. If these pass and the TypeScript
/// fixture tests pass, both sides agree on format version 1.
struct FormatFixtureTests {
    private let decoder = FieldbookJSON.decoder()

    @Test func helloDecodes() throws {
        let hello = try decoder.decode(Hello.self, from: Fixtures.data("mailbox/hello.json"))
        #expect(hello.formatVersion == FieldbookFormat.version)
        #expect(hello.bundleId == "com.example.fieldbook.demo")
        #expect(hello.commit == "a1b2c3d")
        #expect(hello.redaction == .hashed)
        #expect(hello.hangThresholdMs == 250)
    }

    @Test func everyCompleteEventLineDecodes() throws {
        let text = String(decoding: try Fixtures.data("mailbox/events.jsonl"), as: UTF8.self)
        let lines = EventLines.completeLines(in: text)
        #expect(lines.count == 11, "the last, unfinished line is skipped")
        let events = try lines.map { try decoder.decode(Event.self, from: Data($0.utf8)) }
        #expect(events.map(\.seq) == Array(1...11))
        guard case .hang(let hang) = events[5].payload else {
            Issue.record("event 6 should be a hang")
            return
        }
        #expect(hang.ms == 412)
        guard case .mark(let mark) = events[8].payload else {
            Issue.record("event 9 should be a mark")
            return
        }
        #expect(mark.name == "pin on the wrong page")
        #expect(mark.source == .command)
    }

    @Test func eventRoundTripKeepsEveryField() throws {
        let event = Event(
            runId: "RUN",
            seq: 3,
            // .125 is exact both as a binary number and in milliseconds, so the round trip is exact.
            time: Date(timeIntervalSince1970: 1_793_000_000.125),
            payload: .problem(Problem(location: "logs", message: "store not available"))
        )
        let data = try FieldbookJSON.encoder().encode(event)
        let json = String(decoding: data, as: UTF8.self)
        #expect(json.contains(#""kind":"problem""#))
        #expect(json.contains(#""where":"logs""#))
        #expect(try decoder.decode(Event.self, from: data) == event)
    }

    @Test func snapshotFilesDecode() throws {
        let folder = "mailbox/snapshots/5c1e0a2b-0001/"
        let info = try decoder.decode(Snapshot.self, from: Fixtures.data(folder + "snapshot.json"))
        #expect(info.parts == [.tree, .ax, .state, .rendered])
        let tree = try decoder.decode(ViewTree.self, from: Fixtures.data(folder + "tree.json"))
        #expect(tree.nodes == 5)
        let badge = tree.windows[0].root.children[0].children[0].children[1]
        #expect(badge.ax?.id == "pinnedBadge")
        #expect(badge.text?.sha256_8 == "f20c8794")
        let ax = try decoder.decode(AXTree.self, from: Fixtures.data(folder + "ax.json"))
        #expect(ax.windows[0].root.children[1].source == .uikitElement)
        let state = try decoder.decode(StateDump.self, from: Fixtures.data(folder + "state.json"))
        #expect(state.providers["editor"]?["page"] == 12)
    }

    @Test func outboxAndCommandsDecode() throws {
        let item = try decoder.decode(OutboxItem.self, from: Fixtures.data("mailbox/outbox/000001-mark.json"))
        #expect(item.kind == .mark)
        #expect(item.via == .notification)
        let mark = try decoder.decode(Command.self, from: Fixtures.data("command-mark.json"))
        #expect(mark.name == .mark)
        #expect(mark.args.ask == false)
        let ack = try decoder.decode(Command.self, from: Fixtures.data("command-ack.json"))
        #expect(ack.args.upTo == 1)
    }

    @Test func datesUseMillisecondsInUTC() throws {
        let date = try #require(FieldbookJSON.date(from: "2026-11-04T10:15:02.123Z"))
        #expect(FieldbookJSON.string(from: date) == "2026-11-04T10:15:02.123Z")
        #expect(FieldbookJSON.date(from: "2026-11-04T10:15:02Z") != nil)
    }

    @Test func datesRoundToTheNearestMillisecond() throws {
        // .390 cannot be stored exactly; it must not come back as .389.
        let date = try #require(FieldbookJSON.date(from: "2026-11-04T10:15:00.390Z"))
        #expect(FieldbookJSON.string(from: date) == "2026-11-04T10:15:00.390Z")
        let almostNextSecond = Date(timeIntervalSince1970: 1_793_000_000.9996)
        #expect(FieldbookJSON.string(from: almostNextSecond) == FieldbookJSON.string(from: Date(timeIntervalSince1970: 1_793_000_001)))
        #expect(FieldbookJSON.string(from: Date(timeIntervalSince1970: 1_793_000_000.007)).hasSuffix(".007Z"))
    }

    /// Decodes a fixture into `type`, encodes it again, and expects the same JSON.
    private func expectRoundTrip<T: Codable>(_ type: T.Type, _ path: String) throws {
        let data = try Fixtures.data(path)
        let encoded = try FieldbookJSON.encoder().encode(decoder.decode(type, from: data))
        let original = try decoder.decode(JSONValue.self, from: data)
        let written = try decoder.decode(JSONValue.self, from: encoded)
        #expect(written == original, "\(path) changed after a round trip")
    }

    @Test func filesTheKitWritesMatchTheFixtures() throws {
        try expectRoundTrip(Hello.self, "mailbox/hello.json")
        try expectRoundTrip(OutboxItem.self, "mailbox/outbox/000001-mark.json")
        let folder = "mailbox/snapshots/5c1e0a2b-0001/"
        try expectRoundTrip(Snapshot.self, folder + "snapshot.json")
        try expectRoundTrip(ViewTree.self, folder + "tree.json")
        try expectRoundTrip(AXTree.self, folder + "ax.json")
        try expectRoundTrip(StateDump.self, folder + "state.json")
    }

    private func json(_ value: some Encodable) throws -> String {
        String(decoding: try FieldbookJSON.encoder().encode(value), as: UTF8.self)
    }

    @Test func missingValuesAreWrittenAsNull() throws {
        let hello = try json(TestData.hello)
        #expect(hello.contains(#""commit":null"#))

        let item = try json(OutboxItem(seq: 1, runId: "RUN", time: Date(), kind: .result, ok: true))
        for key in ["commandId", "commandName", "via", "message", "snapshotId", "markId", "file"] {
            #expect(item.contains("\"\(key)\":null"), "outbox item: \(key)")
        }

        let snapshot = try json(Snapshot(id: "5c1e0a2b-0002", time: Date(), reason: .command, ms: 9, parts: [.state], tree: nil, ax: nil))
        for key in ["markId", "commandId", "tree", "ax"] {
            #expect(snapshot.contains("\"\(key)\":null"), "snapshot.json: \(key)")
        }

        let frame = LayoutRect(x: 0, y: 0, w: 390, h: 844)
        let window = try json(WindowTree(index: 0, number: nil, isKey: true, title: nil, frame: frame, root: JSONValue.null))
        #expect(window.contains(#""number":null"#))
        #expect(window.contains(#""title":null"#))
    }
}
