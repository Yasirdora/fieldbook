import Foundation
import Testing

/// Keeps the kit's rules in every Swift file under kit/Sources: no ways around strict concurrency,
/// no private API, no swizzling, no networking. The whole text is scanned, comments too, so the
/// banned words must not appear in kit/Sources at all. (This file may spell them: it is under Tests.)
/// The server runs the same scan in server/test/kit-rules.test.ts. Runs on Linux too.
struct KitSourceRulesTests {
    /// One banned thing: a regular expression and the reason it is banned.
    struct Rule: Sendable {
        let pattern: String
        let why: String
    }

    static let rules: [Rule] = [
        Rule(pattern: #"@unchecked\s+Sendable"#, why: "hides data races from the compiler"),
        Rule(pattern: #"nonisolated\s*\(\s*unsafe\s*\)"#, why: "hides data races from the compiler"),
        Rule(pattern: #"@preconcurrency"#, why: "turns off concurrency checks"),
        Rule(pattern: #"assumeIsolated"#, why: "crashes when the assumption is wrong"),
        Rule(pattern: #"(?i)swizzl"#, why: "method swizzling"),
        Rule(pattern: #"method_exchangeImplementations|method_setImplementation|class_replaceMethod|class_addMethod"#, why: "method swizzling"),
        Rule(pattern: #"\bdlopen\b|\bdlsym\b"#, why: "loads code by name (private API)"),
        Rule(pattern: #"NSClassFromString|NSSelectorFromString|Selector\(\s*""#, why: "reaches classes or methods by name (private API)"),
        Rule(pattern: #"forKey(Path)?:\s*"_"#, why: "reads a private property by key"),
        Rule(pattern: #"@_silgen_name|@_spi|@_exported"#, why: "reaches hidden symbols, or re-exports a module the app should not see"),
        Rule(pattern: #"\bURLSession\b|\bURLRequest\b|NSURLConnection"#, why: "networking"),
        Rule(pattern: #"import\s+Network\b|\bNWConnection\b|\bNWListener\b|\bNWBrowser\b|\bNWPathMonitor\b"#, why: "networking"),
        Rule(pattern: #"\bsocket\s*\(|\bCFSocket|\bCFStream|Stream\.getStreamsToHost"#, why: "networking (sockets)"),
    ]

    /// kit/Sources, found from this file's path.
    static let sources: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // FieldbookCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // kit
        .appendingPathComponent("Sources")

    /// Every banned thing in `text`, as "pattern (why)".
    static func violations(in text: String) throws -> [String] {
        try rules.compactMap { rule in
            let regex = try Regex(rule.pattern)
            return text.contains(regex) ? "\(rule.pattern) (\(rule.why))" : nil
        }
    }

    /// Paths of the Swift files under `folder`, relative to it.
    static func swiftFiles(in folder: URL) throws -> [String] {
        try FileManager.default.subpathsOfDirectory(atPath: folder.path)
            .filter { $0.hasSuffix(".swift") }
            .sorted()
    }

    @Test func sourcesContainNoBannedConstruct() throws {
        let files = try Self.swiftFiles(in: Self.sources)
        #expect(files.count >= 5, "expected Swift files in \(Self.sources.path)")
        for file in files {
            let text = try String(contentsOf: Self.sources.appendingPathComponent(file), encoding: .utf8)
            for violation in try Self.violations(in: text) {
                Issue.record("\(file) contains \(violation)")
            }
        }
    }

    @Test func coreImportsNoAppleOnlyFramework() throws {
        let core = Self.sources.appendingPathComponent("FieldbookCore")
        let appleOnly = try Regex(#"import\s+(UIKit|AppKit|SwiftUI|MetricKit|OSLog|CoreMotion)\b"#)
        for file in try Self.swiftFiles(in: core) {
            let text = try String(contentsOf: core.appendingPathComponent(file), encoding: .utf8)
            #expect(!text.contains(appleOnly), "FieldbookCore/\(file) imports an Apple-only framework")
        }
    }

    /// A FieldbookKit file that imports an Apple-only framework starts with `#if … canImport(…)`,
    /// so the package still builds on Linux.
    @Test func kitCodeForApplePlatformsSitsBehindCanImport() throws {
        let kit = Self.sources.appendingPathComponent("FieldbookKit")
        let appleImport = try Regex(#"import\s+(UIKit|AppKit|MetricKit|OSLog|CoreMotion|Darwin)\b"#)
        for file in try Self.swiftFiles(in: kit) {
            let text = try String(contentsOf: kit.appendingPathComponent(file), encoding: .utf8)
            guard text.contains(appleImport) else { continue }
            let firstLine = text.prefix { $0 != "\n" }
            #expect(
                firstLine.hasPrefix("#if ") && firstLine.contains("canImport("),
                "FieldbookKit/\(file) imports an Apple-only framework outside #if canImport(…)"
            )
        }
    }

    @Test func theScanFindsBannedSamples() throws {
        let sample = """
            final class Box: @unchecked Sendable {}
            let task = URLSession.shared
            MainActor.assumeIsolated { }
            method_exchangeImplementations(a, b)
            let value = object.value(forKey: "_secret")
            """
        #expect(try Self.violations(in: sample).count == 5)
        #expect(try Self.violations(in: "let name = \"Fieldbook\"\nfunc start() {}").isEmpty)
    }
}
