import SwiftUI

// Weekly Planning · step 7 (Meals) — the two surfaces a night opens, both thin wrappers over
// things the app already has: the night picker IS `RecipesLibraryView` in pick mode, and the
// shopper sheet writes a REAL one-off chore through this step's own route.

/// What a tap on a night opens is the app's OWN recipe library — search, sort, facet filters,
/// the two-up card grid, "＋ New recipe" in the bar, and saved PLATES beside the recipes.
///
/// THE THREE PLACEHOLDER CARDS write exactly the literals the Meals screen writes, which are
/// exactly what `TonightMeal.isEatingOut` classifies — so a night planned here and the same
/// night planned on the Meals screen are the same row.
///
/// The free-text field covers the one thing neither the cards nor "＋ New recipe" does: the
/// one-off named dish nobody wants to write a recipe for.
struct MealsStepNightPicker: View {
    let night: PlanningMealsNightRow
    let onPickRecipe: (String) -> Void
    let onPickPlate: (String) -> Void
    let onPickTitle: (String) -> Void
    let onClear: () -> Void

    @Environment(\.dismiss) private var dismiss

    /// The library is loaded fresh per picker mount and never cached behind a
    /// `if !recipes.isEmpty { return }` guard: an EMPTY library is a valid answer, and caching
    /// on emptiness is how a household got told "no recipes yet" forever.
    @State private var recipes = RecipesModel()
    @State private var freeText = ""
    @FocusState private var freeTextFocused: Bool

    /// A named struct rather than a tuple because `ForEach(_:id:)` needs a key path, and Swift
    /// has none into a tuple element.
    struct Placeholder: Identifiable {
        let emoji: String
        /// EXACTLY the literal the Meals screen writes, so `TonightMeal.isEatingOut` and its
        /// siblings classify a night planned here the same way.
        let title: String
        var id: String { title }
    }

    private static let placeholders: [Placeholder] = [
        Placeholder(emoji: "🥡", title: "Eating out"),
        Placeholder(emoji: "🍱", title: "Leftovers"),
        Placeholder(emoji: "✨", title: "Try something new"),
    ]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                Divider().background(WF.hair)
                // The library's own screen, in pick mode. `onPickMeal` is supplied because
                // this caller knows WHERE a plate goes (the date is in this closure) — without
                // it the grid hides plates rather than showing a control that does nothing.
                RecipesLibraryView(
                    model: recipes,
                    onPick: { recipe in
                        onPickRecipe(recipe.id)
                        dismiss()
                    },
                    onPickMeal: { meal in
                        onPickPlate(meal.id)
                        dismiss()
                    })
            }
            .background(WF.canvas)
            .navigationTitle("\(night.dow) dinner")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
        .task { await recipes.load() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text("\(night.dow) dinner · \(night.monthDay)")
                    .font(WF.serif(18, .bold)).foregroundStyle(WF.ink)
                Text(night.dinner.map { "Currently \($0.title ?? "planned")" } ?? "Nothing planned yet")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
            }

            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(Self.placeholders) { option in
                    Button {
                        onPickTitle(option.title)
                        dismiss()
                    } label: {
                        Text("\(option.emoji) \(option.title)")
                            .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                            .padding(.horizontal, 12).padding(.vertical, 7)
                            .wfChip(selected: false)
                    }
                    .buttonStyle(.plain)
                }
            }

            HStack(spacing: 8) {
                TextField("Or name it yourself…", text: $freeText)
                    .font(.system(size: 14))
                    .focused($freeTextFocused)
                    .submitLabel(.done)
                    .onSubmit(submitFreeText)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .wfField()
                if !trimmedFreeText.isEmpty {
                    Button("Plan it", action: submitFreeText)
                        .font(.system(size: 13.5, weight: .bold))
                }
            }
            .wfKeyboardDoneToolbar { freeTextFocused = false }

            // Emptying the slot has nowhere else to live once the body is the library, so
            // it sits with the night it is about.
            if night.dinner != nil {
                Button {
                    onClear()
                    dismiss()
                } label: {
                    Text("Clear this night")
                        .font(.system(size: 13.5, weight: .bold)).foregroundStyle(WF.danger)
                }
                .buttonStyle(.plain)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 16).padding(.top, 10).padding(.bottom, 12)
    }

    private var trimmedFreeText: String {
        freeText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func submitFreeText() {
        let title = trimmedFreeText
        guard !title.isEmpty else { return }
        onPickTitle(title)
        dismiss()
    }
}

/// Who's shopping, and when. Saving writes a REAL one-off chore. `onSave` reports `(dueOn,
/// personId, dueTime)`; `dueOn == nil` is "no trip this week", which removes the chore rather
/// than leaving one nobody planned on somebody's board.
struct MealsStepShopperSheet: View {
    let weekStart: String
    let nights: [PlanningMealsNightRow]
    let trip: WaffledAPI.PlanningShoppingTrip?
    let people: [SyncedMember]
    let myPersonId: String?
    /// `chore.manage`. Handing the trip to somebody ELSE is that capability; putting it on
    /// yourself, or leaving it up for grabs, is not. The server enforces it, and the picker
    /// states it so it never offers a tap that 403s.
    let canManage: Bool
    let busy: Bool
    let onSave: (_ dueOn: String?, _ personId: String?, _ dueTime: String?) -> Void

    @Environment(\.dismiss) private var dismiss

    @State private var personId: String?
    @State private var dueOn: String
    @State private var hasTime: Bool
    @State private var time: Date

    init(
        weekStart: String, nights: [PlanningMealsNightRow],
        trip: WaffledAPI.PlanningShoppingTrip?, people: [SyncedMember],
        myPersonId: String?, canManage: Bool, busy: Bool,
        onSave: @escaping (_ dueOn: String?, _ personId: String?, _ dueTime: String?) -> Void
    ) {
        self.weekStart = weekStart
        self.nights = nights
        self.trip = trip
        self.people = people
        self.myPersonId = myPersonId
        self.canManage = canManage
        self.busy = busy
        self.onSave = onSave
        _personId = State(initialValue: trip?.personId)
        // Default to the LAST night of the week: pencilled in beats blank, one tap to change.
        _dueOn = State(initialValue: trip?.dueOn ?? nights.last?.date ?? weekStart)
        _hasTime = State(initialValue: trip?.dueTime != nil)
        _time = State(initialValue: MealsStepShopperSheet.parse(trip?.dueTime))
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("It lands on the Tasks board as a real assignment — leaving it up for grabs is a real answer.")
                        .font(.system(size: 13)).foregroundStyle(WF.ink2)
                        .fixedSize(horizontal: false, vertical: true)

                    WaffledFieldCard(title: "Who’s going") {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            personChip(nil, label: "Up for grabs", emoji: nil)
                            ForEach(people) { member in
                                personChip(member.id, label: member.name, emoji: member.emoji)
                            }
                        }
                        if !canManage {
                            Text("Only a parent can hand the shopping to somebody else.")
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    WaffledFieldCard(title: "Which day") {
                        ChipFlow(spacing: 8, lineSpacing: 8) {
                            ForEach(nights) { night in
                                Button { dueOn = night.date } label: {
                                    Text(night.dow)
                                        .font(.system(size: 13, weight: .bold))
                                        .foregroundStyle(dueOn == night.date ? WF.primary : WF.ink2)
                                        .padding(.horizontal, 13).padding(.vertical, 7)
                                        .wfChip(selected: dueOn == night.date)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    WaffledFieldCard(title: "What time") {
                        Toggle("Set a time", isOn: $hasTime)
                            .font(.system(size: 14, weight: .semibold))
                        if hasTime {
                            DatePicker("", selection: $time, displayedComponents: .hourAndMinute)
                                .labelsHidden()
                        }
                    }

                    if trip != nil {
                        Button {
                            onSave(nil, nil, nil)
                            dismiss()
                        } label: {
                            Text("No trip this week")
                                .font(.system(size: 14, weight: .bold)).foregroundStyle(WF.danger)
                        }
                        .buttonStyle(.plain).disabled(busy)
                    }

                    WaffledPrimaryCTA(
                        label: trip == nil ? "Add it to Tasks" : "Update the trip",
                        isBusy: busy
                    ) {
                        onSave(dueOn, personId, hasTime ? Self.hhmm(time) : nil)
                        dismiss()
                    }
                }
                .padding(16)
            }
            .background(WF.canvas)
            .navigationTitle("The shopping trip")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    private func personChip(_ id: String?, label: String, emoji: String?) -> some View {
        let allowed = PlanningMealsShopper.mayAssign(
            personId: id, myPersonId: myPersonId, canManage: canManage)
        return Button { personId = id } label: {
            HStack(spacing: 6) {
                if let emoji { Text(emoji).font(.system(size: 13)) }
                Text(label).font(.system(size: 13, weight: .semibold))
            }
            .foregroundStyle(personId == id ? WF.primary : WF.ink2)
            .padding(.horizontal, 13).padding(.vertical, 7)
            .wfChip(selected: personId == id)
        }
        .buttonStyle(.plain)
        .disabled(!allowed)
        .opacity(allowed ? 1 : 0.4)
    }

    /// "09:00" → a `Date` carrying just that clock, defaulting to a plausible 9am.
    private static func parse(_ hhmm: String?) -> Date {
        var c = DateComponents()
        c.hour = 9
        c.minute = 0
        if let hhmm {
            let parts = hhmm.split(separator: ":")
            if parts.count == 2, let h = Int(parts[0]), let m = Int(parts[1]) {
                c.hour = h
                c.minute = m
            }
        }
        return Calendar.current.date(from: c) ?? Date()
    }

    /// Back to the `HH:mm` the route validates — POSIX and 24-hour, never a localized clock,
    /// because the server matches `^\d{2}:\d{2}$` and quietly drops anything else.
    static func hhmm(_ date: Date) -> String {
        let c = Calendar.current.dateComponents([.hour, .minute], from: date)
        return String(format: "%02d:%02d", c.hour ?? 0, c.minute ?? 0)
    }
}
