#if canImport(UIKit) || canImport(AppKit)
import Dispatch
import FieldbookCore
import Foundation
import Synchronization

/// Watches the main thread and reports each stall (hang) of at least the threshold.
///
/// Every 50 ms a background queue sends a ping to the main queue, unless the last ping is still
/// waiting. When the main thread runs the ping, the wait is measured. The state both threads
/// share sits behind a mutex, so there are no data races.
final class Watchdog: Sendable {
    private struct Ping: Equatable {
        let generation: Int
        let sentAt: Date
        let sentNanos: UInt64
    }

    private struct State {
        /// Counts up on every resume and pause, so old pings and old timers stop counting.
        var generation = 0
        var isRunning = false
        var waiting: Ping?
    }

    private enum Step {
        case stop, wait, send(Ping)
    }

    /// Time between two pings.
    private static let intervalMs = 50

    private let thresholdNanos: UInt64
    private let report: @Sendable (Hang) -> Void
    private let queue = DispatchQueue(label: "fieldbook.watchdog", qos: .utility)
    private let state = Mutex(State())

    /// `report` runs on the main thread after a stall has ended.
    init(thresholdMs: Int, report: @escaping @Sendable (Hang) -> Void) {
        self.thresholdNanos = UInt64(max(thresholdMs, 1)) * 1_000_000
        self.report = report
    }

    /// Starts watching, with no ping waiting. A ping sent before this no longer counts, so time
    /// spent in the background is never reported as a hang.
    func resume() {
        let generation = state.withLock { state in
            state.generation += 1
            state.isRunning = true
            state.waiting = nil
            return state.generation
        }
        queue.async { self.tick(generation) }
    }

    /// Stops watching. The background queue then sleeps; nothing runs until `resume()`.
    func pause() {
        state.withLock { state in
            state.generation += 1
            state.isRunning = false
            state.waiting = nil
        }
    }

    // MARK: Background queue

    private func tick(_ generation: Int) {
        let step = state.withLock { state -> Step in
            guard state.isRunning, state.generation == generation else { return .stop }
            guard state.waiting == nil else { return .wait }
            let ping = Ping(generation: generation, sentAt: Date(), sentNanos: DispatchTime.now().uptimeNanoseconds)
            state.waiting = ping
            return .send(ping)
        }
        switch step {
        case .stop:
            return
        case .wait:
            break
        case .send(let ping):
            DispatchQueue.main.async { self.answer(ping) }
        }
        queue.asyncAfter(deadline: .now() + .milliseconds(Self.intervalMs)) { self.tick(generation) }
    }

    // MARK: Main thread

    private func answer(_ ping: Ping) {
        let now = DispatchTime.now().uptimeNanoseconds
        let isCurrent = state.withLock { state -> Bool in
            guard state.waiting == ping else { return false }
            state.waiting = nil
            return true
        }
        guard isCurrent, now > ping.sentNanos else { return }
        let waited = now - ping.sentNanos
        guard waited >= thresholdNanos else { return }
        report(Hang(start: ping.sentAt, ms: Int(waited / 1_000_000)))
    }
}
#endif
