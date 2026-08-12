import SwiftUI

/// Add or edit a subscribed ICS calendar feed (Settings → Calendars).
///
/// A feed is just a URL Waffled polls, so there's little to configure: the link,
/// an optional name, who it belongs to, and whether the whole family sees it. The
/// events it brings in are read-only — the sheet says so, because that's the part
/// people are surprised by.
struct IcsFeedEditorSheet: View {
    /// nil = subscribing to a new feed.
    let feed: WaffledAPI.CalendarStatus.Feed?
    let members: [SyncedMember]
    let onSaved: () -> Void

    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var name = ""
    @State private var personId: String?
    @State private var personal = false
    @State private var saving = false
    @State private var error: String?

    private let api = WaffledAPI()
    private var isNew: Bool { feed == nil }
    private var canSave: Bool { !url.trimmingCharacters(in: .whitespaces).isEmpty && !saving }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    field("Calendar link (ICS)") {
                        TextField("https://…/basic.ics", text: $url)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                            .keyboardType(.URL)
                    }
                    Text("Paste the “secret address in iCal format” / “subscribe” link from the calendar you want to follow.")
                        .font(.system(size: 12)).foregroundStyle(WF.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    field("Name (optional)") {
                        TextField("US Holidays", text: $name)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("Belongs to").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
                        Menu {
                            Button("Nobody in particular") { personId = nil }
                            ForEach(members) { m in Button(m.name) { personId = m.id } }
                        } label: {
                            WaffledMenuPill(text: members.first { $0.id == personId }?.name ?? "Nobody in particular")
                        }
                    }

                    Button { personal.toggle() } label: {
                        HStack(spacing: 8) {
                            Image(systemName: personal ? "checkmark.square.fill" : "square")
                                .font(.system(size: 17)).foregroundStyle(personal ? WF.primary : WF.ink3)
                            Text("Private (only the person it belongs to sees it)")
                                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink)
                            Spacer(minLength: 0)
                        }
                    }
                    .buttonStyle(.plain)

                    HStack(spacing: 7) {
                        Image(systemName: "lock").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
                        Text("Events from a feed are read-only — Waffled can show them but can't change them.")
                            .font(.system(size: 12)).foregroundStyle(WF.ink3)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))

                    if let error {
                        Text(error).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle(isNew ? "Add calendar feed" : "Edit feed")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isNew ? "Subscribe" : "Save") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
            .onAppear {
                guard let feed else { return }
                url = feed.url
                name = feed.name ?? ""
                personId = feed.personId
                personal = feed.visibility == "personal"
            }
        }
    }

    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink2)
            content()
                .font(.system(size: 15))
                .padding(.horizontal, 12).padding(.vertical, 11)
                .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rSM, style: .continuous))
        }
    }

    private func save() async {
        saving = true; error = nil
        defer { saving = false }
        let trimmedName = name.trimmingCharacters(in: .whitespaces)
        let visibility = personal ? "personal" : "family"
        do {
            if let feed {
                try await api.updateIcsFeed(id: feed.id, [
                    "url": .string(url.trimmingCharacters(in: .whitespaces)),
                    "name": trimmedName.isEmpty ? .null : .string(trimmedName),
                    "personId": personId.map { JSONValue.string($0) } ?? .null,
                    "visibility": .string(visibility),
                ])
            } else {
                try await api.createIcsFeed(url: url.trimmingCharacters(in: .whitespaces),
                                            name: trimmedName.isEmpty ? nil : trimmedName,
                                            personId: personId, visibility: visibility)
            }
            onSaved()
            dismiss()
        } catch {
            // The server validates the URL — say what it said. The URL hint is only
            // the fallback, for when it said nothing (offline, a proxy's HTML 502):
            // leading with it on a 403 or 404 sends people to fix a link that's fine.
            self.error = APIErrorText.message(
                for: error,
                fallback: "Couldn’t save that feed. Check the link is a full http(s) address to an .ics file.")
        }
    }
}
