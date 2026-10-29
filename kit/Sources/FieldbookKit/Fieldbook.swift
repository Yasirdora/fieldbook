import Foundation
import FieldbookCore

/// A JSON value. A state provider returns one, for example `["page": 12, "selectedNote": "n3"]`.
/// The app needs to import only FieldbookKit to use it.
public typealias JSONValue = FieldbookCore.JSONValue

/// A Swift value that can become a `JSONValue`: `Int`, `Double`, `Bool`, `String`, optionals,
/// arrays and dictionaries of these. Use it for values known only at run time: `.init(page)`.
public typealias JSONValueConvertible = FieldbookCore.JSONValueConvertible

/// How the kit stores text it finds on screen: `.hashed` (length and fingerprint only) or `.full`.
public typealias RedactionMode = FieldbookCore.Redaction.Mode

/// Settings for `Fieldbook.start`. Every setting has a default.
public struct FieldbookOptions {
    /// `nil` reads the launch arguments: `-FieldbookText full` keeps the text, anything else hashes it.
    public var redaction: RedactionMode?
    /// The main thread must stall at least this long to count as a hang.
    public var hangThresholdMs: Int
    /// Seconds between two memory samples, log reads and inbox reads (only while the app is active).
    public var sampleInterval: TimeInterval
    /// iOS: shaking the device marks a moment.
    public var shakeToMark: Bool
    /// macOS: Control-Option-Command-M marks a moment.
    public var keyToMark: Bool
    /// State providers to add at start. `Fieldbook.state(_:_:)` adds more later.
    public var providers: [String: Fieldbook.StateProvider]

    public init(
        redaction: RedactionMode? = nil,
        hangThresholdMs: Int = 250,
        sampleInterval: TimeInterval = 2,
        shakeToMark: Bool = true,
        keyToMark: Bool = true,
        providers: [String: Fieldbook.StateProvider] = [:]
    ) {
        self.redaction = redaction
        self.hangThresholdMs = hangThresholdMs
        self.sampleInterval = sampleInterval
        self.shakeToMark = shakeToMark
        self.keyToMark = keyToMark
        self.providers = providers
    }
}

/// The debug probe. Link it in Debug builds only, and call `start()` once at launch.
///
/// ```swift
/// #if DEBUG
/// import FieldbookKit
/// Fieldbook.start()
/// Fieldbook.state("editor") { ["page": .init(page), "selectedNote": "n3"] }
/// #endif
/// ```
@MainActor
public enum Fieldbook {
    /// Reports one part of the app's own state. It runs on the main actor at each snapshot.
    /// It may throw: the error is stored in state.json as a problem, and the snapshot goes on.
    public typealias StateProvider = @MainActor () throws -> JSONValue

    static let stateProviders = StateProviders()

    #if canImport(UIKit) || canImport(AppKit)
    private static var probe: Probe?
    #endif

    /// Starts the probe. A second call does nothing.
    public static func start(_ options: FieldbookOptions = FieldbookOptions()) {
        for (name, provider) in options.providers {
            stateProviders.set(name, provider)
        }
        #if canImport(UIKit) || canImport(AppKit)
        guard probe == nil else { return }
        let newProbe = Probe(options: options, providers: stateProviders)
        probe = newProbe
        newProbe.start()
        #endif
    }

    /// Adds or replaces the state provider called `name`. Each snapshot calls it and stores the
    /// result in state.json. Wrap run-time values with `.init(...)`, for example `.init(page)`.
    public static func state(_ name: String, _ provider: @escaping StateProvider) {
        stateProviders.set(name, provider)
    }

    /// Removes the state provider called `name`.
    public static func removeState(_ name: String) {
        stateProviders.remove(name)
    }
}
