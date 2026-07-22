import Foundation

/// The Today review banner's count → headline. Shared by the iPhone (`TodayView.reviewCard`)
/// and iPad (`KioskDashboard.reviewBanner`) banners so the wording can't drift between them
/// (it was copy-pasted in both). `nR` = calendar events to log against a goal; `nS` = events
/// that might count toward one.
func reviewRecapTitle(_ nR: Int, _ nS: Int) -> String {
    if nR > 0 && nS > 0 { return "\(nR) to review · \(nS) to link" }
    if nR > 0 { return nR == 1 ? "1 event to log" : "\(nR) events to log" }
    return nS == 1 ? "1 event might count" : "\(nS) events might count"
}
