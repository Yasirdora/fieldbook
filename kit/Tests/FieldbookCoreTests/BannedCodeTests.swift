import Foundation
import Testing

/// Keeps forbidden code out of every Swift file under kit/Sources. Runs on Linux too.
struct BannedCodeTests {
    private static let banned = [
        // Ways around strict concurrency checking.
        "@unchecked Sendable", "nonisolated(unsafe)", "@preconcurrency", "assumeIsolated",
        // Method swizzling and private API.
        "swizzl", "method_exchangeImplementations", "method_setImplementation", "class_replaceMethod",
        "NSClassFromString", "NSSelectorFromString", "dlopen", "dlsym",
        // Networking. The kit reaches the Mac only through files and Darwin notifications.
        "URLSession", "NSURLConnection", "import Network", "NWConnection", "NWListener", "NWBrowser",
        "CFSocket", "CFStream", "socket(",
    ]

    private static let sources: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // FieldbookCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // kit
        .appendingPathComponent("Sources")

    @Test func sourcesUseNoBannedCode() throws {
        let files = try FileManager.default.subpathsOfDirectory(atPath: Self.sources.path)
            .filter { $0.hasSuffix(".swift") }
        #expect(!files.isEmpty, "no Swift files found in \(Self.sources.path)")
        for file in files {
            let text = try String(contentsOf: Self.sources.appendingPathComponent(file), encoding: .utf8)
            for word in Self.banned {
                #expect(!text.contains(word), "\(file) contains \(word)")
            }
        }
    }
}
