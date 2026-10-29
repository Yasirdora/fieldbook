#if (canImport(UIKit) || canImport(AppKit)) && canImport(MetricKit)
import Foundation
import MetricKit

/// Receives MetricKit payloads and passes each one on as JSON data, with its type
/// ("metrics" or "diagnostics"). MetricKit calls it on a background thread.
final class MetricKitSubscriber: NSObject, MXMetricManagerSubscriber, Sendable {
    private let deliver: @Sendable (Data, String) -> Void

    init(deliver: @escaping @Sendable (Data, String) -> Void) {
        self.deliver = deliver
        super.init()
    }

    func didReceive(_ payloads: [MXMetricPayload]) {
        for payload in payloads {
            deliver(payload.jsonRepresentation(), "metrics")
        }
    }

    func didReceive(_ payloads: [MXDiagnosticPayload]) {
        for payload in payloads {
            deliver(payload.jsonRepresentation(), "diagnostics")
        }
    }
}
#endif
