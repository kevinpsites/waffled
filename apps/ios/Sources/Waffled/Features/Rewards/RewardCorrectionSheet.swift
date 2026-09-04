import SwiftUI

enum RewardCorrectionValidation {
    static let maxReasonLength = 500

    static func reasonError(_ raw: String) -> String? {
        let length = raw.trimmingCharacters(in: .whitespacesAndNewlines).utf16.count
        if length < 3 { return "Enter a reason with at least 3 characters." }
        if length > maxReasonLength { return "Keep the reason to 500 characters or fewer." }
        return nil
    }

    static func limitedReason(_ raw: String) -> String {
        var result = ""
        for character in raw {
            let next = String(character)
            if result.utf16.count + next.utf16.count > maxReasonLength { break }
            result.append(character)
        }
        return result
    }
}

enum RewardCorrectionTarget: Identifiable {
    case ledger(WaffledAPI.PersonOverview.LedgerEntry)
    case refund(WaffledAPI.PersonOverview.Redemption)

    var id: String {
        switch self {
        case let .ledger(entry): return "ledger-\(entry.id)"
        case let .refund(redemption): return "refund-\(redemption.id)"
        }
    }

    var title: String {
        switch self {
        case let .ledger(entry): return entry.detail ?? entry.reason.replacingOccurrences(of: "_", with: " ")
        case let .refund(redemption): return redemption.title
        }
    }

    var originalAmount: Int {
        switch self {
        case let .ledger(entry): return entry.amount
        case let .refund(redemption): return -redemption.cost
        }
    }

    var isRefund: Bool {
        if case .refund = self { return true }
        return false
    }
}

/// Adult-only correction UI. The server keeps the original ledger row and writes
/// linked compensating entries; this sheet makes that behavior explicit before a
/// balance-changing action is submitted.
struct RewardCorrectionSheet: View {
    private static let maxLedgerAmount = 2_147_483_647
    @Environment(\.dismiss) private var dismiss
    let target: RewardCorrectionTarget
    let onApply: (_ reason: String, _ replacementAmount: Int?, _ idempotencyKey: String) async throws -> Void

    @State private var replaceAmount = false
    @State private var magnitude: String
    @State private var reason = ""
    @State private var saving = false
    @State private var error: String?
    @State private var idempotencyKey = UUID().uuidString

    init(target: RewardCorrectionTarget,
         onApply: @escaping (_ reason: String, _ replacementAmount: Int?, _ idempotencyKey: String) async throws -> Void) {
        self.target = target
        self.onApply = onApply
        _magnitude = State(initialValue: String(abs(target.originalAmount)))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("The original activity stays in the audit trail. Waffled adds a linked compensating entry so the balance and history remain explainable.")
                        .font(.system(size: 13, weight: .medium)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(target.title).font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                        Text("Original amount: \(target.originalAmount >= 0 ? "+" : "")\(target.originalAmount)")
                            .font(.system(size: 12, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(13).background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 12))

                    if !target.isRefund {
                        SectionLabel(text: "Correction")
                        Picker("Correction", selection: $replaceAmount) {
                            Text("Reverse entirely").tag(false)
                            Text("Replace amount").tag(true)
                        }
                        .pickerStyle(.segmented)

                        if replaceAmount {
                            SectionLabel(text: "Correct amount")
                            TextField("Whole-number amount", text: $magnitude)
                                .keyboardType(.numberPad)
                                .textFieldStyle(.roundedBorder)
                            Text("Keep this as a \(target.originalAmount >= 0 ? "credit" : "debit"); use Reverse entirely to remove it.")
                                .font(.system(size: 11.5, weight: .medium)).foregroundStyle(WF.ink3)
                        }
                    }

                    SectionLabel(text: "Reason · required for the audit trail")
                    TextEditor(text: $reason)
                        .frame(minHeight: 90).padding(8)
                        .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(WF.hair))
                        .onChange(of: reason) { _, value in
                            if value.utf16.count > RewardCorrectionValidation.maxReasonLength {
                                reason = RewardCorrectionValidation.limitedReason(value)
                            }
                        }
                    Text("\(reason.utf16.count)/\(RewardCorrectionValidation.maxReasonLength)")
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)

                    if let error {
                        Text(error).font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.primary)
                            .accessibilityLabel("Error: \(error)")
                    }
                }
                .padding(18)
            }
            .background(WF.canvas)
            .navigationTitle(target.isRefund ? "Refund redemption" : "Correct reward history")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() }.disabled(saving) }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Applying…" : target.isRefund ? "Refund" : "Apply") { apply() }
                        .disabled(saving || RewardCorrectionValidation.reasonError(reason) != nil)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func apply() {
        let cleanReason = reason.trimmingCharacters(in: .whitespacesAndNewlines)
        if let reasonError = RewardCorrectionValidation.reasonError(cleanReason) {
            error = reasonError
            return
        }
        var replacement: Int?
        if !target.isRefund, replaceAmount {
            guard let amount = Int(magnitude), amount > 0,
                  amount <= Self.maxLedgerAmount,
                  amount != abs(target.originalAmount) else {
                error = "Enter a different positive whole-number amount up to 2,147,483,647."
                return
            }
            replacement = target.originalAmount < 0 ? -amount : amount
        }
        Task {
            saving = true; error = nil
            do {
                try await onApply(cleanReason, replacement, idempotencyKey)
                saving = false
                dismiss()
            } catch {
                saving = false
                self.error = APIErrorText.message(
                    for: error,
                    fallback: "Couldn’t apply this correction. Please try again."
                )
            }
        }
    }
}
