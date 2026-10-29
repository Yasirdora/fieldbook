#if canImport(UIKit)
import CoreMotion
import FieldbookCore
import UIKit

/// iOS: a shake of the device marks a moment.
///
/// While the app is active, the accelerometer runs at 10 Hz and is read 10 times a second.
/// No permission is needed for it. Two samples above 2.3 g within half a second count as a
/// shake; each sample counts once. The simulator has no accelerometer, so this does nothing there.
@MainActor
final class MarkTrigger {
    static let source = Mark.Source.shake

    /// Acceleration (in g, gravity included) that counts as a peak.
    private static let peakG = 2.3
    /// Two peaks within this many seconds make a shake.
    private static let shakeWindow: TimeInterval = 0.5
    private static let readInterval: TimeInterval = 0.1

    private let motion = CMMotionManager()
    private let onMark: @MainActor @Sendable () -> Void
    private var reader: Task<Void, Never>?
    private var lastPeak = Date.distantPast
    /// The timestamp of the last sample that was checked. The reader is not in step with the
    /// sensor and can see one sample twice. One jolt must not count as two peaks.
    private var lastSampleTime: TimeInterval = 0

    init(onMark: @escaping @MainActor @Sendable () -> Void) {
        self.onMark = onMark
    }

    static func isEnabled(in options: FieldbookOptions) -> Bool {
        options.shakeToMark
    }

    func start() {
        guard reader == nil, motion.isAccelerometerAvailable else { return }
        motion.accelerometerUpdateInterval = Self.readInterval
        motion.startAccelerometerUpdates()
        reader = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(Self.readInterval))
                guard let self, !Task.isCancelled else { return }
                self.read()
            }
        }
    }

    func stop() {
        reader?.cancel()
        reader = nil
        motion.stopAccelerometerUpdates()
    }

    private func read() {
        guard let data = motion.accelerometerData, data.timestamp != lastSampleTime else { return }
        lastSampleTime = data.timestamp
        let acceleration = data.acceleration
        let g = (acceleration.x * acceleration.x + acceleration.y * acceleration.y + acceleration.z * acceleration.z).squareRoot()
        guard g > Self.peakG else { return }
        let now = Date()
        if now.timeIntervalSince(lastPeak) <= Self.shakeWindow {
            lastPeak = .distantPast
            onMark()
        } else {
            lastPeak = now
        }
    }
}

#elseif canImport(AppKit)
import AppKit
import FieldbookCore

/// macOS: Control-Option-Command-M marks a moment. The key press goes to Fieldbook only;
/// the app does not see it.
@MainActor
final class MarkTrigger {
    static let source = Mark.Source.key

    private let onMark: @MainActor @Sendable () -> Void
    private var monitor: Any?

    init(onMark: @escaping @MainActor @Sendable () -> Void) {
        self.onMark = onMark
    }

    static func isEnabled(in options: FieldbookOptions) -> Bool {
        options.keyToMark
    }

    /// A local monitor runs on the main thread and only while the app is active.
    func start() {
        guard monitor == nil else { return }
        let onMark = onMark
        monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            guard MarkTrigger.isMarkKey(event) else { return event }
            onMark()
            return nil
        }
    }

    /// Nothing to do: the monitor sees key presses only while the app is active.
    func stop() {}

    /// Control, Option and Command held (Shift not), and the M key. Caps Lock does not matter.
    private static func isMarkKey(_ event: NSEvent) -> Bool {
        let modifiers = event.modifierFlags.intersection([.control, .option, .command, .shift])
        return modifiers == [.control, .option, .command] && event.charactersIgnoringModifiers?.lowercased() == "m"
    }
}
#endif
