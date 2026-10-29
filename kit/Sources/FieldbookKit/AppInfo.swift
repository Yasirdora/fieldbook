#if canImport(UIKit) || canImport(AppKit)
import Darwin
import Foundation
import FieldbookCore

/// Facts about the app, the device and this process, for hello.json.
struct AppInfo: Sendable {
    let bundleId: String
    let appName: String
    let executable: String
    let appVersion: String
    let appBuild: String
    let commit: String?
    let deviceModel: String
    let platform: String
    let isSimulator: Bool
    let osVersion: String
    let pid: Int
    /// nil when the system did not say.
    let processStart: Date?
    /// True when the app runs in an App Sandbox container (always on iOS).
    let isSandboxed: Bool

    static func current() -> AppInfo {
        let bundle = Bundle.main
        let executable = infoString(bundle, "CFBundleExecutable") ?? ProcessInfo.processInfo.processName
        return AppInfo(
            bundleId: bundle.bundleIdentifier ?? executable,
            appName: infoString(bundle, "CFBundleDisplayName") ?? infoString(bundle, "CFBundleName") ?? executable,
            executable: executable,
            appVersion: infoString(bundle, "CFBundleShortVersionString") ?? "",
            appBuild: infoString(bundle, "CFBundleVersion") ?? "",
            commit: infoString(bundle, "FieldbookCommit"),
            deviceModel: currentDeviceModel(),
            platform: currentPlatform,
            isSimulator: runsInSimulator,
            osVersion: currentOSVersion(),
            pid: Int(ProcessInfo.processInfo.processIdentifier),
            processStart: processStartTime(),
            isSandboxed: runsInSandbox()
        )
    }

    func hello(runId: String, redaction: Redaction, hangThresholdMs: Int, now: Date) -> Hello {
        Hello(
            runId: runId,
            bundleId: bundleId,
            appName: appName,
            executable: executable,
            appVersion: appVersion,
            appBuild: appBuild,
            commit: commit,
            deviceModel: deviceModel,
            platform: platform,
            isSimulator: isSimulator,
            osVersion: osVersion,
            pid: pid,
            processStart: processStart ?? now,
            redaction: redaction.mode,
            hangThresholdMs: hangThresholdMs,
            writtenAt: now
        )
    }

    // MARK: Values

    private static func infoString(_ bundle: Bundle, _ key: String) -> String? {
        bundle.object(forInfoDictionaryKey: key) as? String
    }

    #if os(macOS)
    private static let currentPlatform = "macOS"
    #else
    private static let currentPlatform = "iOS"
    #endif

    #if targetEnvironment(simulator)
    private static let runsInSimulator = true
    #else
    private static let runsInSimulator = false
    #endif

    /// For example "iPhone17,1" or "Mac15,3". The simulator names the device it pretends to be.
    private static func currentDeviceModel() -> String {
        #if os(macOS)
        return sysctlString("hw.model") ?? "unknown"
        #elseif targetEnvironment(simulator)
        return ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"] ?? "unknown"
        #else
        return sysctlString("hw.machine") ?? "unknown"
        #endif
    }

    /// "27.0.1", or "27.0" when there is no third number.
    private static func currentOSVersion() -> String {
        let version = ProcessInfo.processInfo.operatingSystemVersion
        let base = "\(version.majorVersion).\(version.minorVersion)"
        return version.patchVersion > 0 ? "\(base).\(version.patchVersion)" : base
    }

    private static func runsInSandbox() -> Bool {
        #if os(macOS)
        return ProcessInfo.processInfo.environment["APP_SANDBOX_CONTAINER_ID"] != nil
        #else
        return true
        #endif
    }

    // MARK: sysctl

    /// A text value from sysctl, for example "hw.machine".
    private static func sysctlString(_ name: String) -> String? {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return nil }
        var buffer = [UInt8](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return nil }
        let bytes = buffer.prefix { $0 != 0 }
        return String(decoding: bytes, as: UTF8.self)
    }

    /// When the kernel started this process (`kinfo_proc.kp_proc.p_starttime`).
    private static func processStartTime() -> Date? {
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, getpid()]
        let mibCount = u_int(mib.count)
        var info = kinfo_proc()
        var size = MemoryLayout<kinfo_proc>.stride
        guard sysctl(&mib, mibCount, &info, &size, nil, 0) == 0, size > 0 else { return nil }
        // In C, p_starttime is a macro for this union member.
        let start = info.kp_proc.p_un.__p_starttime
        return Date(timeIntervalSince1970: TimeInterval(start.tv_sec) + TimeInterval(start.tv_usec) / 1_000_000)
    }
}
#endif
