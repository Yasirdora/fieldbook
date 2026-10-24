import Testing
@testable import FieldbookCore

struct TreeWalkTests {
    /// A fake view: every node has `fanOut` children until `depth` reaches 0.
    private struct FakeView {
        let depth: Int
        let fanOut: Int
        var children: [FakeView] {
            depth == 0 ? [] : Array(repeating: FakeView(depth: depth - 1, fanOut: fanOut), count: fanOut)
        }
    }

    private struct Built {
        let children: [Built]
        var count: Int { 1 + children.reduce(0) { $0 + $1.count } }
    }

    @Test func buildsTheWholeTreeUnderTheLimit() throws {
        var budget = NodeBudget(limit: 5000)
        let tree = try #require(TreeWalk.build(FakeView(depth: 3, fanOut: 3), budget: &budget, children: \.children) { _, kids in
            Built(children: kids)
        })
        #expect(tree.count == 40)
        #expect(budget.used == 40)
        #expect(!budget.truncated)
    }

    @Test func stopsAtTheLimitAndSaysSo() throws {
        var budget = NodeBudget(limit: 5000)
        let tree = try #require(TreeWalk.build(FakeView(depth: 8, fanOut: 4), budget: &budget, children: \.children) { _, kids in
            Built(children: kids)
        })
        #expect(tree.count == 5000)
        #expect(budget.used == 5000)
        #expect(budget.truncated)
    }
}
