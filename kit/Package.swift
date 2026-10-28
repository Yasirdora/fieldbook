// swift-tools-version: 6.2
import PackageDescription

// FieldbookCore: the formats and the mailbox. Platform-neutral; builds on Linux.
// FieldbookKit (the in-app probe: UIKit on iOS, AppKit on macOS, Debug builds only) joins this
// package in the same change that adds its first source file. SwiftPM refuses a target without sources.
let package = Package(
    name: "FieldbookKit",
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "FieldbookCore", targets: ["FieldbookCore"]),
    ],
    targets: [
        .target(name: "FieldbookCore"),
        .testTarget(name: "FieldbookCoreTests", dependencies: ["FieldbookCore"]),
    ],
    swiftLanguageModes: [.v6]
)
