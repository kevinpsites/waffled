# Android port plan

Bring the Waffled Android app to **feature and visual parity with iOS** (`apps/ios`,
218 Swift files / 59,805 LOC), built by a fan-out of subagents working in isolated
worktrees that all merge into **one branch and one PR**.

Status legend: ✅ verified on this machine · 🚧 planned · ⚠️ decision needed

---

## 0. What is already verified

Every toolchain claim below was proven on this machine by building, installing, and
launching a real Compose app that constructs PowerSync `Schema`/`Table`/`Column`
objects at runtime. **These are not assumptions — they are measured**, and several
contradict the obvious defaults. Bake them into Phase 0.

| Thing | Value | Note |
|---|---|---|
| JDK | Android Studio JBR **21** — `/Applications/Android Studio.app/Contents/jbr/Contents/Home` | ✅ `java -version` → 21.0.10. **No JDK on `PATH`** (`/usr/bin/java` is the macOS stub) and `JAVA_HOME` is unset. Homebrew has `openjdk` **26** (too new for AGP) and keg-only `openjdk@17`. |
| `ANDROID_HOME` | **`/opt/homebrew/share/android-commandlinetools`** | ✅ **Non-standard.** There is no `~/Library/Android/sdk`. Every worktree needs `local.properties` written before Gradle runs (see §3.3). |
| AGP | **9.3.1** (latest stable) | ✅ AGP **9 has built-in Kotlin** — adding `org.jetbrains.kotlin.android` is now a **hard error**. |
| Gradle | **9.6.1** | ✅ AGP **8.x is incompatible with Gradle ≥ 9.6** (`InternalProblems` was removed). Pin the wrapper; do not rely on system Gradle drifting. |
| Kotlin | **2.4.10** (latest stable) | ✅ AGP 9 owns the Kotlin toolchain, but setting the Compose plugin to 2.4.10 pulls `kotlin-stdlib` **2.4.10** through the whole graph — verified via `dependencies --configuration debugCompileClasspath`. |
| Compose | BOM **2026.08.00** (latest stable) | ✅ Dated BOMs are stable releases. |
| Compose compiler | plugin `org.jetbrains.kotlin.plugin.compose` **2.4.10**, explicit | ✅ Required since Kotlin 2.0; `buildFeatures { compose = true }` alone fails. Must match the Kotlin version. |
| Toolchain | `jvmToolchain(21)` | ✅ `jvmToolchain(17)` **fails** — Gradle can't auto-detect the keg-only Homebrew 17. |
| SDK | `compileSdk 36`, `targetSdk 36`, `minSdk 26` | ✅ `platforms/android-36`, build-tools 35.0.0 + 36.0.0 installed. |
| PowerSync | **`com.powersync:core:1.14.1`** | ✅ Resolves and compiles in a **plain (non-KMP) Android module** — `core-android`, `compose-android`, `core-jvm` all publish to Maven Central. Matches the iOS Swift SDK's 1.14.x line, so no protocol skew. |
| Emulator | AVD **`vpac`** — Pixel 8, API 36, arm64, `google_apis` | ✅ Booted; `adb install` → `am start` → `screencap` round-trip confirmed. Play Services present, **no Play Store**. A physical device also works. |

**Package / app id:** `app.waffled` on iOS. Android must use a dotted id — a bare
segment fails manifest merging.

### 0.1 ⚠️ Reaching the server — solve this once, centrally

**`localhost:8080` from an Android emulator is the emulator itself.** This is the single
most likely way to burn a whole parallel wave, so it is closed in Phase 0, not discovered
eighteen times.

- **The host Caddy origin is `http://10.0.2.2:8080` from the emulator**, and the Mac's
  **LAN IP** from a physical phone. So the Android `AppConfig` debug default **must not be
  `http://localhost:8080`** (the iOS default) — use `10.0.2.2:8080`.
- **PowerSync fails independently of REST.** `fetchCredentials` returns a `powerSyncUrl`
  *issued by the server*; if the stack advertises a `localhost` `POWERSYNC_PUBLIC_URL`,
  REST will work and sync will silently sit at "Offline". `POWERSYNC_PUBLIC_URL` must
  resolve from the device. This is the same trap already recorded for iPad-on-LAN.
- **Cleartext**: the server address is user-editable at runtime, so we cannot enumerate
  domains in `network_security_config.xml`. See the decision in §7.5.
- **The stack itself**: `./waffled up` must be run from `~/dev/nook`, **never from a
  worktree** — compose bind mounts bake the working directory into the running stack, and
  deleting the worktree later breaks it.

> **Phase 0 exit criterion:** the reference feature loads real data from the running stack
> on the emulator, **and** PowerSync reports `connected`. Not "it compiles".

---

## 1. What we are porting

### 1.1 The load-bearing discovery

**PowerSync mirrors only five tables. Everything else is plain REST.**

`households`, `persons`, `events`, `event_participants`, `event_occurrences`
(`apps/ios/Sources/Waffled/Sync/SyncSchema.swift`). Chores, goals, meals, recipes,
lists, pantry, rewards, photos, Family Night and Waffled-Bites are **online-only,
fetch-on-view REST**.

Consequence: **offline-first work applies to Calendar + People only.** We do *not*
need offline write support for ~80% of the app. That is the single biggest scope
reduction available, and it shapes the whole architecture.

### 1.2 Feature inventory (17 areas, 42,977 LOC of feature code)

| Feature | iOS LOC | Sync | Notes |
|---|---:|---|---|
| Meals | 8,834 | REST | Week/month planners, AI plan, recipe library + editor, Meal Builder plates, Cook Mode with background timers |
| Goals | 6,075 | REST | Membership model, logging, milestones, streaks, Health auto-fill, **8 chart/heatmap views** |
| Settings | 5,012 | REST | **15 panels** |
| Kiosk | 4,205 | — | The entire tablet experience |
| Lists | 3,401 | REST | Lists index **+ the Grocery board** (by aisle / by meal, pantry staples, reorder, share-as-text) |
| Calendar | 2,978 | **PowerSync** | Agenda + month grid, person filter, event editor, recurrence, countdowns |
| Pantry | 2,843 | REST | Barcode → Open Food Facts, allergens, expiry, cook-from-pantry |
| Family | 1,705 | mixed | Hub, person spotlight, approvals queue, sync status |
| Chores | 1,572 | REST | Board, up-for-grabs, approve/reject, streaks, photo proof |
| Rewards | 1,285 | REST | Balances, catalog, shops, redemptions, confetti, jar |
| Capture | 1,279 | REST | "Add anything" AI sheet (8 intents) + dictation |
| Photos | 991 | REST | Family photo wall |
| Waffled-Bites | 950 | REST | Paired bedside-device control panel |
| Today | 948 | mixed | iPhone home, customizable cards |
| FamilyNight | 413 | REST | Rotating agenda parts |
| Auth | 280 | — | Login gate, splash |
| Shared | 206 | — | `RestDomain`, offline banner, event row |

**Note there is no `Groceries` feature** — groceries live inside `Lists/` plus
`Meals/GroceryWeeks.swift`. Two features are easy to forget: **Photos** and
**Waffled-Bites**.

### 1.3 The app shell

`DeviceExperience` branches on **`userInterfaceIdiom == .pad`** (idiom, not size
class — deliberate). iPhone is portrait-only; iPad allows all orientations.

- **Phone**: a hand-drawn 5-slot bottom bar (not `TabView`) because of the raised
  centre ✨ FAB. Slots: Today, Calendar, **flex module slot**, Family + FAB. The flex
  slot shows Meals if enabled, else backfills Goals → Chores → Lists → Pantry, keeping
  the bar at 5 so the FAB stays centred. Five nav stacks are lifted to root so
  re-tapping a tab pops to root. Content scrolls *under* the bar (`tabBarClearance = 110`).
- **Tablet (kiosk)**: fixed left nav rail + detail pane, **user-customisable rail**
  (up to 5 pinned items), screensaver overlay, boot cover with an 8s stall escape,
  device pairing + per-person PIN claim.

⚠️ **There are two fully duplicated view trees, not one.** Kiosk Today renders
`KioskDashboard` (993) *and* kiosk Calendar renders `KioskCalendarView` (998) —
~1,990 LOC of tablet-only screen code. Lists/Family are thin hosts; Chores, Goals,
Rewards, Meals, Pantry, Photos and Settings reuse the phone views directly.

### 1.4 The REST client

`Sync/WaffledAPI.swift` is **one 4,124-LOC file**: ~92 path literals, **245 funcs**,
**264 nested DTO structs**, across 244 distinct endpoints in 26 server modules.

**There is no OpenAPI spec and no repo-wide zod schema** — I checked. `WaffledAPI.swift`
*is* the contract. So the client must be hand-ported, but it is **sliced per feature**
(`ChoresApi`, `MealsApi`, …) rather than reproduced as one god-object. That slicing is
precisely what makes the fan-out conflict-free, and it aligns with the 26 server modules.

### 1.5 The refresh bus

There are no reactive queries for non-synced data. Instead `SyncManager` exposes
integer revision counters — `choresRev`, `rewardsRev`, `goalsRev`, `listsRev`,
`modulesRev` — bumped by `touchGoals()` / `bumpChores()` / `bumpLists()`; views
`.onChange` them and re-fetch. **Android needs an equivalent invalidation bus**
(a `SharedFlow<Domain>` in `core:sync`). Port it in Phase 0 — every feature depends on it.

`Features/Shared/RestDomain.swift` (35 LOC) is the primitive every card uses:
`apply(null)` = fetch failed, keep the prior value but mark loaded (never blank a
populated card, never sit on "Loading…" forever); `apply([])` = genuinely empty.
Small but load-bearing — **port it first**.

---

## 2. Architecture

**Plain Android + Kotlin + Compose. Not KMP.** iOS is already Swift and stays Swift;
KMP would buy nothing and complicate the build. `com.powersync:core` resolves fine in a
plain Android module (✅ verified).

```
apps/android/
  settings.gradle.kts
  gradle/libs.versions.toml        # single version catalog — FROZEN after Phase 0
  gradlew                          # wrapper pinned to Gradle 9.6.1
  app/                             # shell, nav host, DI wiring, manifest
  core/design/                     # WF tokens + shared components — FROZEN after Phase 0
  core/network/                    # HTTP client, auth interceptor, error text, RestDomain
  core/model/                      # cross-feature DTOs: Person, Household, Event, Money
  core/sync/                       # PowerSync schema + connector + SyncManager + Rev bus
  core/testing/                    # MockWebServer harness + fixtures
  feature/today/  feature/calendar/  feature/lists/  …   # one module per feature
```

**One Gradle module per feature is the ownership boundary.** An agent owns
`feature/<name>/**` plus `core/network/api/<Name>Api.kt` and **nothing else**.

### 2.1 Stack choices

| Concern | Choice | Why |
|---|---|---|
| UI | Compose + Material3 (tokens overridden, see §2.2) | — |
| Nav | Navigation-Compose, one `NavHost` per tab stack | Mirrors the five lifted iOS stacks |
| HTTP | **Ktor client** | PowerSync already pulls Ktor in — avoids a second HTTP stack |
| JSON | kotlinx.serialization | Ktor-native |
| DI | Hilt | Standard; keeps agent modules independent |
| Images | **Coil**, memory cache with a synchronous-hit path | See the perf trap in §5 |
| State | `StateFlow` + `collectAsStateWithLifecycle` | Replaces `@Observable` |
| Charts | Vico | Replaces Swift Charts (2 views) |
| Tests | JVM unit tests + **MockWebServer**; Compose UI tests via `createAndroidComposeRule` | See §4 |

### 2.2 The design system is the highest-leverage thing to get right first

`copy the design exactly` lives or dies here. `DesignSystem/` is only **5 files /
692 LOC** — it ports quickly and must be **frozen before any feature agent starts**,
or seventeen agents invent seventeen palettes.

**Colour tokens** — exact hex, light/dark. The web CSS
(`apps/web/src/styles/waffled.css`) is the **source of truth**; iOS mirrors it; Android
becomes the third mirror. Do not invent platform-only colours.

| Token | Light | Dark |
|---|---|---|
| `canvas` | `#FAF7F2` | `#14110C` |
| `rail` | `#F1ECE3` | `#1B160F` |
| `panel` | `#F4EFE7` | `#1A1710` |
| `card` | `#FFFFFF` | `#232019` |
| `card2` | `#FCFAF6` | `#1C1811` |
| `ink` | `#1D1D1F` | `#F3EEE4` |
| `ink2` | `#6B6B70` | `#ADA69A` |
| `ink3` | `#A6A29B` | `#726B5E` |
| `onInk` | = `canvas` | = `canvas` |
| `hair` | `#282118` @ .08 | `#FFFFFF` @ .10 |
| `hair2` | `#282118` @ .045 | `#FFFFFF` @ .06 |
| `line` | `#282118` @ .18 | `#FFFFFF` @ .18 |
| `primary` | `#EC6049` | `#EC6049` (fixed) |
| `primaryD` | `#D84A33` | `#F0745F` |
| `gold` | `#F3A93B` | `#F3A93B` (fixed) |
| `ai` | `#8C74E8` | `#6E56CF` |
| `ai2` | `#A48CF0` | `#8C74E8` |
| `aiD` | `#6A3FC4` | `#B9A3F5` |
| `success` | `#25A368` | `#34B87A` |
| `danger` | `#C0392B` | `#E15B4C` |
| `warn` | `#C77A1A` | `#E8A13E` |
| `info` | `#2F7FED` | `#4C9BFF` |
| `primaryT` | `#F3E2D8` solid | `#EC6049` @ .18 |
| `aiT` | `#EFEAFC` solid | `#8C74E8` @ .20 |
| `successT` | `#E4F5EC` solid | `#34B87A` @ .20 |
| `dangerT` | `#FBE3E1` solid | `#E15B4C` @ .18 |
| `warnT` | `#FDF2DD` solid | `#E8A13E` @ .18 |
| `infoT` | `#E7F0FE` solid | `#4C9BFF` @ .20 |

**Family colours** — `.solid` fixed in both themes, `.tint` washes in dark:

| Slot | Solid | Tint light | Tint dark |
|---|---|---|---|
| person1 | `#2F7FED` | `#E7F0FE` | `#2F7FED` @ .20 |
| person2 | `#E0548B` | `#FCE9F1` | `#E0548B` @ .22 |
| person3 | `#25A368` | `#E4F5EC` | `#25A368` @ .20 |
| person4 | `#8A5CF0` | `#F0E9FD` | `#8A5CF0` @ .22 |

Accent `#EC6049`; launch background `#FAF7F2` (matches `canvas` so the splash hands off
seamlessly).

**Radii** — the only declared non-colour scale: `rXS 8 · rSM 12 · rMD 16 · rLG 22 ·
rXL 30`, plus `tabBarClearance = 110`, `bottomBarClearance` (110 phone / 0 kiosk).

**Shadows** — `wfShadow1`: light `#282118` @ .05, r1.5, y1 / dark black @ .45.
`wfShadow3` (the FAB): light `#282118` @ .12, r18, y8 / dark black @ .60.

**Typography and spacing are NOT tokenised on iOS** — every call site inlines a size.
Measured de-facto scale, which Android should *declare* as a real token set:

- Font sizes by frequency: 13 (309×), 14 (275), 12 (267), 15 (233), 16 (144), 11 (141),
  12.5 (117), 17 (52), 10 (42), 18 (41), 20 (36), 22 (28) — half-steps in use
  (9.5–14.5).
- Padding: 12 (209×), 14, 8, 10, 16, 11, 7, 13, 6, 20.
- Spacing: 8 (216×), 12, 10, 0, 6, 14, 5/9/4, 16.

The only type helper is `WF.serif(size, weight)` → `.system(design: .serif)` (New York).
**Android has no New York** — bundle a serif (Newsreader or Source Serif) and pin the
metrics.

**Dark mode rules** (from `apps/ios/DARK_MODE.md`; its "audit" section is a stale
pre-implementation snapshot — ignore that part):
1. Warm dark, never cold. Never pure black or blue-grey.
2. Brand / AI / per-person hues stay **exactly fixed** across themes — that fixedness
   *is* the brand.
3. Only two adjustments: pale tints become **low-opacity washes** of the same hue
   (18–22%), and **elevation inverts** (in dark, `card` is *lighter* than `canvas`).
4. **The `onInk` rule** — text on a solid `WF.ink` fill uses `WF.onInk`, never literal
   white. `ink` flips to warm off-white in dark, so white goes invisible. *This has bitten
   the team twice.* White is only correct on a saturated **coloured** fill.
5. One source of truth for the scheme; the only deliberate exception is the screensaver
   (always dark).

Locked by `apps/ios/Tests/ThemeTests.swift` — **cross-check the Android palette against
that file.**

**17 shared components to port before any screen work**: `WaffledCard`,
`WaffledFieldCard`, `SectionLabel`, `Pill`, `WaffledPrimaryCTA`, `Avatar`,
`WaffledLoading`, `WaffledEmptyState`, `DismissibleErrorBanner`, `AICaptureBar`,
`WaffledEmojiTile`, `WaffledStatusBadge`, `DisclosureChevron`, `WaffledMenuPill`,
`WaffledSettingsMenuLabel`, `ApprovalActionPair`, `WeekdayToggleChip` — plus the three
modifiers from `FieldStyles.swift` (`wfField`, `wfChip`, `wfKeyboardDoneToolbar`) and
`LockNote`.

> Two menu families exist **by design** (`WaffledMenuPill` app-wide,
> `WaffledSettingsMenuLabel` in Settings). Don't add a third.

### 2.3 Gates (server-parity, must be reimplemented exactly)

- **Modules** — 8-key catalog `chores, goals, meals, lists, pantry, familyNight,
  waffledBites, quotes`. `quotes` is permanently unavailable. Default-off: `pantry`,
  `familyNight`, `waffledBites`. `module(k) = flags[k] ?? k.defaultOn`; return catalog
  defaults *before* load so the UI doesn't flash empty.
- **Capabilities** — `can(c) = isAdmin || capabilities.contains(c)`; four capabilities:
  `chore.manage`, `chore.approve`, `reward.manage`, `reward.approve`. They gate
  independently (a chores-only grant shows the queue with only its buttons).
- **Rewards is a sub-flag of chores**, not its own module:
  `rewardsOn = module(chores) && rewardsSubEnabled`.

Mirrors `apps/api/src/platform/modules.ts`; the server enforces independently.

---

## 3. Delegation model

### 3.1 The failure this design avoids

`Agent(isolation: 'worktree')` branches from **`origin/main`**, not from the session
branch. Twelve agents launched that way would each start from a tree with **zero Android
code** and would each independently invent `settings.gradle.kts`, the version catalog,
`Theme.kt`, the HTTP core, the nav graph and a `Person` class. The merge would be
unresolvable.

So: **a serial Phase 0 lands first, and every feature worktree branches from it.**

### 3.2 Branch topology

```
main
 └── android-port                 ← integration branch; the PR's head
      ├── android/calendar        ← worktree per agent
      ├── android/lists
      ├── android/meals-planner
      └── …                       ← all merge back into android-port
```

**One PR.** Per repo convention a batch is one PR with one commit per unit of work —
including follow-ups added later in the same effort. Feature branches merge into
`android-port`; only `android-port` gets a PR.

### 3.3 Agent bootstrap (mandatory preamble for every feature agent)

> ⚠️ **Learned the hard way, on the pilot.** Creating the worktree yourself and merely
> *telling* the agent to work there **does not work**: a subagent inherits the launching
> session's worktree isolation root, and every Bash call into a different worktree is
> refused. `EnterWorktree(path=…)` changes the agent's cwd but *not* its isolation root,
> which then wedges Bash entirely — cwd is resolved before the command runs, so even
> `cd back && …` is refused, and `ExitWorktree` is unavailable to a cwd-pinned subagent.
> The pilot burned its whole run on this and built nothing.
>
> **Launch feature agents with `isolation: "worktree"`** so the agent gets its own
> isolation root. That default branches from `origin/main`, which has no Android code, so
> the agent's **first action must be** to rebase onto the integration branch:
>
> ```bash
> git reset --hard android-port      # local ref; worktrees share the repo
> ```
>
> Verify with `ls apps/android/core/design/` before doing anything else — if that
> directory is empty, the reset didn't take and nothing else will work.

Historic note — creating the worktree explicitly from the integration branch is the right
*shape*, but only works for a worktree the launching session will use itself:

```bash
git worktree add .claude/worktrees/android-<feature> -b android/<feature> android-port
```

Then, before Gradle runs (`local.properties` is gitignored and the SDK path here is
non-standard — this will bite every agent at once otherwise):

```bash
echo "sdk.dir=/opt/homebrew/share/android-commandlinetools" > apps/android/local.properties
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export ANDROID_HOME=/opt/homebrew/share/android-commandlinetools
export PATH="$ANDROID_HOME/platform-tools:$PATH"
```

And, if the agent needs a live stack: **run `./waffled up` from `~/dev/nook`, never from
the worktree** (§0.1). Point the app at `http://10.0.2.2:8080`, not `localhost`.

**Do not** put feature agents in one shared worktree — parallel Gradle invocations fight
over `.gradle/` locks and `build/`.

### 3.4 Ownership rules given to every agent

1. You own `apps/android/feature/<name>/**` and `core/network/api/<Name>Api.kt`. **Touch
   nothing else.**
2. `core/design/**` and `gradle/libs.versions.toml` are **frozen**. Need a token or a
   component that doesn't exist? **Stop and report** — do not add one locally.
3. Reuse hierarchy, in order: a **native control** first (Material3 / Compose
   Foundation); then **shared components + tokens**; hand-roll only if neither fits, and
   **say why in a comment**.
4. TDD: the failing test comes first (§4).
5. Your feature must build (`:feature:<name>:assembleDebug`) and its tests must pass
   before you report done.

---

## 4. TDD — the iOS test suite is the port spec

The repo mandates TDD, and here it maps unusually cleanly.

`apps/ios/Tests/` is **59 files / 7,579 LOC / 638 test cases** in **Swift Testing**
(`@Test`/`#expect`, not XCTest). They cover **pure logic only** — there are no UI or
snapshot tests. That pure-logic layer is fully specified independent of SwiftUI, which
means:

> **For every feature: translate the Swift test file to Kotlin first, watch it fail,
> then port the logic until it passes.** That is real TDD *and* it guarantees behavioural
> parity rather than approximate parity.

Highest-value suites to translate: `SyncLogicTests` (495 — timestamp parsing, timezone
day-bucketing, agenda ordering, CRUD upload shape), `ListGroupingTests` (247),
`RecurrenceTests` (238), `ShareListTests` (230), `DashboardModelTests` (222),
`MealBuilderTests` (436), `CookSessionTests` (387), `MealPlanSwapTests` (313),
`MealDecodingTests` (324), `EventColorTests` (161), `GoalStatsTests` (160),
`CountdownsModelTests` (167), `PeopleColumnsTests` (104), **`ThemeTests` (120 — locks the
palette)**.

**Harness decision, made once here so seventeen agents don't each pick one:**

- **API layer** → JVM tests + **OkHttp MockWebServer**. Closest analogue to the repo's
  API integration style (real client against a real server, asserting on responses).
- **Pure logic** → plain JVM `kotlin.test`.
- **Screens** → Compose UI tests (`createAndroidComposeRule`) on the emulator, for
  smoke/interaction only. Mirroring iOS, screens are otherwise verified by eye.
- **Palette parity** → one test asserting the Android token table matches
  `ThemeTests.swift`.
- **Schema parity** → one test asserting the Android PowerSync schema matches
  `apps/web/src/lib/powersync/schema.ts`. The schema now has **four** copies
  (`sync-config.yaml`, web, iOS, Android); this is cheap and catches a class of drift
  that has bitten before.

Gate before the PR: `./gradlew test` + `assembleDebug` for every module, **plus** the
existing `npm test`. `npm test` does not cover Android — the new Gradle command must be
named explicitly in `apps/android/CLAUDE.md`.

---

## 5. Platform work that will NOT port directly

Framework census across `Sources/`: SwiftUI 108, Foundation 50, Observation 19, UIKit 16,
PhotosUI 6, AVFoundation 4, PowerSync 3, UserNotifications 2, UniformTypeIdentifiers 2,
Charts 2, Speech 1, Security 1, HealthKit 1, AuthenticationServices 1.

**Confirmed absent, so not our problem:** no WidgetKit, App Intents, SiriKit,
Live Activities, StoreKit, CoreHaptics, EventKit, LocalAuthentication — and **no haptics
anywhere**.

| iOS | Android replacement | Difficulty |
|---|---|---|
| `ASWebAuthenticationSession` (OIDC + Google Calendar OAuth), callback `waffled://` | Chrome Custom Tabs / AndroidX Browser + intent-filter | Medium |
| Keychain (`AuthTokens`, kiosk `deviceSecret`) | EncryptedSharedPreferences / DataStore + Keystore | Easy — **the `securityd`-storm NSLock cache is not needed** |
| `UNUserNotifications`, rolling horizon under the **64-pending cap** | AlarmManager / WorkManager + NotificationChannels | **Easier** — no 64 cap, so the whole rolling reconcile machinery simplifies. `.timeSensitive` → high-importance channel |
| HealthKit (`HealthKitBridge`, 729 LOC, iPhone-only) | **Health Connect** | ⚠️ Hard — different permission model *and* different metric taxonomy. Expect a rewrite, not a port |
| `SFSpeechRecognizer` + `AVAudioEngine` dictation | Android `SpeechRecognizer` | Medium |
| `AVCaptureSession` barcode scanning (EAN-13/8, UPC-A/E, Code 128/39/93, ITF-14) | CameraX + ML Kit Barcode | Medium |
| PHPicker (5 sites) | Photo Picker (`ACTION_PICK_IMAGES`) | Easy |
| Drag & drop with two custom UTIs (`app.waffled.ingredient-row`, `app.waffled.meal-slot`), both conforming to `public.data` **so text fields don't intercept the drop** — ~25 files | Compose `dragAndDropSource/Target` with a custom MIME | ⚠️ Hard — **the UTI-vs-text trick has no Android analogue**; the iOS `List`-vs-`.dropDestination` constraints don't apply either, so reorder UX needs re-derivation |
| `UIActivityViewController` share sheet | `Intent.ACTION_SEND` | Easy (`ShareList.swift` is pure logic and ports as-is) |
| Swift Charts (2 goal views) | Vico | Medium |
| `isIdleTimerDisabled` (Cook Mode, kiosk screensaver) | `FLAG_KEEP_SCREEN_ON` / WakeLock | Easy |
| `KeyboardState` (88 LOC working around iPad landscape inset under-reporting) | `WindowInsets.ime` | **This file evaporates** |
| Orientation forcing via `requestGeometryUpdate` | Manifest `screenOrientation` | Easy |
| `Color(UIColor { traitCollection })` | Compose colour-scheme `CompositionLocal` | Easy |
| **SF Symbols** (~everywhere) | Material Symbols | Tedious — a per-icon mapping pass, budget for it |
| New York serif | Bundle Newsreader / Source Serif | Easy |
| `@Observable` (30 model classes) | `StateFlow` | Mechanical |
| XcodeGen / Xcode Cloud / entitlements / ITMS gates | Gradle + Play Console | Different, not harder |

### Two performance traps that will bite identically on Android

Both were learned the hard way on iOS and are written into `apps/ios/CLAUDE.md`:

1. **Never use a naive async image loader in a lazy list/grid.** `AsyncImage` re-fetches
   and re-decodes on every cell recreation — every scroll, every search keystroke —
   producing multi-second lag. iOS fixed it with `CachedImage`, which serves a cache hit
   **synchronously at `init`**. On Android: Coil with a real memory cache, and make sure
   the synchronous-hit path exists.
2. **Keep date math out of the render/sort/filter hot path.** A `Calendar` +
   `startOfDay` per call inside an O(n log n) comparator, recomputed per keystroke, janks
   hard; so does allocating a formatter per row. **Precompute per-row derived data in the
   model once per data load**, then O(1) lookup in the view — as `SyncManager` does with
   `eventsByDay` and `eventPalette` rebuilt in `didSet`.

---

## 6. Phases

### Phase 0 — foundation (serial, no agents) ✅ complete

> **Exit criterion met**, verified on the emulator against the demo stack: sign in →
> Photos renders **real seeded data** from the running household, and PowerSync reports
> **Connected**. 176 tests green from a clean build.

**Done and on `android-port`:**

| ✅ | Item |
|---|---|
| ✅ | Gradle scaffold, 8 modules, version catalog, wrapper pinned, `.gitignore` |
| ✅ | **Design system ported and FROZEN** — every token, 17 components, chrome modifiers, `WaffledIcons`, DayNight; locked by `ThemeTokensTest` |
| ✅ | `core:model` — `Person`, `Household`, module catalog, capabilities |
| ✅ | `ServerUrl` + the §7.5 cleartext policy, enforced in Kotlin and tested |
| ✅ | `RestDomain`, `ApiErrorText`, `RefreshBus` (the `*Rev` replacement) |
| ✅ | Ktor client + `TokenProvider` seam + 401-retry unwrap |
| ✅ | `TokenRefresher` — single-flight, proven with 20 concurrent callers |
| ✅ | PowerSync schema + `SyncSchemaParityTest`; `WaffledConnector` against the real 1.14.1 API |
| ✅ | Module + capability gates |
| ✅ | Phone shell — flex-slot tab bar with the raised FAB, `FlexSlot` logic |
| ✅ | `apps/android/CLAUDE.md` |
| ✅ | **Server reachability proven end-to-end** on the emulator (`10.0.2.2:8080` → HTTP 401) |

Also done: Keystore-encrypted token store · password login + the auth gate ·
`WaffledAuth` (the `TokenProvider` adapter) · `SyncManager` + `KtorSyncBackend` ·
`MediaImageEncoder` · `ApiTestHarness` · `WaffledDates` · **Photos, built by the pilot
agent** and merged.

**Deferred out of Phase 0, deliberately:**

| Item | Why |
|---|---|
| OIDC via Custom Tabs | The button renders from server status; the browser round-trip is Wave A work |
| Splash / launcher icon | Cosmetic |
| Settings screen for the server address | The plumbing (`MutableServerAddress`, `ServerUrl.validate`) exists; the UI belongs with Settings in Wave C |

#### Bugs the exit criterion caught that no unit test would have

Worth recording, because they argue for keeping "run it against a real server" as a
gate rather than trusting a green suite:

1. **`/api/powersync/token` is a `GET`, not a `POST`.** Ported as POST; the server
   answered "Method not allowed", and the only symptom was sync sitting at Offline while
   REST worked fine.
2. **The shared HTTP client never attached the bearer token.** Each API slice authorises
   per request — necessary, because the 401 retry must know *which* token failed — but
   nothing said so, so `KtorSyncBackend` silently sent anonymous requests and PowerSync
   logged "Not logged in" forever. Now there is one `WaffledHttp.authorized` helper and a
   test asserting the header on both calls.

Both failed *quietly*: REST kept working, and the UI just said "Offline".

#### Original checklist

Nothing fans out until this is committed and pushed to `android-port`. It must contain
**everything two agents would otherwise both write**.

0. Create the **`android-port`** integration branch off `main` and land this plan doc on
   it (see §3.2). Add the Android `.gitignore` entries — `build/`, `.gradle/`,
   `local.properties`, `*.apk` — **before** any agent runs, or every one of them commits
   build output.
1. Gradle scaffold, version catalog, wrapper pinned to 9.6.1, module skeleton,
   `local.properties` bootstrap documented.
2. **Design system ported and frozen** — every token in §2.2, all 17 components, the
   three field modifiers, `LockNote`, DayNight wiring, the serif font. Plus the
   `ThemeTests` parity test.
3. **Auth end-to-end** — Custom Tabs OIDC (`waffled://` scheme), password login,
   Keystore-backed token store, **single-flight refresh** (a `Mutex`, mirroring the iOS
   actor, so a burst of 401s makes one refresh call), 401 → clear + broadcast expiry.
4. **Network core** — Ktor client, auth interceptor, `APIErrorText` (relay the server's
   `{error,message}`, never guess), `RestDomain` equivalent, `MediaUpload` (downscale to
   2048px long edge → JPEG → base64, 10 MB decoded cap) and `MediaURL` resolution.
5. **The `*Rev` invalidation bus** (§1.5).
6. **PowerSync** — the 5-table schema, the connector (`fetchCredentials` →
   `POST /api/powersync/token`; `uploadData` → drain CRUD → `POST /api/powersync/crud`,
   throwing on failure so the queue survives offline), the retry-past-`SQLITE_BUSY` open,
   plus the schema-parity test.
7. **Module + capability gates** (§2.3).
8. **The phone shell** — the 5-slot bar with the flex module slot and centred FAB, five
   nav stacks, the `HubRoute` destination renderer (~32 cases), the approvals badge.
9. **Server-address setting + reachability** (§0.1) — user-editable server URL, debug
   default `http://10.0.2.2:8080`, cleartext policy per §7.5, and a verified
   `POWERSYNC_PUBLIC_URL` that resolves from the device.
10. **One reference feature, complete** — recommend **Photos (991 LOC)**: small, and it
    exercises REST + `RestDomain` + grid + detail + upload + Coil caching. It becomes the
    pattern every agent copies.

> **Exit criteria — both, not just the first:** everything builds and tests pass; **and**
> Photos renders real data from the running stack on the emulator with PowerSync reporting
> `connected`.

### Phase 1 — Wave A (1 pilot agent, then 4 parallel) 🚧

Smaller features that pin down the patterns, plus the only offline one.

**Pilot first.** Phase 0 validates the *code* pattern, but I build it myself — so the
delegation contract in §3.3/§3.4 is completely untested until an agent runs it. Launch
**one** agent (`android/today`, 948 LOC) alone and inspect what comes back: did it stay
inside its module, did it touch `libs.versions.toml`, did it hit the SDK-path trap, did it
stop-and-report on a missing token or invent one. Fix the prompt, *then* fan out the
remaining four. This is the one failure mode the architecture doesn't already defend
against.

| Agent | Scope | LOC |
|---|---|---:|
| `android/calendar` | Agenda + month grid, person filter, event editor, recurrence, countdowns, per-event colour. **The only PowerSync-backed feature** | 2,978 |
| `android/lists` | Lists index + **the Grocery board** (by aisle / by meal, sections, pantry staples, reorder, share-as-text) | 3,401 |
| `android/chores` | Board + date stepper, up-for-grabs, approve/reject, streaks, photo proof (CameraX) | 1,572 |
| `android/rewards` | Balances, catalog, shops, redemptions, confetti, jar | 1,285 |
| `android/today` | Phone home, customizable cards, greeting + capture bar | 948 |

### Phase 2 — Wave B (5 agents, parallel) 🚧

The two giants, split so no agent carries >4.5k LOC.

| Agent | Scope | LOC |
|---|---|---:|
| `android/meals-planner` | Week + month planners, AI plan sheets, `PlanShared` chrome, grocery weeks, swap/drag | ~4,400 |
| `android/meals-recipes` | Recipe library, detail, editor, Meal Builder plates, Cook Mode + background timers, import sheets | ~4,400 |
| `android/goals-core` | Goals list, detail, logging, create/edit, milestones, streaks, membership, calendar↔goal review | ~4,000 |
| `android/goals-dataviews` | The 8 chart/heatmap views (Vico) | ~2,100 |
| `android/pantry` | Inventory, barcode → Open Food Facts, allergens, expiry, cook-from-pantry | 2,843 |

### Phase 3 — Wave C (5 agents, parallel) 🚧

| Agent | Scope | LOC |
|---|---|---:|
| `android/settings-a` | Account, family/people, permissions, appearance, about, updates | ~2,500 |
| `android/settings-b` | Modules, chores+rewards, meals, pantry, AI, notifications, calendars/ICS, display+kiosk | ~2,500 |
| `android/family` | Hub, person spotlight, approvals queue, sync status | 1,705 |
| `android/capture` | The "Add anything" sheet (8 intents) + dictation. ⚠️ see §7.1 | 1,279 |
| `android/bites-familynight` | Waffled-Bites control panel + Family Night | 1,363 |

### Phase 4 — Wave D, tablet kiosk (3 agents) 🚧

**Sequenced last deliberately** — it is 4,205 LOC plus the two duplicated view trees, and
it is a separable product. Quantified so the scope is a conscious choice: **kiosk +
duplicated trees ≈ 4,205 LOC, and Meals + Goals + Settings + Kiosk together are 24,126
LOC — 56% of all feature code.**

| Agent | Scope |
|---|---|
| `android/kiosk-shell` | Rail (customisable, 5 pins) + detail pane, boot cover with 8s stall escape, More grid, screensaver, device pairing, profile picker + PIN pad + lockout |
| `android/kiosk-today` | `KioskDashboard` (993) |
| `android/kiosk-calendar` | `KioskCalendarView` (998) |

### Phase 5 — integration & release plumbing (serial) 🚧

1. Merge every feature branch into `android-port`; resolve; full `./gradlew test` +
   `assembleDebug`; install on the emulator **and** on the physical device.
2. Visual parity pass — side-by-side against the iOS simulator, screen by screen. This is
   where "copy the design exactly" is actually verified.
3. **`./waffled release` must bump the Android version site.** It currently bumps
   `apps/api` + `apps/web` package.json (+lockfiles), `WAFFLED_VERSION` in
   `infra/compose/.env.example`, and iOS `MARKETING_VERSION` (`waffled:1256-1257`). Add
   `apps/android/app/build.gradle.kts` `versionName`. **Miss it and repo/images/`.env`
   silently disagree** — the exact failure the release convention exists to prevent.
4. `.github/workflows/ci.yml` — add a Gradle job (JDK 21, `test` + `assembleDebug`).
5. **Docs, in this same PR — never as a follow-up:**
   - `apps/android/CLAUDE.md` (folder-scoped conventions: the toolchain table from §0,
     the frozen-design-system rule, the two perf traps, the test command).
   - `CHANGELOG.md` under `[Unreleased]` → **Added**, bold lead + a plain-language
     sentence.
   - `website/docs/src/content/docs/reference/features.md`.
   - `docs/product/roadmap.md` — move Android to Done/partial.
   - **Grep the whole repo** for stale platform phrasing — "iOS and web", "iOS-only",
     "planned", "coming" — and fix every hit, including internal `docs/product/*-plan.md`.
     *This has bitten three times.*

---

## 7. Decisions — all settled ✅

Resolved 2026-08-21. Recorded here so the fan-out doesn't relitigate them.

### 7.1 `CaptureHeuristic` becomes a **third** implementation — accepted, with a debt note

`Sync/CaptureHeuristic.swift` (980) + `CaptureHeuristicTests.swift` (703) carry an
explicit **"⚠️ KEEP IN SYNC"** header bound to `apps/web/src/lib/capture/parse.ts` and
its `parse.test.ts` — they must stay behaviourally identical. Porting adds a third copy
of a natural-language parser, 1,683 LOC to duplicate and keep in lockstep forever.

**Decided: port it as a third copy**, driven by translating the 703-LOC test file first —
the tests are an exact spec, so this is cheap *and* textbook TDD.

> 📌 **Consolidation debt — deliberately taken on, to be paid down later.** Three
> independent implementations of one natural-language parser is not a stable end state:
> every future capture change costs 3× and can silently diverge on any platform whose
> test file wasn't updated. **The intended fix is to move parsing server-side** behind a
> `POST /api/capture/parse` endpoint so all three clients call one implementation.
> That refactor touches web + iOS and so is out of scope for the port PR, but it should
> be scheduled soon after. Track it on the roadmap; do not let the third copy quietly
> become permanent.

### 7.2 HealthKit → Health Connect — **paused**

Different permission model *and* different metric taxonomy — a rewrite, not a port, for a
feature that only pre-fills a goal log, in an area we don't yet know well.

**Decided: not in this port.** Ship the goal-logging UI intact, with the auto-fill
affordance hidden behind the same availability guard iOS uses
(`isHealthDataAvailable()`) so nothing looks broken. Health Connect is its own future
effort, scoped separately once we've had a proper look at it.

### 7.3 Four other "KEEP IN SYNC" contracts gain a third party

`SyncSchema` ↔ web schema + `sync-config.yaml`; `KioskDevice`/`KioskMode` ↔ web kiosk
client; `Theme` ↔ `waffled.css`. **Recommendation: add the two parity tests named in §4**
(palette, schema) rather than relying on convention.

### 7.4 Tablet kiosk scope

The task says "every feature", so it is planned in full at Phase 4 — but it is 4,205 LOC
plus two duplicated view trees, and it is separable. **Recommendation: keep it in, last**,
so it can be dropped from the PR without disturbing anything earlier if you want to ship
the phone app sooner.

---

### 7.5 Cleartext HTTP — allow on home networks only

**What "cleartext" means here:** plain `http://` rather than `https://`. Android blocks it
by default. That matters because Waffled is self-hosted — people run it at
`http://192.168.1.50:8080` on their home network with no TLS certificate. Block plain HTTP
and those users can't connect at all; allow it everywhere and someone who types a *public*
address would send their password over the open internet unencrypted. iOS sidesteps this
with `NSAllowsLocalNetworking`.

Because the server address is typed at runtime, we can't enumerate domains in
`network_security_config.xml` the way a normal app would.

**Decided: permit cleartext only for private/local addresses, require HTTPS everywhere
else.**

- Debug: `cleartextTrafficPermitted="true"` (needs `10.0.2.2` for the emulator).
- Release: cleartext permitted for RFC1918 ranges (`10/8`, `172.16/12`, `192.168/16`),
  loopback and `.local`; HTTPS enforced for anything public.

Home self-hosting keeps working; a public deployment can't be silently downgraded. The app
should also **warn in the server-address setting** when a user enters a public host over
plain HTTP, rather than failing opaquely.

## 8. Effort shape

~42,977 LOC of iOS feature code + 8,076 sync + 692 design ≈ **52k LOC of source to
translate**, against a **7,579-LOC test suite that serves as the spec**. Roughly
**18 feature agents** across 4 waves, on top of a serial Phase 0 and a serial
integration phase.

The two costs most likely to be underestimated: the **SF Symbols → Material Symbols**
mapping pass (touches every screen), and the **visual parity pass** in Phase 5 — which is
where "copy the design exactly" is actually earned.
