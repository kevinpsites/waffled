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
    @State private var showOverview = false

    private var step: NookAPI.RecipeStepDTO? { steps.indices.contains(index) ? steps[index] : nil }
    private var isLast: Bool { index >= steps.count - 1 }
    private var progress: Double { steps.isEmpty ? 0 : Double(index + 1) / Double(steps.count) }
    private var isKiosk: Bool { DeviceExperience.current == .kiosk }
    /// Big across-the-kitchen type — larger on the iPad wall display than the phone.
    private var instructionSize: CGFloat { isKiosk ? 56 : 38 }

    var body: some View {
        VStack(spacing: 0) {
            topBar
            ProgressView(value: progress).tint(NK.primary).padding(.horizontal, 20)

            // The current step, centered in the available space — but scrollable so a
            // long step is never clipped (short steps sit dead-center; long ones scroll).
            GeometryReader { geo in
                ScrollView {
                    VStack(alignment: .center, spacing: 24) {
                        Text("STEP \(step?.stepNumber ?? index + 1) OF \(steps.count)")
                            .font(.system(size: 14, weight: .heavy)).tracking(1.4)
                            .foregroundStyle(Color(hex: 0x167A4A))
                        Text(step?.instruction ?? "")
                            .font(NK.serif(instructionSize, .semibold)).foregroundStyle(NK.ink)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                        if let igs = step?.ingredients, !igs.isEmpty {
                            ChipFlow(spacing: 8, lineSpacing: 8, alignment: .center) {
                                ForEach(igs, id: \.self) { ig in
                                    Text(ig).font(.system(size: isKiosk ? 18 : 15, weight: .medium))
                                        .foregroundStyle(Color(hex: 0x167A4A))
                                        .padding(.horizontal, 12).padding(.vertical, 7)
                                        .background(Color(hex: 0x167A4A).opacity(0.12))
                                        .clipShape(Capsule())
                                }
                            }
                        }
                        if let note = step?.note {
                            Text("📝 \(note)").font(.system(size: isKiosk ? 19 : 16)).foregroundStyle(NK.ink2)
                                .multilineTextAlignment(.center)
                                .padding(14).frame(maxWidth: .infinity)
                                .background(NK.panel).clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                        }
                    }
                    .frame(maxWidth: 720)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 28).padding(.vertical, 24)
                    // Center vertically when the step is short; grow (and scroll) when long.
                    .frame(minHeight: geo.size.height, alignment: .center)
                }
            }

            navBar
        }
        .background(NK.canvas)
        .onAppear { UIApplication.shared.isIdleTimerDisabled = true }
        .onDisappear { UIApplication.shared.isIdleTimerDisabled = false }
        .sheet(isPresented: $showOverview) { allIngredientsSheet }
    }

    private var topBar: some View {
        HStack {
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 16, weight: .bold)).foregroundStyle(NK.ink2)
            }
            Spacer()
            Text(title).font(.system(size: 15, weight: .bold)).foregroundStyle(NK.ink).lineLimit(1)
            Spacer()
            Button { showOverview = true } label: {
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

    /// The recipe overview: every step (tap to jump to it) and the full ingredient
    /// list, in one large sheet — so the list button is "see the whole recipe", not
    /// just ingredients.
    private var allIngredientsSheet: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 28) {
                    VStack(alignment: .leading, spacing: 10) {
                        sectionLabel("STEPS")
                        ForEach(Array(steps.enumerated()), id: \.element.id) { i, st in
                            Button {
                                withAnimation { index = i }
                                showOverview = false
                            } label: { overviewStepRow(i, st) }
                            .buttonStyle(.plain)
                            if st.id != steps.last?.id { Divider().background(NK.hair) }
                        }
                    }
                    if !ingredients.isEmpty {
                        VStack(alignment: .leading, spacing: 8) {
                            sectionLabel("INGREDIENTS")
                            ForEach(ingredients) { ing in
                                HStack(alignment: .top, spacing: 12) {
                                    Text(amountText(ing)).font(.system(size: 15, weight: .semibold, design: .rounded))
                                        .foregroundStyle(NK.ink2).frame(width: 70, alignment: .trailing)
                                    Text(ing.sub ?? ing.name).font(.system(size: 16)).foregroundStyle(NK.ink)
                                    Spacer(minLength: 0)
                                }
                                .padding(.vertical, 8)
                                if ing.id != ingredients.last?.id { Divider().background(NK.hair) }
                            }
                        }
                    }
                }
                .padding(20)
            }
            .background(NK.canvas)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .confirmationAction) { Button("Done") { showOverview = false } } }
        }
        .presentationDetents([.large])
    }

    private func sectionLabel(_ text: String) -> some View {
        Text(text).font(.system(size: 12, weight: .heavy)).tracking(1.2).foregroundStyle(NK.ink3)
    }

    /// A tappable step row in the overview — number badge, the (current-highlighted)
    /// instruction, and a chevron. Tapping jumps Cook Mode to that step.
    private func overviewStepRow(_ i: Int, _ st: NookAPI.RecipeStepDTO) -> some View {
        let isCurrent = i == index
        return HStack(alignment: .top, spacing: 12) {
            Text("\(st.stepNumber)")
                .font(.system(size: 14, weight: .heavy)).foregroundStyle(isCurrent ? .white : Color(hex: 0x167A4A))
                .frame(width: 28, height: 28)
                .background(isCurrent ? Color(hex: 0x167A4A) : Color(hex: 0x167A4A).opacity(0.12)).clipShape(Circle())
            Text(st.instruction).font(.system(size: 16, weight: isCurrent ? .semibold : .regular))
                .foregroundStyle(NK.ink).fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            Image(systemName: "chevron.right").font(.system(size: 12, weight: .bold)).foregroundStyle(NK.ink3)
                .padding(.top, 5)
        }
        .padding(.vertical, 8).contentShape(Rectangle())
    }

    private func amountText(_ ing: NookAPI.RecipeIngredientDTO) -> String {
        guard let amt = ing.amount else { return "" }
        return RecipeAmount.format(amt) + (ing.unit.map { " \($0)" } ?? "")
    }
}
