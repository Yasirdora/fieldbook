import Foundation
import Observation

/// The notes and what the screen shows right now. It lives as long as the app.
@MainActor
@Observable
final class NotesModel {
    var notes: [Note] = Note.samples
    var selectedNoteID: Note.ID?
    var isSheetShown = false

    var selectedNote: Note? {
        notes.first { $0.id == selectedNoteID }
    }

    var pinnedCount: Int {
        notes.filter { $0.isPinned }.count
    }

    func togglePin(of id: Note.ID) {
        guard let index = notes.firstIndex(where: { $0.id == id }) else { return }
        notes[index].isPinned.toggle()
    }
}
