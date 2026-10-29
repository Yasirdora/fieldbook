#if canImport(UIKit)
import UIKit

/// The small "What did you see?" sheet after a mark: one text field, Save and Skip.
@MainActor
enum NoteSheet {
    /// Calls `completion` with the typed text after Save, or with nil after Skip.
    /// Does nothing when no screen can show the sheet.
    static func ask(completion: @escaping @MainActor @Sendable (String?) -> Void) {
        guard let presenter = topViewController(), !(presenter is UIAlertController) else { return }
        let alert = UIAlertController(title: "What did you see?", message: nil, preferredStyle: .alert)
        alert.addTextField { field in
            field.placeholder = "A few words"
            field.autocapitalizationType = .sentences
        }
        alert.addAction(UIAlertAction(title: "Skip", style: .cancel) { _ in
            completion(nil)
        })
        alert.addAction(UIAlertAction(title: "Save", style: .default) { [weak alert] _ in
            completion(alert?.textFields?.first?.text)
        })
        presenter.present(alert, animated: true)
    }

    /// The view controller at the top of the key window: the last one presented.
    private static func topViewController() -> UIViewController? {
        var top = AppWindows.key(in: AppWindows.foreground())?.rootViewController
        while let presented = top?.presentedViewController {
            top = presented
        }
        return top
    }
}

#elseif canImport(AppKit)
import AppKit

/// The small "What did you see?" sheet after a mark: one text field, Save and Skip.
@MainActor
enum NoteSheet {
    /// Calls `completion` with the typed text after Save, or with nil after Skip.
    /// Does nothing when no window can show the sheet.
    static func ask(completion: @escaping @MainActor @Sendable (String?) -> Void) {
        guard let window = AppWindows.key(in: AppWindows.foreground()), window.attachedSheet == nil else { return }
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 300, height: 24))
        field.placeholderString = "A few words"
        let alert = NSAlert()
        alert.messageText = "What did you see?"
        alert.addButton(withTitle: "Save")
        alert.addButton(withTitle: "Skip")
        alert.accessoryView = field
        alert.window.initialFirstResponder = field
        alert.beginSheetModal(for: window) { response in
            completion(response == .alertFirstButtonReturn ? field.stringValue : nil)
        }
    }
}
#endif
