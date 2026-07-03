import SwiftUI

/// Pair a **fresh** iPad as a shared family kiosk by entering the one-time code an
/// admin generated on another device (web or phone Settings → "Pair a kiosk"). The
/// counterpart to that admin flow's "enter this code on the new tablet" instruction.
/// Reachable from the iPad login screen and from Display & Kiosk settings.
///
/// On success the device secret is stored, the admin/personal session (if any) is
/// dropped, and `KioskGate` takes over with the profile picker.
struct KioskCodeEntrySheet: View {
    @Environment(KioskMode.self) private var kiosk
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss

    @State private var code = ""
    @State private var label = ""
    @State private var error: String?
    @State private var busy = false
    @FocusState private var focus: Field?
    private enum Field { case code, label }

    private var canSubmit: Bool { !busy && code.trimmingCharacters(in: .whitespaces).count >= 4 }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 22) {
                    header
                    fields
                    if let error {
                        Text(error).font(.system(size: 14, weight: .medium)).foregroundStyle(NK.primary)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    WaffledPrimaryCTA(
                        label: busy ? "Setting up…" : "Set up this iPad",
                        tint: NK.primary, isDisabled: !canSubmit,
                        action: { Task { await submit() } }
                    )
                    Text("Ask an adult to open Waffled → Settings → Display & Kiosk → “Pair a kiosk” to get a code. It’s one-time and expires in about 10 minutes.")
                        .font(.system(size: 12.5)).foregroundStyle(NK.ink3)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
                .padding(24).frame(maxWidth: 480).frame(maxWidth: .infinity)
            }
            .background(NK.canvas)
            .navigationTitle("Shared kiosk").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
        .onAppear { focus = .code }
    }

    private var header: some View {
        VStack(spacing: 10) {
            Text("🖥️").font(.system(size: 52))
            Text("Use this iPad as a family hub")
                .font(.system(size: 22, weight: .bold)).foregroundStyle(NK.ink)
                .multilineTextAlignment(.center)
            Text("Everyone in the household taps their own face to sign in — no shared password.")
                .font(.system(size: 14)).foregroundStyle(NK.ink3)
                .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
        }
        .padding(.top, 8)
    }

    private var fields: some View {
        VStack(spacing: 14) {
            field("Pairing code", text: $code, focusedOn: .code, mono: true, keyboard: .numberPad)
            field("Name this display (optional)", text: $label, focusedOn: .label, mono: false)
        }
    }

    @ViewBuilder
    private func field(_ title: String, text: Binding<String>, focusedOn: Field, mono: Bool, keyboard: UIKeyboardType = .default) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(NK.ink2)
            TextField("", text: text)
                .font(mono ? .system(size: 22, weight: .bold, design: .monospaced) : .system(size: 16))
                .tracking(mono ? 4 : 0)
                .textInputAutocapitalization(mono ? .characters : .words).autocorrectionDisabled()
                .keyboardType(keyboard)
                .focused($focus, equals: focusedOn)
                .padding(14).background(NK.card)
                .clipShape(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous))
                .overlay(RoundedRectangle(cornerRadius: NK.rMD, style: .continuous)
                    .strokeBorder(focus == focusedOn ? NK.primary : NK.hair, lineWidth: focus == focusedOn ? 2 : 1))
        }
    }

    private func submit() async {
        guard canSubmit else { return }
        busy = true; error = nil
        let name = label.trimmingCharacters(in: .whitespaces)
        error = await kiosk.enableViaCode(code.trimmingCharacters(in: .whitespaces),
                                          label: name.isEmpty ? nil : name, sync: sync)
        busy = false
        if error == nil { dismiss() }   // gate flips to the picker
    }
}
