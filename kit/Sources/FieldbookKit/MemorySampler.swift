#if canImport(UIKit) || canImport(AppKit)
import Darwin

/// Reads the memory footprint of this process: `phys_footprint`, the number Xcode's memory gauge
/// and the system's memory limit use.
enum MemorySampler {
    /// The port of this task. `task_self_trap()` gives the same port as C's `mach_task_self()`,
    /// which Swift cannot call (it is a macro over a global variable). Read once and kept.
    private static let taskPort = task_self_trap()

    /// Bytes, or nil when the kernel did not answer.
    static func footprint() -> UInt64? {
        var info = task_vm_info_data_t()
        var count = mach_msg_type_number_t(MemoryLayout<task_vm_info_data_t>.size / MemoryLayout<natural_t>.size)
        let result = withUnsafeMutablePointer(to: &info) { pointer in
            pointer.withMemoryRebound(to: integer_t.self, capacity: Int(count)) { raw in
                task_info(taskPort, task_flavor_t(TASK_VM_INFO), raw, &count)
            }
        }
        guard result == KERN_SUCCESS else { return nil }
        return info.phys_footprint
    }
}
#endif
