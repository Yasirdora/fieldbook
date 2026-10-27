import SwiftUI

/// The main window: the note list on one side, the chosen note on the other.
struct ContentView: View {
    @Bindable var model: NotesModel
    let tools: TestTools

    var body: some View {
        NavigationSplitView {
            NoteListView(model: model, tools: tools)
        } detail: {
            if let note = model.selectedNote {
                NoteDetailView(note: note, model: model)
            } else {
                ContentUnavailableView(
                    "No note selected",
                    systemImage: "note.text",
                    description: Text("Pick a note from the list.")
                )
            }
        }
        .sheet(isPresented: $model.isSheetShown) {
            InfoSheet(noteCount: model.notes.count, pinnedCount: model.pinnedCount)
        }
    }
}
