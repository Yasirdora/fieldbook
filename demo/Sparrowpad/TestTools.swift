import Foundation
import Observation
import os

/// What the test buttons do: freeze the main thread, use memory, write an error log, crash.
@MainActor
@Observable
final class TestTools {
    /// Size of one memory block, in megabytes.
    static let blockMegabytes = 50

    /// How many megabytes the memory blocks hold right now.
    private(set) var keptMegabytes = 0

    /// How often the main thread was frozen, so each tap shows an answer once the freeze ends.
    private(set) var freezes = 0

    /// How many errors were written to the log, so each tap shows an answer.
    private(set) var loggedErrors = 0

    @ObservationIgnored private var keptBlocks: [Data] = []

    private let logger = Logger(
        subsystem: Bundle.main.bundleIdentifier ?? "com.example.sparrowpad",
        category: "demo"
    )

    /// Blocks the main thread for 400 ms. The app does not answer during this time.
    func freezeMainThread() {
        Thread.sleep(forTimeInterval: 0.4)
        freezes += 1
    }

    /// Adds one more 50 MB block and keeps it. Every byte is written,
    /// so the memory really counts for the app.
    /// `Data` writes the bytes with one fast `memset`. A slow fill could
    /// itself look like a hang in a Debug build.
    func useMemory() {
        let byteCount = Self.blockMegabytes * 1024 * 1024
        keptBlocks.append(Data(repeating: 0xA5, count: byteCount))
        keptMegabytes = keptBlocks.count * Self.blockMegabytes
    }

    /// Lets go of all memory blocks.
    func freeMemory() {
        keptBlocks.removeAll()
        keptMegabytes = 0
    }

    /// Writes one error to the unified log. The message is invented.
    func logError() {
        logger.error("Could not save the garden plan: the shelf for seeds is full (test error 318).")
        loggedErrors += 1
    }

    #if DEBUG
    /// Stops the app on purpose, so a crash report is written.
    func crash() -> Never {
        fatalError("Sparrowpad test crash: the Crash button was tapped.")
    }
    #endif
}
