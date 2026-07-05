import SwiftUI

/// Settings → AI & capture: pick which model powers the "Add anything" bar, and an
/// optional model override. API keys live in the server env and never reach the
/// client, so there's no key field — just the provider + model. Mirrors the web.
struct AISettingsView: View {
    @State private var config: WaffledAPI.CaptureConfig?
    @State private var provider = "heuristic"
    @State private var model = ""
    @State private var loading = true
    @State private var saving = false
    @State private var saved = false
    @State private var failed = false

    private let api = WaffledAPI()

    private static let order = ["heuristic", "ollama", "anthropic", "openai"]
    private struct Meta { let label, sub, envHint: String }
    private static let meta: [String: Meta] = [
        "heuristic": Meta(label: "On-device", sub: "Built-in parser — no AI, works offline", envHint: ""),
        "ollama": Meta(label: "Local server (Ollama)", sub: "Private — text stays on your network", envHint: "OLLAMA_HOST"),
        "anthropic": Meta(label: "Claude (Anthropic)", sub: "Most accurate · hosted", envHint: "ANTHROPIC_API_KEY"),
        "openai": Meta(label: "OpenAI / compatible", sub: "Hosted, or a local OpenAI-compatible server", envHint: "OPENAI_API_KEY"),
    ]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if let config {
                    Text("Powers the “Add anything” bar.")
                        .font(.system(size: 13)).foregroundStyle(WF.ink3)

                    VStack(spacing: 8) {
                        ForEach(Self.order, id: \.self) { p in providerCard(p, config) }
                    }

                    if provider != "heuristic" {
                        VStack(alignment: .leading, spacing: 9) {
                            SectionLabel(text: "Model")
                            TextField(config.defaultModels[provider] ?? "default", text: $model)
                                .font(.system(size: 15)).textInputAutocapitalization(.never).autocorrectionDisabled()
                                .padding(.horizontal, 14).padding(.vertical, 12)
                                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                                .onChange(of: model) { _, _ in saved = false }
                            Text("Overrides the server default for this provider.")
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        }
                    }

                    HStack(spacing: 12) {
                        Button { Task { await save() } } label: {
                            Text(saving ? "Saving…" : "Save").font(.system(size: 16, weight: .bold)).foregroundStyle(.white)
                                .padding(.horizontal, 28).padding(.vertical, 12)
                                .background(dirty ? WF.primary : WF.ink3)
                                .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                        }
                        .buttonStyle(.plain).disabled(!dirty || saving)
                        if saved { Text("✓ Saved").font(.system(size: 13, weight: .bold)).foregroundStyle(Color(hex: 0x167A4A)) }
                        Spacer()
                    }
                    Text("Keys are read from the server environment and never leave it.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                } else if failed {
                    Text("Couldn’t load AI settings.").font(.system(size: 14)).foregroundStyle(WF.ink3).padding(.vertical, 30)
                } else if loading {
                    WaffledLoading(top: 40)
                }
            }
            .padding(16).padding(.bottom, 110)
        }
        .background(WF.canvas)
        .navigationTitle("AI & Capture").navigationBarTitleDisplayMode(.inline)
        .task { await load() }
    }

    private func providerCard(_ p: String, _ cfg: WaffledAPI.CaptureConfig) -> some View {
        let m = Self.meta[p] ?? Meta(label: p, sub: "", envHint: "")
        let on = provider == p
        let enabled = p == "heuristic" || (cfg.available[p] ?? false)
        return Button { pick(p, cfg) } label: {
            HStack(spacing: 12) {
                Image(systemName: on ? "largecircle.fill.circle" : "circle")
                    .font(.system(size: 20)).foregroundStyle(on ? WF.primary : WF.ink3)
                VStack(alignment: .leading, spacing: 2) {
                    Text(m.label).font(.system(size: 15, weight: .semibold)).foregroundStyle(enabled ? WF.ink : WF.ink3)
                    Text(enabled ? m.sub : "Set \(m.envHint) in the server environment to enable")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 6)
                if p != "heuristic" {
                    WaffledStatusBadge(
                        text: enabled ? "key detected" : "not configured",
                        color: enabled ? Color(hex: 0x167A4A) : WF.ink3,
                        size: 10.5)
                }
            }
            .padding(13)
            .background(WF.card)
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(on ? WF.primary.opacity(0.4) : WF.hair, lineWidth: 1))
        }
        .buttonStyle(.plain).disabled(!enabled)
    }

    private var dirty: Bool {
        guard let c = config else { return false }
        if provider != c.provider { return true }
        if provider == "heuristic" { return false }
        return (model.trimmingCharacters(in: .whitespaces).isEmpty ? nil : model.trimmingCharacters(in: .whitespaces)) != c.model
    }

    private func pick(_ p: String, _ cfg: WaffledAPI.CaptureConfig) {
        guard p == "heuristic" || (cfg.available[p] ?? false) else { return }
        provider = p; saved = false
        model = p == "heuristic" ? "" : (cfg.defaultModels[p] ?? "")
    }

    private func load() async {
        do {
            let c = try await api.captureConfig()
            config = c; provider = c.provider; model = c.model ?? ""
        } catch { failed = true }
        loading = false
    }

    private func save() async {
        guard let c = config else { return }
        saving = true; saved = false
        let m = provider == "heuristic" ? nil
            : (model.trimmingCharacters(in: .whitespaces).isEmpty ? nil : model.trimmingCharacters(in: .whitespaces))
        do {
            let r = try await api.setCaptureConfig(provider: provider, model: m)
            config = WaffledAPI.CaptureConfig(provider: r.provider, model: r.model,
                                           available: c.available, defaultModels: c.defaultModels)
            model = r.model ?? ""
            saved = true
        } catch { failed = false }
        saving = false
    }
}
