import Foundation
import FieldbookCore

/// The app's state providers, by name. A snapshot calls each one and writes state.json.
@MainActor
final class StateProviders {
    private var providers: [String: Fieldbook.StateProvider] = [:]

    func set(_ name: String, _ provider: @escaping Fieldbook.StateProvider) {
        providers[name] = provider
    }

    func remove(_ name: String) {
        providers[name] = nil
    }

    /// Calls every provider. A provider that throws gets a problem entry instead of a value.
    func dump(at time: Date) -> StateDump {
        var values: [String: JSONValue] = [:]
        var problems: [String: String] = [:]
        for (name, provider) in providers {
            do {
                values[name] = try provider()
            } catch {
                problems[name] = String(describing: error)
            }
        }
        return StateDump(time: time, providers: values, problems: problems)
    }
}
