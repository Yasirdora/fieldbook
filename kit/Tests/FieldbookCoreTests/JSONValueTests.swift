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
}
