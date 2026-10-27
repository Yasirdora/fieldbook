import Foundation

/// One made-up note.
struct Note: Identifiable, Hashable, Sendable {
    let id: String
    var title: String
    var body: String
    var isPinned: Bool
}

extension Note {
    /// The notes the app starts with. All of them are invented.
    static let samples: [Note] = [
        Note(
            id: "n1",
            title: "Garden plan",
            body: "Tomatoes along the south fence. Beans next to the shed. Water every second evening.",
            isPinned: true
        ),
        Note(
            id: "n2",
            title: "Groceries for Sunday",
            body: "Oat milk, two lemons, rye bread and a bag of apples.",
            isPinned: false
        ),
        Note(
            id: "n3",
            title: "Bike repair steps",
            body: "1. Take off the back wheel.\n2. Find the hole in the tube.\n3. Put on a patch and wait five minutes.",
            isPinned: true
        ),
        Note(
            id: "n4",
            title: "Paint for the hallway",
            body: "Soft green or warm grey. Ask the shop for two small test pots.",
            isPinned: false
        ),
        Note(
            id: "n5",
            title: "Ideas for the weekend",
            body: "Walk to the lake. Bake bread. Fix the door that squeaks.",
            isPinned: false
        ),
    ]
}
