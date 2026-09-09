import XCTest
@testable import Waffled

/// A server that sleeps when a lid closes is the one hardware fact the first-run window
/// has to tell someone (plan §5), so the rule is a pure function over two readings and
/// the table is asserted rather than trusted.
final class HardwareTests: XCTestCase {

    func testAPortableIsEitherANamedMacBookOrAnythingWithAnInternalBattery() {
        // The obvious half.
        XCTAssertTrue(Hardware.isPortable(model: "MacBookPro18,3", hasInternalBattery: false),
                      "the name alone is enough — a battery that failed to read is not a desktop")
        // The half that matters: Apple Silicon laptops report models with no "MacBook" in
        // them at all, so the battery is what actually identifies them.
        XCTAssertTrue(Hardware.isPortable(model: "Mac14,7", hasInternalBattery: true))
        XCTAssertTrue(Hardware.isPortable(model: "MacBookAir10,1", hasInternalBattery: true))

        XCTAssertFalse(Hardware.isPortable(model: "Macmini9,1", hasInternalBattery: false))
        XCTAssertFalse(Hardware.isPortable(model: "Mac16,10", hasInternalBattery: false),
                       "a numbered model with no battery is a desktop, and must not be warned about")
        XCTAssertFalse(Hardware.isPortable(model: "iMac21,1", hasInternalBattery: false))
        XCTAssertFalse(Hardware.isPortable(model: "", hasInternalBattery: false),
                       "nothing read at all is not a reason to call a Mac mini a laptop")
    }

    /// The probe is the seam: the window asks it once at launch, and a test hands it
    /// strings and bools instead of an IOKit snapshot.
    func testTheProbeFeedsTheSameRule() {
        struct Laptop: HardwareProbe {
            let model = "Mac14,7"
            let hasInternalBattery = true
        }
        struct Desktop: HardwareProbe {
            let model = "Macmini9,1"
            let hasInternalBattery = false
        }
        XCTAssertTrue(Hardware.isPortable(Laptop()))
        XCTAssertFalse(Hardware.isPortable(Desktop()))
    }

    /// The real readings, on whatever Mac is running the suite. Nothing about the answer
    /// is asserted — only that asking costs nothing and returns something: a `sysctl` name
    /// that had been renamed, or an IOKit snapshot that came back nil, would otherwise
    /// only be discovered on a household's laptop.
    func testTheSystemProbeAnswersOnThisMac() {
        let probe = SystemHardware()
        XCTAssertFalse(probe.model.isEmpty, "hw.model returned nothing on a real Mac")
        _ = probe.hasInternalBattery
    }
}
