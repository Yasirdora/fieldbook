import Foundation
import Testing
@testable import FieldbookCore

struct RedactionTests {
    private struct Vectors: Decodable {
        struct Vector: Decodable {
            let text: String
            let length: Int
            let sha256_8: String
        }
        let vectors: [Vector]
    }

    @Test func sha256MatchesKnownAnswers() {
        #expect(SHA256.hex("") == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
        #expect(SHA256.hex("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad")
        #expect(
            SHA256.hex("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq")
                == "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        )
    }

    @Test func hashedModeKeepsOnlyLengthAndFingerprint() throws {
        let vectors = try JSONDecoder().decode(Vectors.self, from: Fixtures.data("redaction-vectors.json"))
        let redaction = Redaction(mode: .hashed)
        for vector in vectors.vectors {
            let redacted = redaction.redact(vector.text)
            #expect(redacted.length == vector.length)
            #expect(redacted.sha256_8 == vector.sha256_8)
            #expect(redacted.text == nil)
        }
    }

    @Test func fullModeAlsoKeepsTheText() {
        let redacted = Redaction(mode: .full).redact("Pinned")
        #expect(redacted.text == "Pinned")
        #expect(redacted.sha256_8 == "f20c8794")
        #expect(redacted.length == 6)
    }

    @Test func fullTextNeedsTheLaunchArgument() {
        #expect(Redaction.fromArguments(["Demo", "-FieldbookText", "full"]).mode == .full)
        #expect(Redaction.fromArguments(["Demo"]).mode == .hashed)
        #expect(Redaction.fromArguments(["Demo", "-FieldbookText"]).mode == .hashed)
        #expect(Redaction.fromArguments(["Demo", "-FieldbookText", "FULL"]).mode == .hashed)
    }

    @Test func hashedTextEncodesWithoutTheText() throws {
        let data = try FieldbookJSON.encoder().encode(Redaction(mode: .hashed).redact("Garden plan"))
        let json = String(decoding: data, as: UTF8.self)
        #expect(json == #"{"length":11,"sha256_8":"81602ebb"}"#)
    }

    @Test func logMessagesAreCutAt500Characters() {
        let long = String(repeating: "a", count: 600)
        let cut = Redaction.cutLog(long)
        #expect(cut.text.count == 500)
        #expect(cut.cut)
        let short = Redaction.cutLog("Loaded 3 notes")
        #expect(short.text == "Loaded 3 notes")
        #expect(!short.cut)
    }
}
