import Foundation

/// hello.json: who the app is, written once at each launch.
public struct Hello: Codable, Sendable, Equatable {
    public var formatVersion: Int
    public var probeVersion: String
    public var runId: String
    public var bundleId: String
    public var appName: String
    public var executable: String
    public var appVersion: String
    public var appBuild: String
    /// From the Info.plist key `FieldbookCommit`, if the app has one.
    public var commit: String?
    public var deviceModel: String
    public var platform: String
    public var isSimulator: Bool
    public var osVersion: String
    public var pid: Int
    public var processStart: Date
    public var redaction: Redaction.Mode
    public var hangThresholdMs: Int
    public var writtenAt: Date

    public init(
        runId: String,
        bundleId: String,
        appName: String,
        executable: String,
        appVersion: String,
        appBuild: String,
        commit: String?,
        deviceModel: String,
        platform: String,
        isSimulator: Bool,
        osVersion: String,
        pid: Int,
        processStart: Date,
        redaction: Redaction.Mode,
        hangThresholdMs: Int,
        writtenAt: Date
    ) {
        self.formatVersion = FieldbookFormat.version
        self.probeVersion = FieldbookFormat.probeVersion
        self.runId = runId
        self.bundleId = bundleId
        self.appName = appName
        self.executable = executable
        self.appVersion = appVersion
        self.appBuild = appBuild
        self.commit = commit
        self.deviceModel = deviceModel
        self.platform = platform
        self.isSimulator = isSimulator
        self.osVersion = osVersion
        self.pid = pid
        self.processStart = processStart
        self.redaction = redaction
        self.hangThresholdMs = hangThresholdMs
        self.writtenAt = writtenAt
    }

    /// Writes every key. `commit` is written as null when the app has none, as docs/FORMAT.md asks.
    public func encode(to encoder: any Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(formatVersion, forKey: .formatVersion)
        try container.encode(probeVersion, forKey: .probeVersion)
        try container.encode(runId, forKey: .runId)
        try container.encode(bundleId, forKey: .bundleId)
        try container.encode(appName, forKey: .appName)
        try container.encode(executable, forKey: .executable)
        try container.encode(appVersion, forKey: .appVersion)
        try container.encode(appBuild, forKey: .appBuild)
        try container.encode(commit, forKey: .commit)
        try container.encode(deviceModel, forKey: .deviceModel)
        try container.encode(platform, forKey: .platform)
        try container.encode(isSimulator, forKey: .isSimulator)
        try container.encode(osVersion, forKey: .osVersion)
        try container.encode(pid, forKey: .pid)
        try container.encode(processStart, forKey: .processStart)
        try container.encode(redaction, forKey: .redaction)
        try container.encode(hangThresholdMs, forKey: .hangThresholdMs)
        try container.encode(writtenAt, forKey: .writtenAt)
    }
}
