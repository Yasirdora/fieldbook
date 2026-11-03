#if canImport(UIKit) || canImport(AppKit)
import FieldbookCore
import Foundation
#if canImport(MetricKit)
import MetricKit
#endif

/// Owns every part of the probe: the mailbox, the watchers and the timers. It lives as long
/// as the app. All mailbox work goes through one queue of steps, so events keep their order.
@MainActor
final class Probe {
    /// Shake and key marks closer together than this are ignored.
    private static let userMarkGap: TimeInterval = 2

    private let options: FieldbookOptions
    private let redaction: Redaction
    private let providers: StateProviders
    private let info = AppInfo.current()

    private var mailbox: Mailbox?
    /// The newest step in the mailbox queue. Each new step waits for it.
    private var lastStep: Task<Void, Never>?

    private var lifecycle: LifecycleObserver?
    private var watchdog: Watchdog?
    private var markTrigger: MarkTrigger?
    private var logExporter: LogExporter?
    #if canImport(MetricKit)
    private var metricKit: MetricKitSubscriber?
    #endif
    /// Samples memory, reads logs and reads the inbox. Runs only while the app is active.
    private var sampler: Task<Void, Never>?

    private var isActive = false
    private var isReadingLogs = false
    private var launchRecorded = false
    private var peakFootprint: UInt64 = 0
    private var memoryProblemRecorded = false
    private var lastUserMark = Date.distantPast

    init(options: FieldbookOptions, providers: StateProviders) {
        self.options = options
        self.providers = providers
        self.redaction = options.redaction.map { Redaction(mode: $0) }
            ?? Redaction.fromArguments(ProcessInfo.processInfo.arguments)
    }

    func start() {
        openMailbox()
        lifecycle = LifecycleObserver { [weak self] state in
            self?.lifecycleChanged(state)
        }
        watchdog = Watchdog(thresholdMs: options.usableHangThresholdMs) { [weak self] hang in
            Task { @MainActor in self?.record(.hang(hang)) }
        }
        if MarkTrigger.isEnabled(in: options) {
            markTrigger = MarkTrigger { [weak self] in
                self?.userMark()
            }
        }
        DarwinNotifications.observeInbox(bundleId: info.bundleId) { [weak self] in
            self?.readInbox(via: .notification)
        }
        logExporter = LogExporter(after: info.processStart ?? Date())
        subscribeToMetricKit()
        // This step runs once the app is running. If the app was already active when
        // start() ran, no "became active" notification will come, so handle that case here.
        Task { [weak self] in
            self?.catchUpIfAlreadyActive()
        }
    }

    // MARK: Mailbox queue

    private func openMailbox() {
        let info = self.info
        let redaction = self.redaction
        let hangThresholdMs = options.usableHangThresholdMs
        lastStep = Task { [weak self] in
            let root = MailboxLocation.root(
                applicationSupport: URL.applicationSupportDirectory,
                sandboxed: info.isSandboxed,
                bundleId: info.bundleId
            )
            let outboxName = DarwinNotifications.outboxName(bundleId: info.bundleId)
            let mailbox: Mailbox
            do {
                mailbox = try await Mailbox(root: root, onOutbox: { DarwinNotifications.post(outboxName) })
            } catch {
                // Without a mailbox there is nowhere to write a problem event.
                print("Fieldbook: could not open the mailbox at \(root.path): \(error)")
                return
            }
            do {
                try await mailbox.excludeFromBackup()
            } catch {
                await mailbox.record(.problem(Problem(location: "mailbox", message: "Could not mark the mailbox \"do not back up\": \(error)")))
            }
            do {
                let hello = info.hello(runId: mailbox.runId, redaction: redaction, hangThresholdMs: hangThresholdMs, now: Date())
                try await mailbox.writeHello(hello)
            } catch {
                await mailbox.record(.problem(Problem(location: "mailbox", message: "Could not write hello.json: \(error)")))
            }
            self?.mailbox = mailbox
        }
    }

    /// Runs `step` with the mailbox after every earlier step, one at a time, in order.
    /// When the mailbox could not be opened, steps are dropped.
    private func enqueue(_ step: @escaping @MainActor @Sendable (Mailbox) async -> Void) {
        let previous = lastStep
        lastStep = Task { [weak self] in
            _ = await previous?.value
            guard let mailbox = self?.mailbox else { return }
            await step(mailbox)
        }
    }

    private func record(_ payload: Event.Payload) {
        record([payload])
    }

    private func record(_ payloads: [Event.Payload]) {
        guard !payloads.isEmpty else { return }
        let time = Date()
        enqueue { mailbox in
            for payload in payloads {
                await mailbox.record(payload, at: time)
            }
        }
    }

    // MARK: Lifecycle

    private func lifecycleChanged(_ state: Lifecycle.State) {
        record(.lifecycle(Lifecycle(state: state)))
        if state == .active {
            becameActive()
        } else {
            becameInactive()
        }
    }

    private func becameActive() {
        if !launchRecorded {
            launchRecorded = true
            recordLaunch()
        }
        guard !isActive else { return }
        isActive = true
        watchdog?.resume()
        markTrigger?.start()
        startSampling()
    }

    private func becameInactive() {
        guard isActive else { return }
        isActive = false
        watchdog?.pause()
        markTrigger?.stop()
        sampler?.cancel()
        sampler = nil
    }

    /// Launch time: from the moment the kernel started the process to the first "active".
    private func recordLaunch() {
        if Self.wasPrewarmed {
            record(.problem(Problem(location: "launch", message: "The system prewarmed the process, so the launch time was not measured.")))
            return
        }
        guard let processStart = info.processStart else {
            record(.problem(Problem(location: "launch", message: "The process start time is unknown, so the launch time was not measured.")))
            return
        }
        let ms = Int((Date().timeIntervalSince(processStart) * 1000).rounded())
        record(.launch(Launch(ms: max(ms, 0))))
    }

    /// iOS can start ("prewarm") the process long before the user opens the app. Then the
    /// process start time says nothing about the launch. macOS never sets this variable.
    private static var wasPrewarmed: Bool {
        ProcessInfo.processInfo.environment["ActivePrewarm"] == "1"
    }

    private func catchUpIfAlreadyActive() {
        guard !launchRecorded, LifecycleObserver.isAppActive else { return }
        launchRecorded = true
        record(.problem(Problem(location: "launch", message: "Fieldbook.start() ran after the app became active, so the launch time was not measured.")))
        lifecycleChanged(.active)
    }

    // MARK: Sampling (only while active)

    /// Low priority, so the probe's background work does not compete with the app.
    /// Tasks started from the sampler (log reads, mailbox steps) get the same priority.
    private func startSampling() {
        let interval = options.usableSampleInterval
        sampler = Task(priority: .utility) { [weak self] in
            while !Task.isCancelled {
                guard let self else { return }
                self.sample()
                try? await Task.sleep(for: .seconds(interval))
            }
        }
    }

    private func sample() {
        sampleMemory()
        exportLogs()
        readInbox(via: .poll)
    }

    private func sampleMemory() {
        guard let footprint = MemorySampler.footprint() else {
            if !memoryProblemRecorded {
                memoryProblemRecorded = true
                record(.problem(Problem(location: "memory", message: "task_info(TASK_VM_INFO) failed, so memory is not measured.")))
            }
            return
        }
        peakFootprint = max(peakFootprint, footprint)
        record(.memory(Memory(footprint: footprint, peak: peakFootprint)))
    }

    /// Reads new log entries off the main thread. While a read still runs, no new one starts,
    /// so slow reads do not pile up.
    private func exportLogs() {
        guard let logExporter, !isReadingLogs else { return }
        isReadingLogs = true
        Task { [weak self] in
            let batch = await logExporter.read()
            var payloads = batch.lines.map { Event.Payload.log($0) }
            if let problem = batch.problem {
                payloads.append(.problem(problem))
            }
            self?.isReadingLogs = false
            self?.record(payloads)
        }
    }

    // MARK: Commands

    private func readInbox(via: CommandEvent.Via) {
        enqueue { [weak self] mailbox in
            let commands = await mailbox.takeCommands()
            for command in commands {
                self?.handle(command, via: via)
            }
        }
    }

    private func handle(_ command: Command, via: CommandEvent.Via) {
        record(.command(CommandEvent(id: command.id, name: command.name.rawValue, via: via)))
        switch command.name {
        case .mark:
            // An empty name counts as no name, so the mark is named after its source.
            mark(source: .command, name: Describe.nonEmpty(command.args.name), command: command, via: via, ask: command.args.ask ?? false)
        case .snapshot:
            let capture = takeCapture(parts: command.args.parts ?? Snapshot.Part.allCases)
            enqueue { mailbox in
                await mailbox.storeCommandSnapshot(capture, command: command, via: via)
            }
        case .ping:
            enqueue { mailbox in
                await mailbox.answerPing(command, via: via)
            }
        case .ack:
            enqueue { mailbox in
                await mailbox.acknowledge(command)
            }
        }
    }

    // MARK: Marks and snapshots

    /// A shake (iOS) or the key (macOS).
    private func userMark() {
        let now = Date()
        guard now.timeIntervalSince(lastUserMark) >= Self.userMarkGap else { return }
        lastUserMark = now
        mark(source: MarkTrigger.source, name: nil, command: nil, via: nil, ask: true)
    }

    /// Takes the snapshot first, then stores the mark, then asks for a note if wanted.
    private func mark(source: Mark.Source, name: String?, command: Command?, via: CommandEvent.Via?, ask: Bool) {
        let capture = takeCapture(parts: Snapshot.Part.allCases)
        enqueue { [weak self] mailbox in
            let mark = await mailbox.storeMark(capture, source: source, name: name, command: command, via: via)
            if ask {
                self?.askForNote(markId: mark.id)
            }
        }
    }

    private func askForNote(markId: String) {
        NoteSheet.ask { [weak self] text in
            guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), !text.isEmpty else { return }
            self?.record(.note(Note(markId: markId, text: text)))
        }
    }

    /// Takes the requested parts on the main thread. Storing them happens later, off it.
    /// The watchdog pauses meanwhile: the probe's own work is not a hang of the app.
    private func takeCapture(parts requested: [Snapshot.Part]) -> Capture {
        watchdog?.pause()
        defer {
            if isActive { watchdog?.resume() }
        }
        let started = DispatchTime.now().uptimeNanoseconds
        let time = Date()
        let parts = Snapshot.Part.allCases.filter { requested.contains($0) }
        let windows = AppWindows.foreground()
        var problems: [String] = []
        if windows.isEmpty {
            problems.append("No window was on screen.")
        }
        let tree = parts.contains(.tree) ? ViewTreeCapture.capture(windows: windows, redaction: redaction) : nil
        let ax = parts.contains(.ax) ? AccessibilityTreeCapture.capture(windows: windows, redaction: redaction) : nil
        let state = parts.contains(.state) ? providers.dump(at: time) : nil
        var png: Data?
        if parts.contains(.rendered) {
            png = AppWindows.key(in: windows).flatMap { Renderer.png(of: $0) }
            if png == nil {
                problems.append("The key window could not be drawn, so there is no rendered screen.")
            }
        }
        let ms = Int((DispatchTime.now().uptimeNanoseconds - started) / 1_000_000)
        return Capture(time: time, parts: parts, tree: tree, ax: ax, state: state, renderedPNG: png, problems: problems, ms: ms)
    }

    // MARK: MetricKit

    private func subscribeToMetricKit() {
        #if canImport(MetricKit)
        let subscriber = MetricKitSubscriber { [weak self] data, type in
            Task { @MainActor in self?.storeMetricKit(data, type: type) }
        }
        MXMetricManager.shared.add(subscriber)
        metricKit = subscriber
        #endif
    }

    private func storeMetricKit(_ data: Data, type: String) {
        enqueue { mailbox in
            await mailbox.storeMetricKitPayload(data, type: type)
        }
    }
}
#endif
