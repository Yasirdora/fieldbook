import SwiftUI
#if DEBUG
import FieldbookCore
import FieldbookKit
#endif

/// Sparrowpad: a few made-up notes and some buttons to test the debug kit.
@main
struct SparrowpadApp: App {
    @State private var model: NotesModel
    @State private var tools: TestTools

    init() {
        let model = NotesModel()
        let tools = TestTools()
        _model = State(initialValue: model)
        _tools = State(initialValue: tools)

        #if DEBUG
        // Debug builds only. Release builds do not contain the kit at all.
        Fieldbook.start()
        // The model and the tools live as long as the app, so keeping them here is fine.
        Fieldbook.state("editor") {
            [
                "selectedNote": model.selectedNoteID.map(JSONValue.string) ?? .null,
                "noteCount": .number(Double(model.notes.count)),
                "pinnedCount": .number(Double(model.pinnedCount)),
                "sheetShown": .bool(model.isSheetShown),
                "keptMegabytes": .number(Double(tools.keptMegabytes)),
            ]
        }
        #endif
    }

    var body: some Scene {
        WindowGroup {
            ContentView(model: model, tools: tools)
        }
    }
}
