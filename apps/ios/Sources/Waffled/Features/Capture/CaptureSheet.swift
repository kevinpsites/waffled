import SwiftUI

/// "Add anything" — type free text, the server's pluggable LLM parses it, you
/// confirm the preview, and it commits. Mirrors the handoff `ios-add.png`.
///
/// Events are written to the local mirror and routed/pushed to Google server-side
/// (see SyncManager.commitEvent). Grocery/task/meal commits land next.
struct CaptureSheet: View {
    @Environment(SyncManager.self) private var sync
    @Environment(\.dismiss) private var dismiss
    /// Start voice dictation as soon as the sheet appears (from a mic tap).
    var autoDictate = false
    @State private var text = ""
    @State private var phase: Phase = .input
    @State private var intent: CaptureIntent?
    @State private var via = ""
    @State private var thinking = false              // the LLM is still improving the guess
    @State private var serverAlt: CaptureIntent?     // the LLM's take when it disagrees with a confident heuristic
    @State private var serverAltVia = ""
    @State private var error: String?
    @State private var dictation = Dictation()
    // Inline-editable fields for the "Waffled understood" card (populated per intent).
    @State private var editKind = "event"       // the (re-classifiable) intent kind
    @State private var editName = ""            // event title / item / chore / meal
    @State private var evDate = Date()
    @State private var evAllDay = false
    @State private var evPerson: String?        // event / task assignee
    @State private var editQty = ""             // grocery / list quantity
    @State private var editListName = ""        // list target
    @State private var taskStars = 0
    @State private var taskCurrency = "stars"
    @State private var taskRrule: String?       // preserved if the parse found a recurrence
    @State private var evRepeat = RepeatState.none   // event recurrence (seeded by the parse, editable)
    @State private var evUntilOn = false             // "ends on a date" toggle
    @State private var evUntil = Date()
    @State private var mealSlot = "dinner"
    @State private var mealDate = Date()
    @State private var cdDate = Date()                       // countdown target day
    @State private var cdEmoji: String?                       // server-parsed countdown emoji (carried through)
    @State private var personType = "adult"                   // person member type (adult|teen|kid)
    @State private var personEmoji: String?                   // LLM-picked avatar emoji (carried through)
    @State private var personBirthday: String?               // LLM-picked birthday YYYY-MM-DD (carried through)
    @State private var personIsAdmin = false                 // LLM-picked admin flag (carried through)
    @State private var goalType = "habit"                     // goal type (count|total|habit|checklist)
    @State private var goalTarget = ""                        // numeric target (count/total), as text
    @State private var goalUnit = ""                          // target unit (count/total)
    @State private var goalDeadlineOn = false                 // whether the goal has a deadline
    @State private var goalDeadline = Date()                  // the deadline day
    @State private var goalTrackingMode = "shared_total"      // LLM-picked tracking mode (carried through)
    @State private var goalAssignEveryone = false             // who's it for: false = just me, true = everyone
    @State private var pantryAmount = ""                      // pantry amount on hand (as text)
    @State private var pantryUnit = ""                        // pantry amount's unit
    @State private var pantryLocation = "Pantry"              // where it's stored (Pantry/Fridge/Freezer)
    @State private var pantryExpiresOn = false                // whether an expiry date is set
    @State private var pantryExpires = Date()                 // the expiry day
    @State private var pantryLowAt: Double?                    // server-parsed "running low" threshold (carried through)
    @State private var rewardEmoji = ""                       // reward avatar emoji
    @State private var rewardCost = ""                        // reward star/point cost (as text)
    @State private var rewardRequiresApproval: Bool?          // nil = inherit household default
    // Tier 2 mutate (act on an existing row): verb + rough targetKind + description + args
    // seed /api/capture/resolve; the user picks a candidate, then /api/capture/commit.
    @State private var mutateVerb = ""
    @State private var mutateTargetKind: String?
    @State private var mutateDescription = ""
    @State private var mutateArgs: [String: JSONValue] = [:]
    @State private var mutateState: MutateResolveState?       // resolved candidates / degrade
    @State private var mutateChosenId: String?                // the picked candidate
    @State private var mutateResolveKey = ""                  // guards a stale/duplicate resolve
    @State private var lists: [WaffledAPI.ListSummary] = []   // for the list picker
    @State private var editing = false                     // glance → full field editor
    @FocusState private var focused: Bool
    @State private var detent: PresentationDetent = .large   // open tall (roomy input), draggable to medium

    private static let kinds: [(key: String, icon: String, label: String)] = [
        ("event", "📅", "Event"), ("list", "📝", "List"), ("grocery", "🛒", "Grocery"),
        ("task", "✅", "Task"), ("meal", "🍽️", "Meal"), ("countdown", "⏳", "Countdown"),
        ("person", "👤", "Family member"), ("goal", "🎯", "Goal"), ("pantry", "🥫", "Pantry"),
        ("reward", "🎁", "Reward"),
    ]

    // ISO8601DateFormatter is expensive to allocate; hoist the two distinct configs
    // (default internet-date-time, and one with fractional seconds) to shared statics.
    private static let isoDF = ISO8601DateFormatter()
    private static let isoFracDF: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()

    enum Phase { case input, parsing, preview, committing }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            header
            if let error {
                Text(error).font(.system(size: 13)).foregroundStyle(WF.primaryD)
            }
            switch phase {
            case .input, .parsing: inputView
            case .preview, .committing: previewView
            }
            Spacer(minLength: 0)
        }
        .padding(20)
        .background(WF.canvas)
        .presentationDetents([.medium, .large], selection: $detent)
        .presentationDragIndicator(.visible)
        .task {
            // Focus the field (or start dictation / demo) FIRST so the keyboard comes
            // up instantly. The LLM warm-up + ancillary loads used to be awaited here,
            // which froze the sheet for ~10s before the keyboard appeared — they now
            // run off the critical path below.
            if let demo = DemoHooks.captureText {   // headless demo driver (no-op unless set)
                text = demo
                parse()
            } else if autoDictate {
                dictation.toggle()
            } else {
                focused = true
            }
            // Pre-warm the model + load list/currency pickers in the background. None of
            // these are needed until after the user types and parses, so they never need
            // to block focus.
            async let warm: Void = sync.warmCapture()
            async let currencies: Void = sync.loadCurrencies()
            let fetchedLists = (try? await WaffledAPI().listSummaries()) ?? []
            _ = await (warm, currencies)
            lists = fetchedLists
        }
        .onDisappear { dictation.stop(); resetForm() }
    }

    /// Clear everything so reopening the bar starts fresh (the sheet's @State otherwise
    /// survives a dismiss on iPhone, leaving the last parse filled in).
    private func resetForm() {
        text = ""; phase = .input; error = nil
        intent = nil; via = ""; thinking = false
        serverAlt = nil; serverAltVia = ""
        editing = false; editKind = "event"; editName = ""; editQty = ""
        evRepeat = .none; evUntilOn = false; evPerson = nil
        taskStars = 0; taskRrule = nil
        personType = "adult"; personEmoji = nil; personBirthday = nil; personIsAdmin = false
        goalType = "habit"; goalTarget = ""; goalUnit = ""; goalDeadlineOn = false; goalTrackingMode = "shared_total"; goalAssignEveryone = false
        cdEmoji = nil
        pantryAmount = ""; pantryUnit = ""; pantryLocation = "Pantry"; pantryExpiresOn = false; pantryLowAt = nil
        rewardEmoji = ""; rewardCost = ""; rewardRequiresApproval = nil
        mutateVerb = ""; mutateTargetKind = nil; mutateDescription = ""; mutateArgs = [:]
        mutateState = nil; mutateChosenId = nil; mutateResolveKey = ""
        detent = .large
    }

    // MARK: header
    private var header: some View {
        HStack(spacing: 8) {
            Image(systemName: "sparkles").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ai)
            Text("Add with AI").font(.system(size: 15, weight: .bold)).foregroundStyle(WF.ai)
            Spacer()
            Button("Cancel") { dismiss() }
                .font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ink2)
        }
    }

    // MARK: input
    private var inputView: some View {
        VStack(alignment: .leading, spacing: 14) {
            ZStack(alignment: .bottomTrailing) {
                TextField("Soccer practice Tuesday at 4pm for Wally…", text: $text, axis: .vertical)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(3...8)
                    .focused($focused)
                    .submitLabel(.go)
                    .onSubmit(parse)
                    .padding(16).padding(.trailing, 40)
                    .background(WF.panel)
                    .clipShape(RoundedRectangle(cornerRadius: WF.rLG, style: .continuous))

                Button { dictation.toggle() } label: {
                    Image(systemName: dictation.isListening ? "mic.fill" : "mic")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(dictation.isListening ? .white : WF.ink2)
                        .frame(width: 34, height: 34)
                        .background(dictation.isListening ? WF.primary : WF.card)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(dictation.isListening ? Color.clear : WF.hair, lineWidth: 1))
                }
                .buttonStyle(.plain).padding(10)
            }
            .onChange(of: dictation.transcript) { _, t in if !t.isEmpty { text = t } }

            WaffledPrimaryCTA(
                label: phase == .parsing ? "Thinking…" : "Tell Waffled",
                tint: WF.ai,
                isBusy: phase == .parsing,
                isDisabled: !canParse,
                action: parse
            )
        }
    }

    private var canParse: Bool {
        !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    // MARK: preview — a confident one-tap "glance", with the full field editor a tap away

    @ViewBuilder private var previewView: some View {
        if editKind == "mutate" { mutatePreview }
        else if editing { editorView } else { glanceView }
    }

    // MARK: mutate preview (Tier 2 — pick a candidate row, then commit)

    private var mutatePreview: some View {
        VStack(alignment: .leading, spacing: 12) {
            mutateHeaderCard
            mutateCandidateArea
            HStack(spacing: 10) {
                Button("Edit text") { phase = .input; focused = true; mutateResolveKey = "" }
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                if mutateChosenId != nil { mutateConfirmButton }
            }
            .buttonStyle(.plain)
        }
    }

    // The verb + target + description, with a compact "→ when / +amount / → who" summary.
    private var mutateHeaderCard: some View {
        HStack(spacing: 12) {
            WaffledEmojiTile(emoji: MutateLabels.icon(mutateVerb))
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(MutateLabels.verbLabel(mutateVerb).uppercased())
                        .font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ai)
                    Text(MutateLabels.targetLabel(mutateTargetKind))
                        .font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                }
                Text(mutateDescription).font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                if !mutateArgsSummary.isEmpty {
                    Text(mutateArgsSummary).font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                }
            }
            Spacer(minLength: 0)
        }
        .padding(14)
        .wfField(radius: WF.rLG)
    }

    // The resolve state machine (mirrors the web CandidatePicker): thinking → candidates,
    // or one of the three empty degrades (offline / unsupported-reason-only / no-match).
    @ViewBuilder private var mutateCandidateArea: some View {
        if let s = mutateState, s.forKey == mutateResolveKey {
            if s.offline {
                mutateHint("I need a connection for that.")
            } else if s.candidates.isEmpty {
                mutateHint(MutateLabels.emptyHint(unsupported: s.unsupported,
                                                  disabledReason: s.disabledReason,
                                                  targetKind: mutateTargetKind))
            } else {
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(s.candidates) { mutateCandidateRow($0) }
                    }
                }
                .frame(maxHeight: 260)
            }
        } else {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text("Finding a \(MutateLabels.targetLabel(mutateTargetKind)) like that…")
                    .font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink3)
            }
            .padding(.vertical, 6)
        }
    }

    private func mutateHint(_ text: String) -> some View {
        Text(text).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            .frame(maxWidth: .infinity, alignment: .leading).padding(.vertical, 6)
    }

    private func mutateCandidateRow(_ c: WaffledAPI.Candidate) -> some View {
        let on = mutateChosenId == c.id
        return Button { mutateChosenId = c.id } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(c.title).font(.system(size: 15, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink)
                    if let sub = c.subtitle, !sub.isEmpty {
                        Text(sub).font(.system(size: 12)).foregroundStyle(WF.ink3).lineLimit(1)
                    }
                }
                Spacer(minLength: 6)
                Image(systemName: on ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18)).foregroundStyle(on ? WF.ai : WF.hair)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(on ? WF.ai.opacity(0.1) : WF.card2)
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous)
                .strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1))
            .clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
        }
        .buttonStyle(.plain)
    }

    // Delete gets the danger tint (its own explicit tap — never an implicit commit).
    private var mutateConfirmButton: some View {
        WaffledPrimaryCTA(
            label: MutateLabels.confirmLabel(mutateVerb),
            tint: mutateVerb == "delete" ? WF.danger : WF.primary,
            isBusy: phase == .committing,
            isDisabled: mutateChosenId == nil,
            action: commit
        )
    }

    /// A compact "→ when / +amount / → who" line under the mutate title, from the parsed args.
    private var mutateArgsSummary: String {
        switch mutateVerb {
        case "reschedule":
            let parts = [mutateArgString("date").flatMap(mutateDateLabel),
                         mutateArgString("time").flatMap(mutateTimeLabel)].compactMap { $0 }
            return parts.isEmpty ? "" : "→ " + parts.joined(separator: " · ")
        case "log":
            if let n = mutateArgNumber("hours") { return "+\(trimNum(n)) hours" }
            if let n = mutateArgNumber("minutes") { return "+\(trimNum(n)) minutes" }
            if let n = mutateArgNumber("amount") { return "+\(trimNum(n))" }
            return ""
        case "reassign":
            return mutateArgString("personName").map { "→ \($0)" } ?? ""
        default:
            return ""
        }
    }
    private func mutateArgString(_ k: String) -> String? {
        if case let .string(s)? = mutateArgs[k] { return s }
        return nil
    }
    private func mutateArgNumber(_ k: String) -> Double? {
        switch mutateArgs[k] {
        case let .double(d)?: return d
        case let .int(i)?: return Double(i)
        default: return nil
        }
    }
    private func trimNum(_ n: Double) -> String { n == n.rounded() ? String(Int(n)) : String(n) }
    private func mutateDateLabel(_ ymd: String) -> String? {
        guard let d = DateFmt.date(ymd, "yyyy-MM-dd", sync.householdTz) else { return ymd }
        return DateFmt.string(d, "EEE, MMM d", sync.householdTz)
    }
    private func mutateTimeLabel(_ hm: String) -> String? {
        guard let d = DateFmt.date(hm, "HH:mm", sync.householdTz) else { return hm }
        return DateFmt.string(d, "h:mm a", sync.householdTz)
    }

    // Glance: the first guess. Tap Add to commit it as-is, or Edit to refine.
    private var glanceView: some View {
        VStack(alignment: .leading, spacing: 12) {
            glanceCard
            if let alt = serverAlt { altRow(alt) }
            HStack(spacing: 10) {
                Button { withAnimation(.snappy(duration: 0.22)) { editing = true } } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "slider.horizontal.3").font(.system(size: 13, weight: .semibold))
                        Text("Edit").font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                }
                commitButton
            }
            .buttonStyle(.plain)
        }
    }

    // Editor: the full, re-classifiable card we built — reached by the Edit tap.
    private var editorView: some View {
        VStack(alignment: .leading, spacing: 12) {
            understoodCard
            typeSwitcher
            HStack(spacing: 10) {
                Button("Edit text") { phase = .input; focused = true }
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(WF.ink)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(WF.panel).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
                commitButton
            }
            .buttonStyle(.plain)
        }
    }

    private var commitButton: some View {
        WaffledPrimaryCTA(
            label: addLabel,
            tint: WF.primary,
            isBusy: phase == .committing,
            isDisabled: !canCommit,
            action: commit
        )
    }

    // The confident summary line — icon, kind, what Waffled heard, and who it's for.
    private var glanceCard: some View {
        HStack(spacing: 12) {
            WaffledEmojiTile(emoji: Self.kinds.first { $0.key == editKind }?.icon ?? "✨")
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 6) {
                    Text(editKind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ai)
                    if thinking {
                        HStack(spacing: 3) {
                            ProgressView().controlSize(.mini)
                            Text("improving…").font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ai)
                        }
                    } else if !viaLabel.isEmpty {
                        Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3)
                    }
                }
                Text(editName.isEmpty ? namePlaceholder : editName)
                    .font(.system(size: 17, weight: .bold)).foregroundStyle(WF.ink)
                if !glanceDetail.isEmpty {
                    Text(glanceDetail).font(.system(size: 12.5)).foregroundStyle(WF.ink2)
                }
            }
            Spacer(minLength: 0)
            if let m = sync.member(named: evPerson) {
                Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 32)
            }
        }
        .padding(14)
        .wfField(radius: WF.rLG)
    }

    /// When the LLM and the on-device guess disagree on the kind, offer the other take —
    /// "this is what the LLM suggests" — as a one-tap toggle.
    private func altRow(_ alt: CaptureIntent) -> some View {
        let s = altSummary(alt)
        return Button { withAnimation(.snappy(duration: 0.2)) { switchToAlt() } } label: {
            HStack(spacing: 10) {
                Image(systemName: "sparkles").font(.system(size: 14, weight: .semibold)).foregroundStyle(WF.ai)
                VStack(alignment: .leading, spacing: 1) {
                    Text("\(altProviderLabel) reads it as a \(s.kind.lowercased())")
                        .font(.system(size: 11, weight: .bold)).foregroundStyle(WF.ai)
                    Text(s.title).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink).lineLimit(1)
                }
                Spacer(minLength: 6)
                Text("Use it").font(.system(size: 12.5, weight: .bold)).foregroundStyle(WF.ai)
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(WF.ai.opacity(0.08)).clipShape(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous))
            .overlay(RoundedRectangle(cornerRadius: WF.rMD, style: .continuous).strokeBorder(WF.ai.opacity(0.25), lineWidth: 1))
        }
        .buttonStyle(.plain)
    }

    private func altSummary(_ i: CaptureIntent) -> (kind: String, title: String) {
        switch i {
        case let .event(t, _, _, _, _, _, _): return ("Event", t)
        case let .grocery(n, _): return ("Grocery", n)
        case let .task(t, _, _, _, _): return ("Task", t)
        case let .meal(t, _, _, _): return ("Meal", t)
        case let .list(item, _, _): return ("List", item)
        case let .countdown(t, _, _, _): return ("Countdown", t)
        case let .person(n, _, _, _, _): return ("Family member", n)
        case let .goal(t, _, _, _, _, _, _): return ("Goal", t)
        case let .pantry(n, _, _, _, _, _): return ("Pantry", n)
        case let .reward(t, _, _, _, _, _): return ("Reward", t)
        case let .mutate(verb, _, d, _): return (MutateLabels.verbLabel(verb), d)
        }
    }

    private var altProviderLabel: String {
        switch serverAltVia {
        case "on-device": return "The on-device guess"
        case "anthropic": return "Claude"
        case "openai": return "OpenAI"
        case "ollama": return "The local LLM"
        default: return "The other parse"
        }
    }

    /// The one-line subtitle under the glance title, per kind.
    private var glanceDetail: String {
        switch editKind {
        case "event":
            let pattern = evAllDay ? "EEE, MMM d" : "EEE, MMM d · h:mm a"
            var detail = DateFmt.string(evDate, pattern, sync.householdTz) + (evAllDay ? " · all day" : "")
            // Surface the recurrence in the glance so "every Thursday" reads as recurring.
            if evRepeat.freq != .none {
                let cal = Cal.gregorian(sync.householdTz)
                let rr = Recurrence.buildRrule(evRepeat, start: evDate, cal)
                detail += " · 🔁 \(Recurrence.describeRrule(rr, start: evDate, cal))"
            }
            return detail
        case "task":
            let who = evPerson ?? "Up for grabs"
            let reward = taskStars > 0 ? " · \(taskStars) \(rewardLabel.lowercased())" : ""
            return who + reward
        case "grocery":
            return editQty.isEmpty ? "Adds to the grocery list" : "\(editQty) · grocery list"
        case "list":
            return editListName.isEmpty ? "Adds to a list" : "Adds to \(editListName)"
        case "meal":
            return "\(mealSlot.capitalized) · \(DateFmt.string(mealDate, "EEE, MMM d", sync.householdTz))"
        case "countdown":
            return DateFmt.string(cdDate, "EEE, MMM d", sync.householdTz)
        case "person":
            return personType == "kid" ? "Kid" : (personType == "teen" ? "Teen" : "Adult")
        case "goal":
            let typeLabel = goalType == "count" ? "Count" : (goalType == "total" ? "Total" : (goalType == "checklist" ? "Checklist" : "Habit"))
            let measured = goalType == "count" || goalType == "total"
            let target = measured && !goalTarget.isEmpty ? [goalTarget, goalUnit].filter { !$0.isEmpty }.joined(separator: " ") : ""
            let by = goalDeadlineOn ? "by " + DateFmt.string(goalDeadline, "MMM d", sync.householdTz) : ""
            return [typeLabel, target, by].filter { !$0.isEmpty }.joined(separator: " · ")
        case "pantry":
            let expires = pantryExpiresOn ? "expires " + DateFmt.string(pantryExpires, "MMM d", sync.householdTz) : ""
            return ["Adds to \(pantryLocation)", expires].filter { !$0.isEmpty }.joined(separator: " · ")
        case "reward":
            let cost = rewardCost.trimmingCharacters(in: .whitespaces)
            let approval = rewardRequiresApproval == true ? "needs approval" : ""
            return ["Adds to the reward shop", cost.isEmpty ? "" : "\(cost)★", approval].filter { !$0.isEmpty }.joined(separator: " · ")
        default: return ""
        }
    }

    private var understoodCard: some View {
        VStack(alignment: .leading, spacing: 11) {
            HStack(alignment: .top, spacing: 12) {
                WaffledEmojiTile(emoji: Self.kinds.first { $0.key == editKind }?.icon ?? "✨")
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 6) {
                        Text(editKind.uppercased()).font(.system(size: 11, weight: .heavy)).tracking(0.4).foregroundStyle(WF.ai)
                        if !viaLabel.isEmpty { Text(viaLabel).font(.system(size: 11, weight: .semibold)).foregroundStyle(WF.ink3) }
                        Spacer()
                    }
                    TextField(namePlaceholder, text: $editName)
                        .font(.system(size: 16, weight: .bold)).foregroundStyle(WF.ink)
                        .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                    kindFields
                }
            }
        }
        .padding(14)
        .wfField(radius: WF.rLG)
    }

    @ViewBuilder private var kindFields: some View {
        switch editKind {
        case "event":
            personChips(allowNone: true, noneLabel: "Nobody", icon: "🚫")
            HStack(spacing: 8) {
                DatePicker("", selection: $evDate, displayedComponents: .date).labelsHidden()
                if !evAllDay { DatePicker("", selection: $evDate, displayedComponents: .hourAndMinute).labelsHidden() }
                Spacer(minLength: 0)
            }
            toggleChip("All day", on: evAllDay) { evAllDay.toggle() }
            eventRepeatFields
        case "task":
            personChips(allowNone: true, noneLabel: "Up for grabs", icon: "🙌")
            HStack(spacing: 10) {
                Text(rewardLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
                stepper($taskStars)
                if sync.currencies.count > 1 { currencyMenu }
            }
        case "grocery":
            TextField("quantity (optional, e.g. 2 lbs)", text: $editQty)
                .font(.system(size: 14, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
        case "list":
            listPicker
            TextField("quantity (optional)", text: $editQty)
                .font(.system(size: 14, weight: .semibold))
                .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
        case "meal":
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(["breakfast", "lunch", "dinner", "snack"], id: \.self) { mt in
                    selectChip(mt.capitalized, on: mealSlot == mt) { mealSlot = mt }
                }
            }
            HStack { DatePicker("", selection: $mealDate, displayedComponents: .date).labelsHidden(); Spacer(minLength: 0) }
        case "countdown":
            HStack { DatePicker("", selection: $cdDate, displayedComponents: .date).labelsHidden(); Spacer(minLength: 0) }
        case "person":
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach([("adult", "Adult"), ("teen", "Teen"), ("kid", "Kid")], id: \.0) { key, label in
                    selectChip(label, on: personType == key) { personType = key }
                }
            }
            if personBlocked {
                Text("Only an adult can add family members.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.primaryD)
            }
        case "goal":
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach([("count", "Count"), ("total", "Total"), ("habit", "Habit"), ("checklist", "Checklist")], id: \.0) { key, label in
                    selectChip(label, on: goalType == key) { goalType = key }
                }
            }
            if goalType == "count" || goalType == "total" {
                HStack(spacing: 8) {
                    TextField("target", text: $goalTarget)
                        .keyboardType(.numberPad)
                        .font(.system(size: 14, weight: .semibold))
                        .frame(maxWidth: 96)
                        .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                    TextField("unit (e.g. books)", text: $goalUnit)
                        .font(.system(size: 14, weight: .semibold))
                        .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                }
            }
            HStack(spacing: 8) {
                toggleChip("By a date", on: goalDeadlineOn) { goalDeadlineOn.toggle() }
                if goalDeadlineOn {
                    DatePicker("", selection: $goalDeadline, displayedComponents: .date).labelsHidden()
                }
                Spacer(minLength: 0)
            }
            // Who's it for — a simple Just me (personal) vs Everyone (shared) choice,
            // resolved to participantIds on commit (web offers the richer per-person picker).
            // A viewer without `goal.manage` (kids) can only make a just-me goal — POST
            // /api/goals rejects others — so we don't offer Everyone.
            ChipFlow(spacing: 8, lineSpacing: 8) {
                selectChip("🙋 Just me", on: !goalAssignEveryone) { goalAssignEveryone = false }
                if sync.can("goal.manage") {
                    selectChip("👨‍👩‍👧 Everyone", on: goalAssignEveryone) { goalAssignEveryone = true }
                }
            }
            if goalBlocked {
                Text("Goals is turned off. Turn it on in Settings → Modules.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.primaryD)
            }
        case "pantry":
            HStack(spacing: 8) {
                TextField("amount", text: $pantryAmount)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: 96)
                    .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                TextField("unit (e.g. cans)", text: $pantryUnit)
                    .font(.system(size: 14, weight: .semibold))
                    .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
            }
            ChipFlow(spacing: 8, lineSpacing: 8) {
                ForEach(pantryLocations, id: \.self) { loc in
                    selectChip(loc, on: pantryLocation == loc) { pantryLocation = loc }
                }
            }
            HStack(spacing: 8) {
                toggleChip("Expires", on: pantryExpiresOn) { pantryExpiresOn.toggle() }
                if pantryExpiresOn {
                    DatePicker("", selection: $pantryExpires, displayedComponents: .date).labelsHidden()
                }
                Spacer(minLength: 0)
            }
            if pantryBlocked {
                Text("The Pantry module is turned off. Turn it on in Settings → Modules.")
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.primaryD)
            }
        case "reward":
            HStack(spacing: 8) {
                TextField("emoji", text: $rewardEmoji)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: 72)
                    .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                TextField("cost (stars)", text: $rewardCost)
                    .keyboardType(.numberPad)
                    .font(.system(size: 14, weight: .semibold))
                    .frame(maxWidth: 120)
                    .padding(.horizontal, 12).padding(.vertical, 10).innerInput()
                Spacer(minLength: 0)
            }
            toggleChip("Needs approval", on: rewardRequiresApproval == true) {
                rewardRequiresApproval = (rewardRequiresApproval == true) ? false : true
            }
            if rewardBlocked {
                Text(rewardBlockedReason)
                    .font(.system(size: 12.5, weight: .semibold)).foregroundStyle(WF.primaryD)
            }
        default: EmptyView()
        }
    }

    /// Location chips for the pantry editor — the common three, plus the current value
    /// if the parse produced a household-custom one (so it stays selectable).
    private var pantryLocations: [String] {
        var locs = ["Pantry", "Fridge", "Freezer"]
        if !pantryLocation.isEmpty, !locs.contains(pantryLocation) { locs.append(pantryLocation) }
        return locs
    }

    /// The `person` create is admin-only (adminRoute). A non-admin sees a reason and
    /// can't commit — the graceful analogue of the web's "unsupported" degrade.
    private var personBlocked: Bool { editKind == "person" && sync.currentPerson?.isAdmin != true }

    /// The `goal` create is gated on the Goals module (default on). When off, the viewer
    /// sees a reason and can't commit — the graceful analogue of the web's degrade.
    private var goalBlocked: Bool { editKind == "goal" && !sync.module(.goals) }

    /// The `pantry` module defaults OFF, so a pantry create is SUPPRESSED unless the
    /// module is enabled — the viewer sees a reason and can't commit (the graceful
    /// analogue of the web's suppress-when-off degrade), and we never POST.
    private var pantryBlocked: Bool { editKind == "pantry" && !sync.module(.pantry) }

    /// The `reward` create has TWO gates, both of which must hold: rewards must be on
    /// (chores module + the rewards sub-toggle) AND the viewer must hold `reward.manage`
    /// (kids don't). Either failing suppresses the commit — the graceful analogue of the
    /// web's degrade — and we never POST.
    private var rewardBlocked: Bool { editKind == "reward" && (!sync.rewardsOn || !sync.can("reward.manage")) }
    private var rewardBlockedReason: String {
        !sync.rewardsOn ? "Rewards are turned off." : "Ask a parent to add a reward."
    }

    // MARK: field pieces

    private func personChips(allowNone: Bool, noneLabel: String, icon: String) -> some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            if allowNone {
                selectChip("\(icon) \(noneLabel)", on: evPerson == nil) { evPerson = nil }
            }
            ForEach(sync.members) { m in
                let on = evPerson == m.name
                Button { evPerson = m.name } label: {
                    HStack(spacing: 6) {
                        Avatar(colorHex: m.colorHex, emoji: m.emoji ?? "🙂", size: 20)
                        Text(m.name).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink)
                    }
                    .padding(.leading, 6).padding(.trailing, 12).padding(.vertical, 6)
                    .background(on ? WF.ai.opacity(0.1) : WF.card2)
                    .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func selectChip(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink)
                .lineLimit(1).fixedSize()
                .padding(.horizontal, 12).padding(.vertical, 7)
                .background(on ? WF.ai.opacity(0.1) : WF.card2)
                .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func toggleChip(_ label: String, on: Bool, _ tap: @escaping () -> Void) -> some View {
        Button(action: tap) {
            HStack(spacing: 5) {
                Image(systemName: on ? "checkmark.square.fill" : "square").font(.system(size: 13)).foregroundStyle(on ? WF.ai : WF.ink3)
                Text(label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink2)
            }
            .padding(.horizontal, 11).padding(.vertical, 7)
            .background(on ? WF.ai.opacity(0.1) : WF.card2)
            .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    // MARK: event recurrence (capture parity with the web — Repeats + Until)

    /// A compact repeat picker for a captured event: a frequency menu (seeded by the
    /// AI's parse) plus an optional "ends on a date". Builds an RRULE on commit; the
    /// full per-occurrence editing lives in the calendar editor.
    @ViewBuilder private var eventRepeatFields: some View {
        HStack(spacing: 8) {
            Text("Repeats").font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink2)
            Menu {
                Button("Does not repeat") { evRepeat = .none }
                Button("Daily") { evRepeat = { var s = RepeatState.none; s.freq = .daily; return s }() }
                Button("Weekdays") { evRepeat = { var s = RepeatState.none; s.freq = .weekdays; return s }() }
                Button("Weekly") { evRepeat.freq = .weekly }   // keeps any AI-parsed day
                Button("Monthly") { evRepeat = { var s = RepeatState.none; s.freq = .monthly; return s }() }
                Button("Yearly") { evRepeat = { var s = RepeatState.none; s.freq = .custom; s.unit = .year; return s }() }
            } label: {
                HStack(spacing: 5) {
                    Text(captureRepeatLabel).font(.system(size: 13, weight: .semibold)).foregroundStyle(WF.ink)
                    Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
                }
                .padding(.horizontal, 11).padding(.vertical, 7)
                .background(WF.card2).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1)).clipShape(Capsule())
            }
            Spacer(minLength: 0)
        }
        if evRepeat.freq != .none {
            HStack(spacing: 8) {
                toggleChip("Ends on", on: evUntilOn) { evUntilOn.toggle() }
                if evUntilOn {
                    DatePicker("", selection: $evUntil, in: evDate..., displayedComponents: .date).labelsHidden()
                }
                Spacer(minLength: 0)
            }
        }
    }

    private var captureRepeatLabel: String {
        switch evRepeat.freq {
        case .none: return "Does not repeat"
        case .daily: return "Daily"
        case .weekdays: return "Weekdays"
        case .weekly: return "Weekly"
        case .monthly: return "Monthly"
        case .custom: return evRepeat.unit == .year ? "Yearly" : "Custom"
        }
    }

    private func stepper(_ value: Binding<Int>) -> some View {
        HStack(spacing: 12) {
            Button { if value.wrappedValue > 0 { value.wrappedValue -= 1 } } label: {
                Image(systemName: "minus.circle.fill").font(.system(size: 22)).foregroundStyle(value.wrappedValue > 0 ? WF.ink2 : WF.hair)
            }.buttonStyle(.plain)
            Text("\(value.wrappedValue)").font(.system(size: 16, weight: .heavy)).foregroundStyle(WF.ink).frame(minWidth: 18)
            Button { value.wrappedValue += 1 } label: {
                Image(systemName: "plus.circle.fill").font(.system(size: 22)).foregroundStyle(WF.primary)
            }.buttonStyle(.plain)
        }
    }

    private var currencyMenu: some View {
        Menu {
            ForEach(sync.currencies) { c in Button("\(c.symbol) \(c.label)") { taskCurrency = c.key } }
        } label: {
            chipBody {
                Text(sync.currencySymbol(taskCurrency)).font(.system(size: 13))
                Image(systemName: "chevron.down").font(.system(size: 10, weight: .bold)).foregroundStyle(WF.ink3)
            }
        }
    }

    private var listPicker: some View {
        Menu {
            ForEach(lists) { l in Button("\(l.emoji ?? "📝") \(l.name)") { editListName = l.name } }
        } label: {
            HStack {
                Text(editListName.isEmpty ? "Choose a list" : editListName)
                    .font(.system(size: 15, weight: .semibold)).foregroundStyle(editListName.isEmpty ? WF.ink3 : WF.ink).lineLimit(1)
                Spacer()
                Image(systemName: "chevron.down").font(.system(size: 12, weight: .bold)).foregroundStyle(WF.ink3)
            }
            .padding(.horizontal, 12).padding(.vertical, 11).innerInput()
        }
    }

    private var typeSwitcher: some View {
        ChipFlow(spacing: 8, lineSpacing: 8) {
            ForEach(Self.kinds, id: \.key) { k in
                let on = editKind == k.key
                Button { editKind = k.key } label: {
                    HStack(spacing: 5) {
                        Text(k.icon).font(.system(size: 13))
                        Text(k.label).font(.system(size: 13, weight: .semibold)).foregroundStyle(on ? WF.ai : WF.ink2)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(on ? WF.ai.opacity(0.1) : WF.card)
                    .overlay(Capsule().strokeBorder(on ? WF.ai : WF.hair, lineWidth: on ? 1.5 : 1)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func chipBody<V: View>(@ViewBuilder _ content: () -> V) -> some View {
        HStack(spacing: 6) { content() }
            .padding(.leading, 10).padding(.trailing, 12).padding(.vertical, 7)
            .background(WF.card2).overlay(Capsule().strokeBorder(WF.hair, lineWidth: 1)).clipShape(Capsule())
    }

    private var namePlaceholder: String {
        switch editKind {
        case "event": return "Event title"
        case "task": return "Chore title"
        case "meal": return "Meal"
        case "countdown": return "Countdown title"
        case "person": return "Name"
        case "goal": return "Goal"
        case "pantry": return "Item"
        case "reward": return "Reward"
        default: return "Item"
        }
    }
    private var rewardLabel: String { sync.currencies.first { $0.key == taskCurrency }?.label ?? "Stars" }
    private var addLabel: String {
        switch editKind {
        case "event": return "Add event"
        case "task": return "Add task"
        case "grocery": return "Add to groceries"
        case "list": return "Add to list"
        case "meal": return "Add meal"
        case "countdown": return "Add countdown"
        case "person": return "Add family member"
        case "goal": return "Add goal"
        case "pantry": return "Add to pantry"
        case "reward": return "Add reward"
        default: return "Add"
        }
    }
    private var canCommit: Bool {
        !editName.trimmingCharacters(in: .whitespaces).isEmpty
            && (editKind != "list" || !editListName.trimmingCharacters(in: .whitespaces).isEmpty)
            && !personBlocked && !goalBlocked && !pantryBlocked && !rewardBlocked
    }
    private var viaLabel: String {
        switch via {
        case "anthropic": return "via Claude"
        case "openai": return "via OpenAI"
        case "ollama": return "via local LLM"
        case "on-device": return "on device"   // the offline heuristic fallback
        default: return ""
        }
    }

    // MARK: actions
    private func parse() {
        dictation.stop()
        let t = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return }
        focused = false; error = nil; serverAlt = nil

        // 1) Instant on-device guess — shown immediately, so you can add it before the
        //    LLM even responds.
        let cal = Cal.gregorian(sync.householdTz)
        let local = CaptureHeuristic.parse(t, persons: sync.members.map(\.name), now: Date(), cal: cal, lists: lists.map(\.name))
        let localConfident = local != nil && CaptureHeuristic.looksConfident(local, text: t)
        if let local, localConfident { accept(local, via: "on-device", autoCommit: false) }
        else { phase = .parsing }
        thinking = true

        // 2) Upgrade with the configured LLM in the background.
        Task {
            let r = try? await sync.resolveCapture(t)
            // Bail if the user changed the text meanwhile, or opened the editor (don't
            // clobber their edits).
            guard text.trimmingCharacters(in: .whitespacesAndNewlines) == t, !editing else { thinking = false; return }
            thinking = false
            if let r, let si = r.intent, !r.fallback {
                if localConfident, let local, kindOf(si) != kindOf(local) {
                    serverAlt = si; serverAltVia = r.via          // disagree on kind → keep ours, offer theirs
                } else {
                    // Agree (or local weak) → take the LLM's read, but backfill a
                    // recurrence the (deterministic) heuristic found if the LLM dropped it.
                    accept(mergeRecurrence(llm: si, local: local), via: r.via, autoCommit: false)
                }
            } else if !localConfident {
                // LLM unavailable AND no confident on-device guess.
                if let local { accept(local, via: "on-device", autoCommit: false) }
                else { error = "Couldn’t understand that — try rephrasing."; phase = .input }
            }
            if DemoHooks.captureCommit { commit() }
        }
    }

    private func accept(_ i: CaptureIntent, via v: String, autoCommit: Bool = true) {
        intent = i; via = v; phase = .preview
        populate(i)
        if autoCommit, DemoHooks.captureCommit { commit() }
    }

    /// Keep the heuristic's recurrence when the LLM agreed it's an event but returned a
    /// one-off (small local models often miss "every Thursday"). The LLM still wins on
    /// title / person / time.
    private func mergeRecurrence(llm: CaptureIntent, local: CaptureIntent?) -> CaptureIntent {
        guard case let .event(t, s, a, p, llmRrule, sl, w) = llm, llmRrule == nil,
              case let .event(_, _, _, _, localRrule?, localSL, _) = local else { return llm }
        return .event(title: t, startsAt: s, allDay: a, personName: p,
                      rrule: localRrule, scheduleLabel: localSL.isEmpty ? sl : localSL, whenLabel: w)
    }

    private func kindOf(_ i: CaptureIntent) -> String {
        switch i {
        case .event: return "event"; case .grocery: return "grocery"; case .task: return "task"
        case .meal: return "meal"; case .list: return "list"; case .countdown: return "countdown"
        case .person: return "person"; case .goal: return "goal"; case .pantry: return "pantry"
        case .reward: return "reward"; case .mutate: return "mutate"
        }
    }

    /// Swap the shown intent for the other parse (LLM ↔ on-device), keeping the previous
    /// one offered so it's a one-tap toggle.
    private func switchToAlt() {
        guard let alt = serverAlt else { return }
        let prev = intent, prevVia = via
        accept(alt, via: serverAltVia, autoCommit: false)
        if let prev { serverAlt = prev; serverAltVia = prevVia } else { serverAlt = nil }
    }

    /// Seed the inline-editable fields from the parsed intent. `editKind` drives which
    /// card is shown; the user can re-classify it and the other fields carry over.
    private func populate(_ i: CaptureIntent) {
        editing = false   // always land on the confident glance first
        func date(_ s: String?) -> Date? {
            guard let s else { return nil }
            return Self.isoDF.date(from: s) ?? Self.isoFracDF.date(from: s)
        }
        switch i {
        case let .event(title, startsAt, allDay, personName, rrule, _, _):
            editKind = "event"; editName = title; evAllDay = allDay; evPerson = personName
            evDate = date(startsAt) ?? Date()
            evRepeat = Recurrence.parseRepeat(rrule)
            evUntilOn = false
        case let .grocery(name, quantity):
            editKind = "grocery"; editName = name; editQty = quantity ?? ""
        case let .task(title, personName, stars, rrule, _):
            editKind = "task"; editName = title; evPerson = personName
            taskStars = stars ?? 0; taskRrule = rrule
        case let .meal(title, d, mealType, _):
            editKind = "meal"; editName = title; mealSlot = mealType
            mealDate = date(d) ?? Date()
        case let .list(itemName, listName, quantity):
            editKind = "list"; editName = itemName; editQty = quantity ?? ""
            editListName = listName ?? (lists.first { $0.listType.lowercased() != "grocery" }?.name ?? "")
        case let .countdown(title, d, emoji, _):
            // Parse the day in the HOUSEHOLD tz (matching commit) so a device in another
            // zone doesn't shift it. Carry the server-parsed emoji through commit.
            editKind = "countdown"; editName = title; cdEmoji = emoji
            cdDate = DateFmt.date(d, "yyyy-MM-dd", sync.householdTz) ?? Date()
        case let .person(name, memberType, avatarEmoji, birthday, isAdmin):
            editKind = "person"; editName = name; personType = memberType
            personEmoji = avatarEmoji; personBirthday = birthday; personIsAdmin = isAdmin
        case let .goal(title, gType, targetValue, unit, deadline, trackingMode, audience):
            editKind = "goal"; editName = title; goalType = gType
            goalTrackingMode = trackingMode
            // Seed the who's-it-for toggle from the inferred audience: everyone → shared,
            // me/nil → just me (mirrors the web GoalWho seeding). A viewer without
            // `goal.manage` (kids) can only make a just-me goal, so clamp to that.
            goalAssignEveryone = audience == "everyone" && sync.can("goal.manage")
            goalUnit = unit ?? ""
            goalTarget = targetValue.map { $0 == $0.rounded() ? String(Int($0)) : String($0) } ?? ""
            // Parse the deadline in the HOUSEHOLD tz (matching commit) so it doesn't shift.
            if let deadline, let d = DateFmt.date(deadline, "yyyy-MM-dd", sync.householdTz) {
                goalDeadlineOn = true; goalDeadline = d
            } else {
                goalDeadlineOn = false
            }
        case let .pantry(name, amount, unit, location, expiresOn, lowAt):
            editKind = "pantry"; editName = name
            pantryAmount = amount ?? ""; pantryUnit = unit ?? ""
            pantryLocation = location.isEmpty ? "Pantry" : location
            pantryLowAt = lowAt   // carried through to commit (no editor field yet)
            // Parse the expiry in the HOUSEHOLD tz (matching commit) so it doesn't shift.
            if let expiresOn, let d = DateFmt.date(expiresOn, "yyyy-MM-dd", sync.householdTz) {
                pantryExpiresOn = true; pantryExpires = d
            } else {
                pantryExpiresOn = false
            }
        case let .reward(title, emoji, cost, _, _, requiresApproval):
            editKind = "reward"; editName = title
            rewardEmoji = emoji ?? ""
            rewardCost = cost.map(String.init) ?? ""
            rewardRequiresApproval = requiresApproval
        case let .mutate(verb, targetKind, description, args):
            // Act on an existing row: seed the marker, then resolve candidate rows. The user
            // picks one before committing — a mutate is never auto-committed (unlike a create).
            editKind = "mutate"; editName = description
            mutateVerb = verb; mutateTargetKind = targetKind
            mutateDescription = description; mutateArgs = args
            triggerMutateResolve()
        }
    }

    /// Kick off `/api/capture/resolve` for the current mutate marker, keyed on
    /// verb|targetKind|description so a re-parse to the SAME target doesn't re-resolve and a
    /// stale response (text changed underneath) is dropped. Auto-selects a lone candidate.
    private func triggerMutateResolve() {
        let key = "\(mutateVerb)|\(mutateTargetKind ?? "")|\(mutateDescription)"
        guard key != mutateResolveKey else { return }
        mutateResolveKey = key
        mutateState = nil
        mutateChosenId = nil
        Task {
            let state = await sync.resolveMutate(verb: mutateVerb, targetKind: mutateTargetKind,
                                                 description: mutateDescription, args: mutateArgs, key: key)
            guard mutateResolveKey == key else { return }   // superseded by a newer parse
            mutateState = state
            if state.candidates.count == 1 { mutateChosenId = state.candidates.first?.id }
        }
    }

    private func commit() {
        if editKind == "mutate" { commitMutate(); return }
        error = nil; phase = .committing
        let name = editName.trimmingCharacters(in: .whitespacesAndNewlines)
        let qty = editQty.trimmingCharacters(in: .whitespaces).isEmpty ? nil : editQty.trimmingCharacters(in: .whitespaces)
        Task {
            let ok: Bool
            switch editKind {
            case "event":
                let cal = Cal.current
                let start = evAllDay ? (cal.date(bySettingHour: 12, minute: 0, second: 0, of: evDate) ?? evDate) : evDate
                let rrule = Recurrence.buildRrule(evRepeat, start: start)
                var endAt: String?
                if rrule != nil, evUntilOn {
                    let eod = cal.date(bySettingHour: 23, minute: 59, second: 0, of: evUntil) ?? evUntil
                    endAt = Self.isoDF.string(from: eod)
                }
                ok = await sync.commitEvent(title: name, startsAtISO: Self.isoDF.string(from: start),
                                            allDay: evAllDay, personName: evPerson, rrule: rrule, recurrenceEndAt: endAt)
            case "grocery":
                ok = await sync.commitGrocery(name: name, quantity: qty)
            case "task":
                ok = await sync.commitTask(title: name, personName: evPerson,
                                           stars: taskStars > 0 ? taskStars : nil,
                                           rewardCurrency: taskCurrency, rrule: taskRrule)
            case "meal":
                let d = Self.isoDF.string(from: mealDate)
                ok = await sync.commitMeal(title: name, date: d, mealType: mealSlot)
            case "list":
                ok = await sync.commitListItem(item: name, listName: editListName, quantity: qty)
            case "countdown":
                let d = DateFmt.string(cdDate, "yyyy-MM-dd", sync.householdTz)
                ok = await sync.commitCountdown(title: name, date: d, emoji: cdEmoji)
            case "person":
                // Admin-only create — refuse gracefully rather than POSTing a 403.
                guard sync.currentPerson?.isAdmin == true else {
                    error = "Only an adult can add family members."; phase = .preview; return
                }
                ok = await sync.commitPerson(name: name, memberType: personType,
                                             avatarEmoji: personEmoji, birthday: personBirthday, isAdmin: personIsAdmin)
            case "goal":
                // Module-gated — refuse gracefully rather than POSTing when Goals is off.
                guard sync.module(.goals) else {
                    error = "Goals is turned off. Turn it on in Settings → Modules."; phase = .preview; return
                }
                // count/total carry a numeric target + unit; habit/checklist don't. Downgrade
                // a count/total with no real number to a habit (mirrors the server).
                let measured = goalType == "count" || goalType == "total"
                let target = measured ? Double(goalTarget.trimmingCharacters(in: .whitespaces)) : nil
                let type = measured && target == nil ? "habit" : goalType
                let unit = (measured && !goalUnit.trimmingCharacters(in: .whitespaces).isEmpty) ? goalUnit.trimmingCharacters(in: .whitespaces) : nil
                let deadline = goalDeadlineOn ? DateFmt.string(goalDeadline, "yyyy-MM-dd", sync.householdTz) : nil
                // Just me → the current viewer; Everyone → all household members. A viewer
                // without `goal.manage` (kids) may only assign themselves — POST /api/goals
                // 403s if a non-manager includes other participants — so clamp to just-me.
                let everyone = goalAssignEveryone && sync.can("goal.manage")
                let participantIds = everyone
                    ? sync.members.map(\.id)
                    : (sync.currentPersonId.map { [$0] } ?? [])
                ok = await sync.commitGoal(title: name, goalType: type, trackingMode: goalTrackingMode,
                                           targetValue: type == "habit" || type == "checklist" ? nil : target,
                                           unit: type == "habit" || type == "checklist" ? nil : unit, deadline: deadline,
                                           participantIds: participantIds)
            case "pantry":
                // Pantry defaults OFF — suppress the commit entirely rather than POSTing
                // when the module is disabled (mirrors the web suppress-when-off gate).
                guard sync.module(.pantry) else {
                    error = "The Pantry module is turned off. Turn it on in Settings → Modules."; phase = .preview; return
                }
                let amount = pantryAmount.trimmingCharacters(in: .whitespaces)
                let unit = pantryUnit.trimmingCharacters(in: .whitespaces)
                let expiresOn = pantryExpiresOn ? DateFmt.string(pantryExpires, "yyyy-MM-dd", sync.householdTz) : nil
                ok = await sync.commitPantry(name: name, amount: amount.isEmpty ? nil : amount,
                                             unit: unit.isEmpty ? nil : unit,
                                             location: pantryLocation.isEmpty ? "Pantry" : pantryLocation,
                                             expiresOn: expiresOn, lowAt: pantryLowAt)
            case "reward":
                // TWO gates — refuse gracefully rather than POSTing when rewards are off or
                // the viewer can't manage rewards (mirrors the web suppress-when-blocked gate).
                guard sync.rewardsOn, sync.can("reward.manage") else {
                    error = rewardBlockedReason; phase = .preview; return
                }
                let emoji = rewardEmoji.trimmingCharacters(in: .whitespaces)
                let cost = Int(rewardCost.trimmingCharacters(in: .whitespaces))
                ok = await sync.commitReward(title: name, emoji: emoji.isEmpty ? nil : emoji,
                                             cost: cost.map { max(0, $0) }, requiresApproval: rewardRequiresApproval)
            default:
                ok = false
            }
            if ok {
                dismiss()
            } else {
                error = sync.lastError ?? "Couldn't add that."; phase = .preview
            }
        }
    }

    /// Commit the chosen mutate candidate. Requires a pick (so a mutate is never committed
    /// without one — the DemoHooks auto-commit path no-ops here); flashes the server message
    /// on failure and keeps the picker up so the user can retry or pick again.
    private func commitMutate() {
        guard let id = mutateChosenId,
              let chosen = mutateState?.candidates.first(where: { $0.id == id }) else {
            phase = .preview; return
        }
        error = nil; phase = .committing
        Task {
            let r = await sync.commitMutate(verb: mutateVerb, targetKind: mutateTargetKind,
                                            targetId: id, args: mutateArgs, meta: chosen.meta)
            if r.ok {
                dismiss()
            } else {
                error = r.message; phase = .preview
            }
        }
    }
}

private extension View {
    /// The white inner-field treatment used inside the "Waffled understood" card.
    func innerInput() -> some View { wfField(fill: WF.card2) }
}
