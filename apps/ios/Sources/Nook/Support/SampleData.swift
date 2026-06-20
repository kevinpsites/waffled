import Foundation

// Static, mock-faithful sample data for the Phase 0 scaffold. Mirrors the handoff
// iOS screens (the Hendricks family). Replaced by PowerSync-backed reads in Phase 1.

struct Member: Identifiable {
    let id = UUID()
    let name: String
    let color: FamilyColor
    let emoji: String
    let sub: String       // "Dad" / "★ 31"
    let stars: Int?
}

enum Sample {
    static let members: [Member] = [
        Member(name: "Kevin",  color: .kevin,  emoji: "🐻", sub: "Dad",  stars: nil),
        Member(name: "Kelly",  color: .kelly,  emoji: "🦊", sub: "Mom",  stars: nil),
        Member(name: "Wally",  color: .wally,  emoji: "🐢", sub: "★ 31", stars: 31),
        Member(name: "Lottie", color: .lottie, emoji: "🦄", sub: "★ 24", stars: 24),
    ]
}
