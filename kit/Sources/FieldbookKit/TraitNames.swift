#if canImport(UIKit)
import UIKit

/// Names for accessibility traits, as the JSON files write them ("button", "selected", …).
@MainActor
enum TraitNames {
    private static let table: [(trait: UIAccessibilityTraits, name: String)] = [
        (.button, "button"),
        (.link, "link"),
        (.header, "header"),
        (.searchField, "searchField"),
        (.image, "image"),
        (.selected, "selected"),
        (.playsSound, "playsSound"),
        (.keyboardKey, "keyboardKey"),
        (.staticText, "staticText"),
        (.summaryElement, "summaryElement"),
        (.notEnabled, "notEnabled"),
        (.updatesFrequently, "updatesFrequently"),
        (.startsMediaSession, "startsMediaSession"),
        (.adjustable, "adjustable"),
        (.allowsDirectInteraction, "allowsDirectInteraction"),
        (.causesPageTurn, "causesPageTurn"),
        (.tabBar, "tabBar"),
        (.toggleButton, "toggleButton"),
    ]

    static func names(of traits: UIAccessibilityTraits) -> [String] {
        table.filter { traits.contains($0.trait) }.map { $0.name }
    }
}

#elseif canImport(AppKit)
import AppKit

/// Names for accessibility roles and states, with the same words UIKit traits use.
@MainActor
enum TraitNames {
    private static let roleNames: [NSAccessibility.Role: String] = [
        .button: "button",
        .popUpButton: "button",
        .menuButton: "button",
        .checkBox: "button",
        .radioButton: "button",
        .link: "link",
        .staticText: "staticText",
        .image: "image",
        .slider: "adjustable",
        .incrementor: "adjustable",
        NSAccessibility.Role(rawValue: "AXHeading"): "header",
    ]

    static func names(of element: any NSAccessibilityProtocol) -> [String] {
        var names: [String] = []
        if let role = element.accessibilityRole(), let name = roleNames[role] {
            names.append(name)
        }
        if element.accessibilitySubrole() == .searchField {
            names.append("searchField")
        }
        if element.isAccessibilitySelected() {
            names.append("selected")
        }
        if !element.isAccessibilityEnabled() {
            names.append("notEnabled")
        }
        return names
    }
}
#endif
