import SwiftUI

/// Weekly Planning · step 7 "Meals", ported from `MealsStep.tsx`. Seven nights, each with
/// ITS EVENTS ABOVE ITS DISH — the events are the reason a night is easy or hard; the web's
/// seven columns become seven stacked cards on a phone.
///
/// THE STEP OWNS NO DATA: overwriting a set night is a tap on it, through the same
/// `/api/meals/plan` the Meals screen uses, and the session records only a crumb. The fill
/// lives in the FOOTER, which is why the state sits in `PlanningMealsStepStore`.
struct MealsStepView: View {
    let props: PlanningStepProps

    @Environment(SyncManager.self) private var sync

    @State private var editing: String?
    @State private var shopping = false

    /// The library the planner's manual-pick sheet browses, loaded only when it opens.
    @State private var plannerRecipes = RecipesModel()

    /// Resolved from the shared store on every body pass: `@State` would capture the first
    /// model forever, and stepping to another week must land on that week's model.
    private var model: PlanningMealsModel {
        PlanningMealsStepStore.shared.model(sessionId: props.sessionId, weekStart: props.weekStart)
    }

    private var storeKey: String {
        PlanningMealsStepStore.key(sessionId: props.sessionId, weekStart: props.weekStart)
    }

    private var frozen: Bool { props.busy || model.busy }

    var body: some View {
        // NO OUTER ScrollView: the shell owns the chrome and the scrolling around a step.
        VStack(alignment: .leading, spacing: 12) {
            if let message = model.errorMessage {
                DismissibleErrorBanner(message: message) { model.dismissError() }
            }

            if !model.loaded {
                WaffledLoading()
            } else if model.view == nil {
                WaffledEmptyState(
                    emoji: "🍽️",
                    title: "Couldn’t read this week’s meals",
                    message: "Reload, or skip this step — skipping is a real answer.")
            } else {
                ForEach(model.rows) { night($0) }
                groceryLine
                if let sentence = PlanningMealsText.keptSentence(model.kept) {
                    Text(sentence)
                        .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        // Keyed on session + week: a different week is a different model, and coming back to
        // the same key re-reads too (`enter`).
        .task(id: storeKey) {
            await model.enter(weekStart: props.weekStart, seed: PlanningMealsCrumb.dates(props.step.data))
        }
        // ONE push, after every applied read and every landed write: the shell REPLACES the
        // step's data when the affirmative is pressed. `nil` passes straight through — unlike
        // Goals, here it is the real answer "the app picked nothing".
        .onChange(of: model.rev) { props.setDecisionData(model.crumb) }
        // The week changed under us — close a modal that names a night in the old one.
        .onChange(of: storeKey) {
            editing = nil
            shopping = false
        }
        // THIS STEP LENDS THE BANNER NOTHING: a button that merely ticked a parked note off
        // would promise an action it doesn't perform. Withdrawn explicitly.
        .onAppear {
            props.lendVerb(nil)
            // AND RE-HAND THE CRUMB: the store outlives this view, so coming back would land
            // with ✨ nights on screen and nothing recorded.
            props.setDecisionData(model.crumb)
        }
        .fullScreenCover(item: editingBinding) { target in
            MealsStepNightPicker(
                night: target,
                onPickRecipe: { recipeId in
                    write { await model.planNight(weekStart: props.weekStart, date: target.date, recipeId: recipeId, title: nil) }
                },
                onPickPlate: { mealId in
                    write { await model.planNightAsPlate(weekStart: props.weekStart, date: target.date, mealId: mealId) }
                },
                onPickTitle: { title in
                    write { await model.planNight(weekStart: props.weekStart, date: target.date, recipeId: nil, title: title) }
                },
                onClear: {
                    write { await model.clearNight(weekStart: props.weekStart, date: target.date) }
                })
        }
        .sheet(isPresented: $shopping) {
            MealsStepShopperSheet(
                weekStart: props.weekStart,
                nights: model.rows,
                trip: model.view?.shopping,
                people: sync.members,
                myPersonId: sync.currentPersonId,
                canManage: sync.can("chore.manage"),
                busy: frozen,
                onSave: { dueOn, personId, dueTime in
                    write {
                        await model.setShopper(
                            weekStart: props.weekStart, dueOn: dueOn,
                            personId: personId, dueTime: dueTime)
                    }
                })
        }
        // THE PLANNER IS PRESENTED FROM THE BODY though its button is in the footer — hence
        // `plannerOpen` on the shared model. The footer renders nothing until the week is read
        // and swaps once a fill lands, so a `.sheet` there would hang off a vanishing control.
        .sheet(isPresented: plannerBinding) { plannerSheet }
    }

    /// The app's OWN "Plan my week" planner, narrowed as the web narrows it: day chips are
    /// the EMPTY nights only, and applying goes to the step's fill endpoint, which keeps them
    /// marked, undoable, and unable to overwrite a decided night.
    private var plannerSheet: some View {
        PlanWeekSheet(
            start: props.weekStart,
            weekLabel: PlanningFormat.weekLabel(props.weekStart),
            // Noon in the HOUSEHOLD's zone — see `PlanningMealsPlan.plannerDays`.
            weekDays: PlanningMealsPlan.plannerDays(model.emptyDates, tz: sync.householdTz),
            familySize: max(1, sync.members.count),
            recipes: plannerRecipes,
            mealTypes: [PlanningMealsModel.mealType],
            initialDays: model.emptyDates,
            note: PlanningMealsText.plannerNote(model.emptyDates.count),
            onApply: { cards in
                let landed = await model.applyPlan(weekStart: props.weekStart, approved: cards)
                if landed { props.refresh() }
                return landed
            },
            onApplied: {})
            // Loaded when the planner opens: only its manual-pick sheet needs the library.
            .task { await plannerRecipes.load() }
    }

    /// Two-way, so the planner's Cancel and a swipe-down close it via this binding.
    private var plannerBinding: Binding<Bool> {
        Binding(get: { model.plannerOpen }, set: { model.setPlanner($0) })
    }

    /// Every write goes through here, so `props.refresh()` runs on LANDED writes only.
    private func write(_ work: @escaping () async -> Bool) {
        Task { if await work() { props.refresh() } }
    }

    /// Presented on the ROW, not a bare date, so switching nights starts on a fresh search.
    private var editingBinding: Binding<PlanningMealsNightRow?> {
        Binding(
            get: { model.rows.first { $0.date == editing } },
            set: { editing = $0?.date })
    }

    // MARK: - One night

    private func night(_ row: PlanningMealsNightRow) -> some View {
        WaffledCard(padding: 13) {
            VStack(alignment: .leading, spacing: 9) {
                HStack(spacing: 7) {
                    Text(row.dow).font(.system(size: 15, weight: .heavy)).foregroundStyle(WF.ink)
                    Text(row.monthDay).font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink3)
                    Spacer(minLength: 4)
                }

                // The events come FIRST — they are the context that decides the night.
                if row.events.isEmpty {
                    Text("Nothing on").font(.system(size: 12.5)).foregroundStyle(WF.ink3)
                } else {
                    VStack(alignment: .leading, spacing: 4) {
                        ForEach(row.events) { event in
                            HStack(spacing: 7) {
                                Circle()
                                    .fill(Color(hexString: event.colorHex) ?? WF.ink3)
                                    .frame(width: 7, height: 7)
                                Text(event.title)
                                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.ink2)
                                    .lineLimit(1)
                                Spacer(minLength: 6)
                                Text(event.clock)
                                    .font(.system(size: 11.5, weight: .semibold)).foregroundStyle(WF.ink3)
                            }
                        }
                    }
                }

                dish(row)
            }
        }
    }

    /// Four states, each legible at a glance: planned, empty, auto-filled, eating out.
    private func dish(_ row: PlanningMealsNightRow) -> some View {
        Button { editing = row.date } label: {
            HStack(spacing: 11) {
                if let dinner = row.dinner {
                    // NEVER `AsyncImage` in a list — `CachedImage` serves a decoded hit
                    // synchronously, which keeps seven of these from re-decoding per tick.
                    CachedImage(dinner.imageUrl, contentMode: .fill) {
                        WaffledEmojiTile(emoji: dinner.emoji ?? row.fallbackEmoji, size: 22, frame: 44)
                    }
                    .frame(width: 44, height: 44)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(dinner.title ?? "Planned")
                            .font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            .lineLimit(2).multilineTextAlignment(.leading)
                        if let attribution = row.attribution {
                            Text(attribution)
                                .font(.system(size: 12)).foregroundStyle(WF.ink3).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 6)
                    if row.auto {
                        WaffledStatusBadge(text: "✨ auto", color: WF.ai)
                    }
                } else {
                    WaffledEmojiTile(emoji: "＋", size: 20, frame: 44)
                    Text("Nothing planned")
                        .font(.system(size: 14.5, weight: .semibold)).foregroundStyle(WF.ink2)
                    Spacer(minLength: 6)
                }
            }
            .padding(10)
            .planningOptionChrome(selected: row.auto, tint: WF.ai)
        }
        .buttonStyle(.plain)
        .disabled(frozen)
        .accessibilityLabel(
            row.dinner.map { "\($0.title ?? "Planned") on \(row.dow) — change it" }
                ?? "Plan \(row.dow)")
    }

    // MARK: - Groceries

    /// ONE LINE, not a panel: the board already builds itself from this plan.
    @ViewBuilder private var groceryLine: some View {
        if let groceries = model.view?.groceries {
            WaffledCard(padding: 13) {
                VStack(alignment: .leading, spacing: 9) {
                    HStack(spacing: 10) {
                        Text("🛒").font(.system(size: 17))
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Groceries")
                                .font(.system(size: 14.5, weight: .bold)).foregroundStyle(WF.ink)
                            Text(PlanningMealsText.grocerySub(added: model.groceryAdded))
                                .font(.system(size: 12)).foregroundStyle(WF.ink3)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                        Spacer(minLength: 6)
                    }
                    Pill(text: PlanningMealsText.groceryPill(groceries))

                    // The shopper pill is only here because the trip is REAL — a one-off
                    // chore on the Tasks board. With chores off the control GOES AWAY.
                    if model.view?.choresOn == true {
                        Button { shopping = true } label: {
                            Text(PlanningMealsText.tripLabel(model.view?.shopping))
                                .font(.system(size: 13, weight: .bold))
                                .foregroundStyle(model.view?.shopping == nil ? WF.primary : WF.ink)
                                .padding(.horizontal, 13).padding(.vertical, 8)
                                .wfChip(selected: model.view?.shopping != nil)
                        }
                        .buttonStyle(.plain)
                        .disabled(frozen)
                    }
                }
            }
        }
    }
}
