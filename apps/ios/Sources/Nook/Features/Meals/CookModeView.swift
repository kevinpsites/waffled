import SwiftUI

/// Full-screen, step-by-step cook mode — big type for across-the-kitchen reading,
/// a progress bar, the current step's ingredients, and a finish button that marks
/// the recipe cooked. Keeps the screen awake while you cook. Mirrors the kiosk
/// `CookMode`.
struct CookModeView: View {
    let title: String
    let steps: [NookAPI.RecipeStepDTO]
    let ingredients: [NookAPI.RecipeIngredientDTO]
    /// Called when the cook taps "Finish & mark cooked" on the last step.
    let onFinish: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var index = 0
    @State private var showAllIngredients = false

    private var step: NookAPI.RecipeStepDTO? { steps.indices.contains(index) ? steps[index] : nil }
    private var isLast: Bool { index >= steps.count - 1 }
    private var progress: Double { steps.isEmpty ? 0 : Double(index + 1) / Double(steps.count) }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ProgressView(value: progress).tint(NK.primary).padding(.horizontal, 20)

            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    Text("STEP \(step?.stepNumber ?? index + 1) OF \(steps.count)")
                        .font(.system(size: 13, weight: .heavy)).tracking(1.2)
                        .foregroundStyle(Color(hex: 0x167A4A))
                    Text(step?.instruction ?? "")
                        .font(NK.serif(30, .semibold)).foregroundStyle(NK.ink)
                        .fixedSize(horizontal: false, vertical: true)
                    if let igs = step?.ingredients, !igs.isEmpty {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(igs, id: \.self) { ig in
                                Text(ig).font(.system(size: 15, weight: .medium))
                                    .foregroundStyle(Color(hex: 0x167A4A))
                                    .padding(.horizontal, 12).padding(.vertical, 7)
                                    .background(Color(hex: 0x167A4A).opacity(0.12))
                                    .clipShape(Capsule())
                            }
                        }
                    }
                    if let note = step?.note {
                        Text("📝 \(note)").font(.system(size: 16)).foregroundStyle(NK.ink2)
                            .padding(12).frame(maxWidth: .infinity, alignment: .leading)
                            .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(24)
            }

            navBar
        }
        .background(NK.canvas)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .sheet(isPresented: $showAllIngredients) { allIngredientsSheet }
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink2)
            }
            Spacer()
            Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
            Spacer()
            Button { showAllIngredients = true } label: {
                Image(systemName: "list.bullet").font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink2)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 12)
    }

    private var navBar: some View {
        HStack(spacing: 12) {
            Button { withAnimation { index = max(0, index - 1) } } label: {
                Text("Back").font(.system(size: 16, weight: .semibold)).foregroundStyle(NK.ink2)
                    .frame(maxWidth: .infinity).padding(.vertical, 15)
                    .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
            }
            .buttonStyle(.plain).opacity(index == 0 ? 0.4 : 1).disabled(index == 0)

            if isLast {
                Button { onFinish(); dismiss() } label: {
                    Text("✓ Finish & mark cooked").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(NK.primary).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
            } else {
                Button { withAnimation { index = min(steps.count - 1, index + 1) } } label: {
                    Text("Next").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 15)
                        .background(NK.ink).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 20).padding(.top, 8).padding(.bottom, 16)
    }

    private var allIngredientsSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    ForEach(ingredients) { ing in
                        HStack(alignment: .top, spacing: 12) {
                            Text(amountText(ing)).font(.system(size: 15, weight: .semibold, design: .rounded))
                                .foregroundStyle(NK.ink2).frame(width: 70, alignment: .trailing)
                            Text(ing.sub ?? ing.name).font(.system(size: 16)).foregroundStyle(NK.ink)
                            Spacer(minLength: 0)
                        }
                        .padding(.vertical, 9)
                        if ing.id != ingredients.last?.id { Divider().background(NK.hair) }
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle("All ingredients").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showAllIngredients = false } } }
        }
        .presentationDetents([.medium, .large])
    }

    private func amountText(_ ing: NookAPI.RecipeIngredientDTO) -> String {
        guard let amt = ing.amount else { return "" }
        return RecipeAmount.format(amt) + (ing.unit.map { " \($0)" } ?? "")
    }
}
