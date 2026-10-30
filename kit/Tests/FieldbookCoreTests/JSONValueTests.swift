import Foundation
import Testing
@testable import FieldbookCore

struct JSONValueTests {
    @Test func literalsBuildValues() {
        let value: JSONValue = ["page": 12, "selectedNote": "n3", "flags": [true, nil, 1.5]]
        #expect(value["page"] == .number(12))
        #expect(value["selectedNote"] == .string("n3"))
        #expect(value["flags"] == .array([.bool(true), .null, .number(1.5)]))
    }

    @Test func roundTripsThroughJSON() throws {
        let value: JSONValue = ["a": [1, 2], "b": ["c": false], "d": nil]
        let data = try FieldbookJSON.encoder().encode(value)
        #expect(String(decoding: data, as: UTF8.self) == #"{"a":[1,2],"b":{"c":false},"d":null}"#)
        #expect(try FieldbookJSON.decoder().decode(JSONValue.self, from: data) == value)
    }

    @Test func numbersJSONCannotHoldAreWrittenAsNull() throws {
        let value: JSONValue = [.number(.nan), .number(.infinity), .number(-Double.infinity), 1]
        let data = try FieldbookJSON.encoder().encode(value)
        #expect(String(decoding: data, as: UTF8.self) == "[null,null,null,1]")
    }

    @Test func runTimeValuesBecomeJSONValues() {
        let page = 12
        let zoom = 1.5
        let selected: String? = "n3"
        let nothing: String? = nil
        let value: JSONValue = [
            "page": .init(page),
            "zoom": .init(zoom),
            "pinned": .init(true),
            "selected": .init(selected),
            "missing": .init(nothing),
            "tags": .init(["garden", "spring"]),
            "counts": .init(["notes": 5, "pinned": 2]),
        ]
        #expect(value["page"] == .number(12))
        #expect(value["zoom"] == .number(1.5))
        #expect(value["pinned"] == .bool(true))
        #expect(value["selected"] == .string("n3"))
        #expect(value["missing"] == .null)
        #expect(value["tags"] == .array([.string("garden"), .string("spring")]))
        #expect(value["counts"] == .object(["notes": .number(5), "pinned": .number(2)]))
    }
}
