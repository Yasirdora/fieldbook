import SwiftUI

/// A small sheet about the app to test presentation over an active view.
struct InfoSheet: View {
    let noteCount: Int
    let pinnedCount: Int
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Form {
                Text("Sparrowpad is a small demo app. Every note in it is made up.")
                    .accessibilityIdentifier("sheetMessage")
                LabeledContent("Notes", value: "\(noteCount)")
                LabeledContent("Pinned", value: "\(pinnedCount)")
            }
            .formStyle(.grouped)
            .navigationTitle("About")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") {
                        dismiss()
                    }
                    .accessibilityIdentifier("sheetDoneButton")
                }
            }
        }
        .frame(minWidth: 320, minHeight: 260)
    }
}
