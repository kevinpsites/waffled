import SwiftUI
import UIKit

/// Which Waffled experience this device runs.
///
/// The product split is **per device**, not per window size: the iPhone is the
/// personal *planner* (the existing tab-based companion app); the iPad is the
/// family *display / kiosk* (a wall- or counter-mounted hub viewed from across the
/// room). So we branch on `userInterfaceIdiom`, not size class — see
/// `apps/ios/IPAD_ROADMAP.md`.
// TEMPORARY: comment-only touch to verify the Xcode Cloud pull-request start
// condition fires on apps/ios changes. This PR is a throwaway — do not merge.
// (second push, to generate a PR synchronize event carrying an apps/ios diff)
enum DeviceExperience {
    /// iPhone — the existing planner with the bottom tab bar + capture FAB.
    case planner
    /// iPad — the wall/counter family display (Phase 2+ fills this in).
    case kiosk

    static var current: DeviceExperience {
        UIDevice.current.userInterfaceIdiom == .pad ? .kiosk : .planner
    }
}
