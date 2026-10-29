#if canImport(UIKit) || canImport(AppKit)
import FieldbookCore
import Foundation

/// The parts of a snapshot, taken on the main thread and ready to be stored.
struct Capture: Sendable {
    let time: Date
    let parts: [Snapshot.Part]
    let tree: ViewTree?
    let ax: AXTree?
    let state: StateDump?
    let renderedPNG: Data?
    let problems: [String]
    /// How long the main thread spent taking the parts.
    let ms: Int
}

/// The kit's steps in the mailbox. Each one runs from start to end on the mailbox actor, so its files and
/// events are written together, in order, and off the main thread.
extension Mailbox {
    /// Marks the mailbox folder "do not back up".
    func excludeFromBackup() throws {
        var folder = root
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try folder.setResourceValues(values)
    }

    /// Stores a mark: its snapshot, the snapshot event, the mark event and an outbox item.
    /// When the snapshot could not be stored, the outbox item names no snapshot, so the Mac
    /// does not wait for files that will never come.
    func storeMark(_ capture: Capture, source: Mark.Source, name: String?, command: Command?, via: CommandEvent.Via?) -> Mark {
        let next = nextMark()
        let snapshotId = nextSnapshotId()
        let stored = storeCapture(capture, id: snapshotId, reason: .mark, markId: next.id, commandId: command?.id)
        let mark = Mark(id: next.id, number: next.number, name: name, source: source, snapshotId: snapshotId, commandId: command?.id)
        record(.mark(mark))
        addOutboxOrRecordProblem(
            kind: .mark,
            ok: stored,
            message: stored ? nil : "The snapshot could not be stored.",
            command: command,
            via: via,
            snapshotId: stored ? snapshotId : nil,
            markId: next.id
        )
        return mark
    }

    /// Stores the snapshot a `snapshot` command asked for, and answers the command.
    func storeCommandSnapshot(_ capture: Capture, command: Command, via: CommandEvent.Via) {
        let snapshotId = nextSnapshotId()
        let stored = storeCapture(capture, id: snapshotId, reason: .command, markId: nil, commandId: command.id)
        addOutboxOrRecordProblem(
            kind: .result,
            ok: stored,
            message: stored ? nil : "The snapshot could not be stored.",
            command: command,
            via: via,
            snapshotId: stored ? snapshotId : nil
        )
    }

    /// Answers `ping` at once.
    func answerPing(_ command: Command, via: CommandEvent.Via) {
        addOutboxOrRecordProblem(kind: .result, ok: true, message: "pong", command: command, via: via)
    }

    /// `ack`: the Mac has copied the outbox up to `upTo`, so those items can go.
    func acknowledge(_ command: Command) {
        guard let upTo = command.args.upTo else {
            record(.problem(Problem(location: "inbox", message: "The ack command \(command.id) has no upTo.")))
            return
        }
        prune(upTo: upTo)
    }

    /// Stores one MetricKit payload, records it and tells the Mac.
    func storeMetricKitPayload(_ data: Data, type: String) {
        do {
            let file = try storeMetricKit(data, type: type)
            record(.metricKit(MetricKitEvent(file: file, type: type)))
            addOutboxOrRecordProblem(kind: .metrickit, ok: true, file: file)
        } catch {
            record(.problem(Problem(location: "metrickit", message: "Could not store a \(type) payload: \(error)")))
        }
    }

    // MARK: Steps

    /// Writes the snapshot folder and records the snapshot event. False when the files could
    /// not be written; a problem event says why.
    private func storeCapture(_ capture: Capture, id: String, reason: Snapshot.Reason, markId: String?, commandId: String?) -> Bool {
        let info = Snapshot(
            id: id,
            time: capture.time,
            reason: reason,
            markId: markId,
            commandId: commandId,
            ms: capture.ms,
            parts: capture.parts,
            tree: capture.tree.map { Snapshot.Count(nodes: $0.nodes, truncated: $0.truncated) },
            ax: capture.ax.map { Snapshot.Count(nodes: $0.nodes, truncated: $0.truncated) },
            problems: capture.problems
        )
        let files = SnapshotFiles(info: info, tree: capture.tree, ax: capture.ax, state: capture.state, renderedPNG: capture.renderedPNG)
        do {
            try storeSnapshot(files)
        } catch {
            record(.problem(Problem(location: "snapshot", message: "Could not store snapshot \(id): \(error)")))
            return false
        }
        record(.snapshot(SnapshotEvent(
            id: id,
            reason: reason,
            ms: capture.ms,
            nodes: capture.tree?.nodes ?? 0,
            axNodes: capture.ax?.nodes ?? 0,
            truncated: (capture.tree?.truncated ?? false) || (capture.ax?.truncated ?? false)
        )))
        return true
    }

    private func addOutboxOrRecordProblem(
        kind: OutboxItem.Kind,
        ok: Bool,
        message: String? = nil,
        command: Command? = nil,
        via: CommandEvent.Via? = nil,
        snapshotId: String? = nil,
        markId: String? = nil,
        file: String? = nil
    ) {
        do {
            try addOutbox(
                kind: kind, ok: ok, message: message, command: command, via: via,
                snapshotId: snapshotId, markId: markId, file: file
            )
        } catch {
            record(.problem(Problem(location: "outbox", message: "Could not write a \(kind.rawValue) item: \(error)")))
        }
    }
}
#endif
