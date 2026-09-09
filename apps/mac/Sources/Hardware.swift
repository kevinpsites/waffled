import Foundation
import IOKit.ps

/// What this Mac is, for the one question the first-run window asks about the machine:
/// a laptop sleeps when its lid closes, and a sleeping laptop is a server that has gone
/// off the network for everyone in the house (plan §5).
enum Hardware {
    /// Two readings, one rule, no I/O — so the table is a test rather than a belief.
    ///
    /// The battery is the load-bearing half: Apple Silicon laptops report models like
    /// `Mac14,7`, with no "MacBook" anywhere in the string, so matching the name alone
    /// would wave a MacBook Pro through. The name is kept as the other half because a
    /// power-source snapshot that comes back empty is not evidence of a desktop.
    static func isPortable(model: String, hasInternalBattery: Bool) -> Bool {
        hasInternalBattery || model.contains("MacBook")
    }

    static func isPortable(_ probe: HardwareProbe) -> Bool {
        isPortable(model: probe.model, hasInternalBattery: probe.hasInternalBattery)
    }
}

/// The seam the tests use: two readings, taken once at launch, so nothing below the rule
/// has to run inside a test.
protocol HardwareProbe {
    var model: String { get }
    var hasInternalBattery: Bool { get }
}

/// The real Mac. Both readings are cheap, and both are taken exactly once — the answer
/// cannot change while the app is running.
struct SystemHardware: HardwareProbe {
    let model: String
    let hasInternalBattery: Bool

    init() {
        model = Self.sysctlString("hw.model")
        hasInternalBattery = Self.internalBatteryPresent()
    }

    private static func sysctlString(_ name: String) -> String {
        var size = 0
        guard sysctlbyname(name, nil, &size, nil, 0) == 0, size > 0 else { return "" }
        var buffer = [CChar](repeating: 0, count: size)
        guard sysctlbyname(name, &buffer, &size, nil, 0) == 0 else { return "" }
        return String(cString: buffer)
    }

    /// An *internal* battery, specifically: a UPS or a Bluetooth mouse is a power source
    /// too, and neither makes a Mac mini fall asleep when something closes.
    private static func internalBatteryPresent() -> Bool {
        guard let snapshot = IOPSCopyPowerSourcesInfo()?.takeRetainedValue(),
              let sources = IOPSCopyPowerSourcesList(snapshot)?.takeRetainedValue() as? [CFTypeRef]
        else { return false }

        return sources.contains { source in
            let description = IOPSGetPowerSourceDescription(snapshot, source)?
                .takeUnretainedValue() as? [String: Any]
            return description?[kIOPSTypeKey] as? String == kIOPSInternalBatteryType
        }
    }
}
