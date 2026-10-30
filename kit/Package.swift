// swift-tools-version: 6.2
import PackageDescription

// FieldbookCore: the formats and the mailbox. Platform-neutral; builds on Linux.
// FieldbookKit: the in-app probe (UIKit on iOS, AppKit on macOS). Link it in Debug builds only.
// On Linux only its platform-neutral files compile; everything else sits behind #if canImport.
let package = Package(
    name: "FieldbookKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "FieldbookCore", targets: ["FieldbookCore"]),
        .library(name: "FieldbookKit", targets: ["FieldbookKit"]),
    ],
    targets: [
        .target(name: "FieldbookCore"),
        .target(name: "FieldbookKit", dependencies: ["FieldbookCore"]),
        .testTarget(name: "FieldbookCoreTests", dependencies: ["FieldbookCore"]),
    ],
    swiftLanguageModes: [.v6]
)
