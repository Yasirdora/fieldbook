import SwiftUI

/// The list of notes, and below it the test buttons.
struct NoteListView: View {
    @Bindable var model: NotesModel
    let tools: TestTools

    var body: some View {
        List(selection: $model.selectedNoteID) {
            Section("Notes") {
                ForEach(model.notes) { note in
                    NavigationLink(value: note.id) {
                        NoteRow(note: note)
                    }
                    .accessibilityIdentifier("noteRow-\(note.id)")
                }
            }
            TestSection(model: model, tools: tools)
        }
        .navigationTitle("Sparrowpad")
    }
}

/// One line in the note list: title, first words of the text, and a pin when pinned.
struct NoteRow: View {
    let note: Note

    var body: some View {
        HStack {
            VStack(alignment: .leading) {
                Text(note.title)
                    .font(.headline)
                Text(note.body)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if note.isPinned {
                Image(systemName: "pin.fill")
                    .foregroundStyle(.orange)
                    .accessibilityLabel("Pinned")
            }
        }
    }
}

/// Test actions to exercise features of FieldbookKit.
struct TestSection: View {
    let model: NotesModel
    let tools: TestTools

    var body: some View {
        Section("Tests") {
            Button("Show a sheet", systemImage: "info.circle") {
                model.isSheetShown = true
            }
            .accessibilityIdentifier("showSheetButton")

            Button("Freeze 400 ms", systemImage: "tortoise") {
                tools.freezeMainThread()
            }
            .accessibilityIdentifier("freezeButton")

            Button("Use 50 MB", systemImage: "memorychip") {
                tools.useMemory()
            }
            .accessibilityIdentifier("useMemoryButton")

            Button("Free memory", systemImage: "trash") {
                tools.freeMemory()
            }
            .disabled(tools.keptMegabytes == 0)
            .accessibilityIdentifier("freeMemoryButton")

            LabeledContent("Memory kept", value: "\(tools.keptMegabytes) MB")
                .accessibilityIdentifier("keptMemoryLabel")

            Button("Log an error", systemImage: "exclamationmark.bubble") {
                tools.logError()
            }
            .accessibilityIdentifier("logErrorButton")

            #if DEBUG
            Button(role: .destructive) {
                tools.crash()
            } label: {
                Label("Crash", systemImage: "exclamationmark.octagon")
            }
            .accessibilityIdentifier("crashButton")
            #endif
        }
    }
}
