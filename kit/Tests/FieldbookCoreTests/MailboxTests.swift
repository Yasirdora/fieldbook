import Foundation
import Testing
@testable import FieldbookCore

struct MailboxTests {
    private let decoder = FieldbookJSON.decoder()

    private func makeMailbox(rotateBytes: Int = Mailbox.defaultRotateBytes, maxOutboxItems: Int = 50) async throws -> (Mailbox, URL) {
        let root = try Fixtures.temporaryFolder().appendingPathComponent("Fieldbook")
        let mailbox = try await Mailbox(root: root, runId: "5C1E0A2B-RUN", rotateBytes: rotateBytes, maxOutboxItems: maxOutboxItems)
        return (mailbox, root)
    }

    private func files(in folder: URL) -> [String] {
        ((try? FileManager.default.contentsOfDirectory(atPath: folder.path)) ?? []).sorted()
    }

    @Test func createsTheLayout() async throws {
        let (_, root) = try await makeMailbox()
        let names = files(in: root)
        for folder in ["inbox", "outbox", "snapshots", "metrickit"] {
            #expect(names.contains(folder))
        }
    }

    @Test func recordsEventsAsLinesWithRisingSequence() async throws {
        let (mailbox, root) = try await makeMailbox()
        await mailbox.record(.launch(Launch(ms: 391)))
        await mailbox.record(.hang(Hang(start: Date(), ms: 300)))
        let text = try String(contentsOf: root.appendingPathComponent("events.jsonl"), encoding: .utf8)
        let lines = EventLines.completeLines(in: text)
        #expect(lines.count == 2)
        let events = try lines.map { try decoder.decode(Event.self, from: Data($0.utf8)) }
        #expect(events.map(\.seq) == [1, 2])
        #expect(events.allSatisfy { $0.runId == "5C1E0A2B-RUN" })
    }

    @Test func rotatesAndKeepsTwoFiles() async throws {
        let (mailbox, root) = try await makeMailbox(rotateBytes: 400)
        for n in 0..<30 {
            await mailbox.record(.lifecycle(Lifecycle(state: n.isMultiple(of: 2) ? .active : .inactive)))
        }
        let names = files(in: root).filter { $0.hasPrefix("events") }
        #expect(names == ["events.1.jsonl", "events.jsonl"])
        let attributes = try FileManager.default.attributesOfItem(atPath: root.appendingPathComponent("events.jsonl").path)
        let size = try #require(attributes[.size] as? NSNumber).intValue
        #expect(size <= 400)
    }

    @Test func readsCommandsOnceAndDeletesTheirFiles() async throws {
        let (mailbox, root) = try await makeMailbox()
        let inbox = root.appendingPathComponent("inbox")
        try Fixtures.data("command-mark.json").write(to: inbox.appendingPathComponent("000001-mark.json"))
        let first = await mailbox.takeCommands()
        #expect(first.map(\.name) == [.mark])
        #expect(files(in: inbox).isEmpty)

        // The same command again (for example copied twice) runs only once.
        try Fixtures.data("command-mark.json").write(to: inbox.appendingPathComponent("000001-mark.json"))
        let second = await mailbox.takeCommands()
        #expect(second.isEmpty)
        #expect(files(in: inbox).isEmpty)
    }

    @Test func aBrokenCommandFileIsDroppedAndReported() async throws {
        let (mailbox, root) = try await makeMailbox()
        let inbox = root.appendingPathComponent("inbox")
        try Data("not json".utf8).write(to: inbox.appendingPathComponent("000003-mark.json"))
        // A young broken file may still be in the middle of a copy, so it stays.
        #expect(await mailbox.takeCommands().isEmpty)
        #expect(files(in: inbox) == ["000003-mark.json"])
        // Once it is old enough, it is dropped and reported.
        let commands = await mailbox.takeCommands(brokenFileGrace: 0)
        #expect(commands.isEmpty)
        #expect(files(in: inbox).isEmpty)
        let text = try String(contentsOf: root.appendingPathComponent("events.jsonl"), encoding: .utf8)
        #expect(text.contains(#""kind":"problem""#))
    }

    @Test func storesASnapshotAndPrunesItAfterAck() async throws {
        let (mailbox, root) = try await makeMailbox()
        let id = await mailbox.nextSnapshotId()
        #expect(id == "5c1e0a2b-0001")
        let info = Snapshot(id: id, time: Date(), reason: .command, ms: 12, parts: [.state], tree: nil, ax: nil)
        let state = StateDump(time: Date(), providers: ["editor": ["page": 2]], problems: [:])
        try await mailbox.storeSnapshot(SnapshotFiles(info: info, state: state))
        let item = try await mailbox.addOutbox(kind: .result, ok: true, snapshotId: id)
        #expect(item.seq == 1)
        #expect(files(in: root.appendingPathComponent("snapshots")) == [id])
        #expect(files(in: root.appendingPathComponent("outbox")) == ["000001-result.json"])

        await mailbox.prune(upTo: 1)
        #expect(files(in: root.appendingPathComponent("snapshots")).isEmpty)
        #expect(files(in: root.appendingPathComponent("outbox")).isEmpty)
    }

    @Test func twoMetricKitPayloadsInTheSameMillisecondKeepTheirOwnFiles() async throws {
        let (mailbox, root) = try await makeMailbox()
        let time = Date(timeIntervalSince1970: 1_793_000_000)
        let first = try await mailbox.storeMetricKit(Data("first".utf8), type: "diagnostics", at: time)
        let second = try await mailbox.storeMetricKit(Data("second".utf8), type: "diagnostics", at: time)
        #expect(first != second)
        let firstData = try Data(contentsOf: root.appendingPathComponent(first))
        let secondData = try Data(contentsOf: root.appendingPathComponent(second))
        #expect(firstData == Data("first".utf8))
        #expect(secondData == Data("second".utf8))
    }

    @Test func outboxSequenceSurvivesARelaunch() async throws {
        let (mailbox, root) = try await makeMailbox()
        _ = try await mailbox.addOutbox(kind: .result, ok: true)
        _ = try await mailbox.addOutbox(kind: .result, ok: true)
        let again = try await Mailbox(root: root, runId: "OTHER-RUN")
        let item = try await again.addOutbox(kind: .result, ok: true)
        #expect(item.seq == 3)
    }

    @Test func dropsTheOldestOutboxItemsWhenNobodyAcknowledges() async throws {
        let (mailbox, root) = try await makeMailbox(maxOutboxItems: 3)
        for _ in 0..<5 {
            _ = try await mailbox.addOutbox(kind: .result, ok: true)
        }
        #expect(files(in: root.appendingPathComponent("outbox")) == [
            "000003-result.json", "000004-result.json", "000005-result.json",
        ])
    }

    @Test func leavesNoTemporaryFiles() async throws {
        let (mailbox, root) = try await makeMailbox()
        try await mailbox.writeHello(TestData.hello)
        _ = try await mailbox.addOutbox(kind: .result, ok: true)
        let all = (FileManager.default.enumerator(atPath: root.path)?.allObjects as? [String]) ?? []
        #expect(!all.contains { URL(fileURLWithPath: $0).lastPathComponent.hasPrefix(".") })
    }

    /// The same rule as `isSafeName` in server/src/session/ingest.ts, so the kit never stores
    /// a snapshot the Mac would refuse to copy.
    @Test func safeNamesFollowTheServersRule() {
        for name in ["5c1e0a2b-0001", "5c1e0a2b-m3", "a.b_c-D9", "a..b", String(repeating: "a", count: 200)] {
            #expect(Mailbox.isSafeName(name), "\(name) should be safe")
        }
        for name in ["", ".hidden", "..", "a/b", "a b", "a+b", "caf\u{E9}", String(repeating: "a", count: 201)] {
            #expect(!Mailbox.isSafeName(name), "\(name) should not be safe")
        }
    }

    @Test func mailboxFolderDependsOnSandbox() {
        let support = URL(fileURLWithPath: "/Users/tester/Library/Application Support")
        #expect(
            MailboxLocation.root(applicationSupport: support, sandboxed: true, bundleId: "com.example.demo").path
                == "/Users/tester/Library/Application Support/Fieldbook"
        )
        #expect(
            MailboxLocation.root(applicationSupport: support, sandboxed: false, bundleId: "com.example.demo").path
                == "/Users/tester/Library/Application Support/Fieldbook/mailbox/com.example.demo"
        )
    }
}

enum TestData {
    static let hello = Hello(
        runId: "5C1E0A2B-RUN",
        bundleId: "com.example.fieldbook.demo",
        appName: "Fieldbook Demo",
        executable: "FieldbookDemo",
        appVersion: "1.0",
        appBuild: "7",
        commit: nil,
        deviceModel: "iPhone13,3",
        platform: "iOS",
        isSimulator: false,
        osVersion: "27.0.1",
        pid: 42,
        processStart: Date(timeIntervalSince1970: 1_793_000_000),
        redaction: .hashed,
        hangThresholdMs: 250,
        writtenAt: Date(timeIntervalSince1970: 1_793_000_000.4)
    )
}
