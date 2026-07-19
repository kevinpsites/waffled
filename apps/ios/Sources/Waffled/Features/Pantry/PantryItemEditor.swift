import SwiftUI

/// Add-by-hand / edit sheet for a pantry item — name, amount + unit, location, an
/// optional best-by date, and a note. Builds the create/update body and hands it back;
/// the caller does the API call (so the same sheet serves both add and edit).
struct PantryItemEditor: View {
    enum Mode { case add, edit(WaffledAPI.PantryItem) }

    @Environment(\.dismiss) private var dismiss
    let mode: Mode
    let locations: [String]
    let onSave: ([String: JSONValue]) async -> Void
    /// Edit mode only — deletes the item. Nil (and hidden) when adding.
    var onDelete: (() async -> Void)?

    @State private var name: String
    @State private var amount: String
    @State private var unit: String
    @State private var location: String
    @State private var hasExpiry: Bool
    @State private var expiry: Date
    @State private var addedOn: Date
    @State private var note: String
    @State private var lowAt: String
    @State private var isMeal: Bool
    @State private var saving = false
    @State private var confirmingDelete = false

    init(mode: Mode, locations: [String], onSave: @escaping ([String: JSONValue]) async -> Void,
         onDelete: (() async -> Void)? = nil) {
        self.mode = mode
        self.locations = locations
        self.onSave = onSave
        self.onDelete = onDelete
        switch mode {
        case .add:
            _name = State(initialValue: "")
            _amount = State(initialValue: "1")
            _unit = State(initialValue: "")
            _location = State(initialValue: locations.first ?? "Pantry")
            _hasExpiry = State(initialValue: false)
            _expiry = State(initialValue: Date())
            _addedOn = State(initialValue: Date())
            _note = State(initialValue: "")
            _lowAt = State(initialValue: "")
            _isMeal = State(initialValue: false)
        case let .edit(it):
            _name = State(initialValue: it.name)
            _amount = State(initialValue: it.amount)
            _unit = State(initialValue: it.unit)
            _location = State(initialValue: it.location)
            let d = PantryExpiry.date(it.expiresOn)
            _hasExpiry = State(initialValue: d != nil)
            _expiry = State(initialValue: d ?? Date())
            _addedOn = State(initialValue: PantryExpiry.date(it.addedOn) ?? Date())
            _note = State(initialValue: it.note)
            _lowAt = State(initialValue: it.lowAt.map { formatAmount($0) } ?? "")
            _isMeal = State(initialValue: it.isMeal ?? false)
        }
    }

    private var title: String { if case .edit = mode { return "Edit item" }; return "Add to pantry" }
    /// Locations to offer — the configured set plus the item's own (in case it's a stray).
    private var locationChoices: [String] {
        var out = locations.isEmpty ? ["Freezer", "Fridge", "Pantry"] : locations
        if !out.contains(location) { out.append(location) }
        return out
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    field("Name") { TextField("e.g. Greek yogurt", text: $name).textInputAutocapitalization(.words) }
                    HStack(spacing: 12) {
                        field("Amount") { TextField("1", text: $amount).keyboardType(.decimalPad) }
                        field("Unit") { TextField("bags, lb…", text: $unit).textInputAutocapitalization(.never) }
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        SectionLabel(text: "Where")
                        locationChips
                    }
                    VStack(alignment: .leading, spacing: 9) {
                        Toggle(isOn: $hasExpiry.animation()) {
                            Text("Best by").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                        }.tint(WF.primary)
                        if hasExpiry {
                            DatePicker("", selection: $expiry, displayedComponents: .date)
                                .labelsHidden().datePickerStyle(.graphical).tint(WF.primary)
                        }
                    }
                    HStack {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Added / bought").font(.system(size: 13, weight: .bold)).foregroundStyle(WF.ink3)
                            Text("how long it’s been on hand").font(.system(size: 11)).foregroundStyle(WF.ink3)
                        }
                        Spacer()
                        DatePicker("", selection: $addedOn, in: ...Date(), displayedComponents: .date)
                            .labelsHidden().tint(WF.primary)
                    }
                    HStack(spacing: 12) {
                        field("Note") { TextField("leftovers from Tuesday", text: $note) }
                        field("Warn below") { TextField("default", text: $lowAt).keyboardType(.decimalPad) }
                    }
                    Button { isMeal.toggle() } label: {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: isMeal ? "checkmark.square.fill" : "square")
                                .font(.system(size: 20)).foregroundStyle(isMeal ? WF.primary : WF.ink3)
                            Text("It’s a meal — ready to eat (leftovers, pre-made, or a protein to use up). Shows in “Cook from your pantry”.")
                                .font(.system(size: 13)).foregroundStyle(WF.ink2)
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer(minLength: 0)
                        }
                    }.buttonStyle(.plain).padding(.top, 2)

                    if onDelete != nil {
                        Divider().background(WF.hair).padding(.vertical, 4)
                        Button(role: .destructive) { confirmingDelete = true } label: {
                            HStack(spacing: 7) {
                                Image(systemName: "trash")
                                Text("Delete item").fontWeight(.semibold)
                            }
                            .font(.system(size: 15)).foregroundStyle(WF.danger)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.danger.opacity(0.4), lineWidth: 1))
                        }
                        .buttonStyle(.plain).disabled(saving)
                    }
                }
                .padding(20)
            }
            .background(WF.canvas)
            .navigationTitle(title).navigationBarTitleDisplayMode(.inline)
            .confirmationDialog("Delete this item?", isPresented: $confirmingDelete, titleVisibility: .visible) {
                Button("Delete", role: .destructive) { deleteItem() }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This removes it from your pantry.") }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(saving ? "Saving…" : "Save") { save() }
                        .fontWeight(.semibold)
                        .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
                }
            }
        }
        .presentationDetents([.large])
    }

    private var locationChips: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(locationChoices, id: \.self) { loc in
                    let on = loc.caseInsensitiveCompare(location) == .orderedSame
                    Button { location = loc } label: {
                        Text(loc).font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(on ? WF.ink : WF.ink2)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .wfChip(selected: on)
                    }.buttonStyle(.plain)
                }
            }
            .padding(.vertical, 1)
        }
    }

    private func field<C: View>(_ label: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 9) {
            SectionLabel(text: label)
            content()
                .font(.system(size: 16, weight: .semibold))
                .padding(.horizontal, 15).padding(.vertical, 13)
                .frame(maxWidth: .infinity, alignment: .leading)
                .wfField()
        }
    }

    private func save() {
        saving = true
        let body: [String: JSONValue] = [
            "name": .string(name.trimmingCharacters(in: .whitespaces)),
            "amount": .string(amount.trimmingCharacters(in: .whitespaces)),
            "unit": .string(unit.trimmingCharacters(in: .whitespaces)),
            "location": .string(location),
            "note": .string(note.trimmingCharacters(in: .whitespaces)),
            "expiresOn": hasExpiry ? .string(PantryExpiry.string(expiry)) : .null,
            "addedOn": .string(PantryExpiry.string(addedOn)),
            "lowAt": Double(lowAt.trimmingCharacters(in: .whitespaces)).map(JSONValue.double) ?? .null,
            "isMeal": .bool(isMeal),
        ]
        Task {
            await onSave(body)
            dismiss()
        }
    }

    private func deleteItem() {
        guard let onDelete else { return }
        saving = true
        Task {
            await onDelete()
            dismiss()
        }
    }
}
