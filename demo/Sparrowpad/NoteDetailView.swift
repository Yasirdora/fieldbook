import SwiftUI

/// One note in full, with a badge when it is pinned.
struct NoteDetailView: View {
    let note: Note
    let model: NotesModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if note.isPinned {
                    PinnedBadge()
                }
                Text(note.title)
                    .font(.largeTitle.bold())
                    .accessibilityIdentifier("noteTitle")
                Text(note.body)
                    .accessibilityIdentifier("noteBody")
                Button {
                    model.togglePin(of: note.id)
                } label: {
                    Label(note.isPinned ? "Unpin" : "Pin", systemImage: note.isPinned ? "pin.slash" : "pin")
                }
                .buttonStyle(.bordered)
                .accessibilityIdentifier("pinButton")
            }
            .padding()
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .navigationTitle(note.title)
    }
}

/// A small "Pinned" label. Its accessibility identifier is `pinnedBadge`.
struct PinnedBadge: View {
    var body: some View {
        Label("Pinned", systemImage: "pin.fill")
            .font(.caption.bold())
            .padding(.horizontal, 10)
            .padding(.vertical, 4)
            .background(Color.orange.opacity(0.2), in: Capsule())
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("pinnedBadge")
    }
}
