import Foundation

/// Paths to the shared format fixtures in `fixtures/format-v1/` at the repository root.
/// The TypeScript tests read the same files.
enum Fixtures {
    static let root: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent() // FieldbookCoreTests
        .deletingLastPathComponent() // Tests
        .deletingLastPathComponent() // kit
        .deletingLastPathComponent() // repository root
        .appendingPathComponent("fixtures/format-v1")

    static func data(_ relativePath: String) throws -> Data {
        try Data(contentsOf: root.appendingPathComponent(relativePath))
    }

    /// A fresh, empty temporary folder for one test.
    static func temporaryFolder() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("fieldbook-tests-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
}
