package app.waffled.feature.capture

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Test
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.time.ZonedDateTime
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue

// KEEP IN SYNC: a translation of apps/ios/Tests/CaptureHeuristicTests.swift, which mirrors
// apps/web/src/lib/capture/parse.test.ts. A rule change lands in all three suites.

private val people = listOf("Wally", "Kelly", "Kevin", "Lottie")
private val zone: ZoneId = ZoneId.of("America/Denver")

// Fixed "now": Thursday, June 11 2026, 9:00 AM (matches parse.test.ts).
private val pinnedNow: ZonedDateTime = ZonedDateTime.of(2026, 6, 11, 9, 0, 0, 0, zone)

private fun p(s: String, lists: List<String> = emptyList()): CaptureIntent? =
    CaptureHeuristic.parse(s, persons = people, now = pinnedNow, lists = lists)

private fun ev(s: String) = assertNotNull(p(s) as? CaptureIntent.Event, "not an event: $s")
private fun task(s: String) = assertNotNull(p(s) as? CaptureIntent.Task, "not a task: $s")
private fun meal(s: String) = assertNotNull(p(s) as? CaptureIntent.Meal, "not a meal: $s")
private fun countdown(s: String) = assertNotNull(p(s) as? CaptureIntent.Countdown, "not a countdown: $s")
private fun person(s: String) = assertNotNull(p(s) as? CaptureIntent.Person, "not a person: $s")
private fun goal(s: String) = assertNotNull(p(s) as? CaptureIntent.Goal, "not a goal: $s")
private fun pantry(s: String) = assertNotNull(p(s) as? CaptureIntent.Pantry, "not pantry: $s")
private fun grocery(s: String) = assertNotNull(p(s) as? CaptureIntent.Grocery, "not grocery: $s")
private fun reward(s: String) = assertNotNull(p(s) as? CaptureIntent.Reward, "not a reward: $s")
private fun mutate(s: String) = assertNotNull(p(s) as? CaptureIntent.Mutate, "not a mutate: $s")

private fun at(iso: String): ZonedDateTime = Instant.parse(iso).atZone(zone)
private fun hour(s: String) = at(s).hour
private fun minute(s: String) = at(s).minute
private fun dom(s: String) = at(s).dayOfMonth
private fun dow(s: String) = at(s).dayOfWeek.value % 7 // 0=Sun
private fun mon(s: String) = at(s).monthValue
private fun year(s: String) = at(s).year
private fun dowOfDate(s: String) = LocalDate.parse(s).dayOfWeek.value % 7

private fun num(n: Double) = JsonPrimitive(n)
private fun str(s: String) = JsonPrimitive(s)

class CaptureHeuristicEventTest {
    @Test fun placeholderExample() {
        val e = ev("Soccer Tue 4pm for Wally")
        assertEquals("Soccer", e.title)
        assertEquals("Wally", e.personName)
        assertFalse(e.allDay)
        assertEquals(2, dow(e.startsAt))
        assertEquals(16, hour(e.startsAt))
    }

    @Test fun tomorrowAllDay() {
        val e = ev("Dentist tomorrow")
        assertEquals("Dentist", e.title)
        assertTrue(e.allDay)
        assertEquals(12, dom(e.startsAt))
    }

    @Test fun tonightEvening() {
        val e = ev("Movie night tonight")
        assertFalse(e.allDay)
        assertEquals(18, hour(e.startsAt))
        assertEquals(11, dom(e.startsAt))
    }

    @Test fun timeWithMinutes() {
        val e = ev("Call plumber today at 3:30pm")
        assertEquals(15, hour(e.startsAt))
        assertEquals(30, minute(e.startsAt))
        assertEquals("Call plumber", e.title)
    }

    @Test fun monthDayFuture() {
        val e = ev("Trip Aug 5")
        assertEquals(8, mon(e.startsAt))
        assertEquals(5, dom(e.startsAt))
        assertEquals(2026, year(e.startsAt))
    }

    @Test fun pastMonthRollsToNextYear() {
        assertEquals(2027, year(ev("Reunion jan 3").startsAt))
    }

    @Test fun nextFriday() {
        val e = ev("Date night next friday")
        assertEquals(5, dow(e.startsAt))
        assertEquals(19, dom(e.startsAt))
    }

    @Test fun startsAtIsUtcWithMillisLikeToIsoString() {
        assertEquals("2026-06-16T22:00:00.000Z", ev("Soccer Tue 4pm for Wally").startsAt)
    }

    @Test fun whenLabelJoinsDayAndTime() {
        assertEquals("Tuesday · 4:00 PM", ev("Soccer Tue 4pm for Wally").whenLabel)
        assertEquals("Tomorrow · All day", ev("Dentist tomorrow").whenLabel)
    }
}

class CaptureHeuristicRecurringTest {
    @Test fun everyTuesday() {
        val e = ev("soccer every Tuesday at 4pm for Wally")
        assertEquals("Soccer", e.title)
        assertEquals("Wally", e.personName)
        assertEquals("FREQ=WEEKLY;BYDAY=TU", e.rrule)
        assertEquals(2, dow(e.startsAt))
        assertEquals(16, hour(e.startsAt))
    }

    @Test fun everyWeekday() {
        val e = ev("standup every weekday at 9am")
        assertEquals("FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR", e.rrule)
        assertEquals(9, hour(e.startsAt))
    }

    @Test fun everyDay() {
        assertEquals("FREQ=DAILY", ev("team huddle every day at 9am").rrule)
    }

    @Test fun monthly() {
        val e = ev("book club monthly")
        assertEquals("Book club", e.title)
        assertEquals("FREQ=MONTHLY", e.rrule)
    }

    @Test fun everyOther() {
        assertEquals("FREQ=WEEKLY;INTERVAL=2;BYDAY=TU", ev("yoga every other tuesday at 6pm").rrule)
    }

    @Test fun pluralWeekday() {
        assertEquals("FREQ=WEEKLY;BYDAY=TU", ev("trash pickup tuesdays").rrule)
    }

    @Test fun bareWeekdayIsOneOff() {
        assertNull(ev("Soccer Tue 4pm for Wally").rrule)
    }

    @Test fun stripsCommandAndCalendar() {
        val e = ev("Add gymnastics to Lottie's calendar every Tuesday at noon")
        assertEquals("Gymnastics", e.title)
        assertEquals("Lottie", e.personName)
        assertEquals("FREQ=WEEKLY;BYDAY=TU", e.rrule)
        assertEquals(12, hour(e.startsAt))
    }

    @Test fun scheduleLabelDescribesTheRule() {
        assertEquals("Every week on Tue", ev("soccer every Tuesday at 4pm for Wally").scheduleLabel)
        assertEquals("", ev("Soccer Tue 4pm for Wally").scheduleLabel)
    }
}

class CaptureHeuristicGroceryTest {
    @Test fun bareNoun() {
        val g = grocery("milk")
        assertEquals("Milk", g.name)
        assertNull(g.quantity)
    }

    @Test fun stripVerb() {
        val g = grocery("buy almond milk")
        assertEquals("Almond milk", g.name)
        assertNull(g.quantity)
    }

    @Test fun quantityUnit() {
        val g = grocery("2 lbs chicken thighs")
        assertEquals("Chicken thighs", g.name)
        assertEquals("2 lbs", g.quantity)
    }

    @Test fun addToList() {
        val g = grocery("add paper towels to the grocery list")
        assertEquals("Paper towels", g.name)
        assertNull(g.quantity)
    }
}

class CaptureHeuristicTaskTest {
    @Test fun remind() {
        val t = task("remind take out the trash for Wally")
        assertEquals("Wally", t.personName)
        assertTrue(t.title.lowercase().contains("trash"))
    }

    @Test fun choreWithStars() {
        val t = task("chore walk the dog for Kelly 5 stars")
        assertEquals("Kelly", t.personName)
        assertEquals(5, t.stars)
        assertTrue(t.title.lowercase().contains("walk the dog"))
    }

    @Test fun choreBeatsDate() {
        val t = task("please make Wally a chore to take out the trash on Wednesday night and Sunday night.")
        assertEquals("Wally", t.personName)
        assertEquals("Take out the trash", t.title)
        assertEquals("FREQ=WEEKLY;BYDAY=WE,SU", t.rrule)
        assertEquals("Wed & Sun", t.scheduleLabel)
    }

    @Test fun quotedTitle() {
        val t = task("Please add \"Take Out the Trash as a Chore\" for Lottie on Tuesday and Thursday.")
        assertEquals("Take Out the Trash", t.title)
        assertEquals("Lottie", t.personName)
        assertEquals("FREQ=WEEKLY;BYDAY=TU,TH", t.rrule)
        assertEquals("Tue & Thu", t.scheduleLabel)
    }

    @Test fun possessiveDestination() {
        val t = task("Please add laundry for Monday, Wednesday, and Saturday to Kelly's chore list.")
        assertEquals("Laundry", t.title)
        assertEquals("Kelly", t.personName)
        assertEquals("FREQ=WEEKLY;BYDAY=MO,WE,SA", t.rrule)
        assertEquals("Mon & Wed & Sat", t.scheduleLabel)
    }

    @Test fun dailyChore() {
        val t = task("chore for Kevin to make the bed every day")
        assertEquals("FREQ=DAILY", t.rrule)
        assertTrue(t.title.lowercase().contains("make the bed"))
    }
}

class CaptureHeuristicMealTest {
    @Test fun mealPlan() {
        val m = meal("lets put shawarma on the meal plan")
        assertEquals("Shawarma", m.title)
        assertEquals("dinner", m.mealType)
        assertNull(m.date)
    }

    @Test fun slotAndDay() {
        val m = meal("tacos for lunch on Friday")
        assertTrue(m.title.lowercase().contains("tacos"))
        assertEquals("lunch", m.mealType)
        assertEquals(5, dowOfDate(m.date!!))
    }

    @Test fun dinnerWithTimeIsEvent() {
        assertNotNull(p("dinner with grandma at 6pm") as? CaptureIntent.Event)
    }

    @Test fun eatingOut() {
        val m = meal("we're eating out friday")
        assertEquals("Eating out", m.title)
        assertEquals(5, dowOfDate(m.date!!))
    }

    @Test fun reservationIsEvent() {
        assertNotNull(p("eating out at 7pm on friday") as? CaptureIntent.Event)
    }
}

class CaptureHeuristicCountdownTest {
    @Test fun daysUntil() {
        val c = countdown("12 days until Disney")
        assertEquals("Disney", c.title)
        assertEquals("2026-06-23", c.date)
    }

    @Test fun inNDays() {
        val c = countdown("Disney in 12 days")
        assertEquals("Disney", c.title)
        assertEquals("2026-06-23", c.date)
    }

    @Test fun sleepsUntil() {
        val c = countdown("10 sleeps until Christmas")
        assertEquals("Christmas", c.title)
        assertEquals("2026-06-21", c.date)
    }

    @Test fun countdownToExplicitDate() {
        val c = countdown("countdown to the beach party on August 25")
        assertEquals("Beach party", c.title)
        assertEquals("2026-08-25", c.date)
    }

    @Test fun clockTimeIsEvent() {
        assertNotNull(p("countdown to New Year at 6pm") as? CaptureIntent.Event)
    }

    private fun nthWeekday(year: Int, month: Int, weekday0: Int, n: Int): String {
        val first = LocalDate.of(year, month, 1)
        val firstDow = first.dayOfWeek.value % 7
        val offset = (weekday0 - firstDow + 7) % 7
        return LocalDate.of(year, month, 1 + offset + (n - 1) * 7).toString()
    }

    @Test fun holidayForConnector() {
        val c = countdown("add a countdown for thanksgiving")
        assertEquals("Thanksgiving", c.title)
        assertEquals(nthWeekday(2026, 11, 4, 4), c.date)
    }

    @Test fun forConnectorExplicitDate() {
        val c = countdown("add a countdown for november 20th")
        assertEquals("Countdown", c.title)
        assertEquals("2026-11-20", c.date)
    }

    @Test fun holidayChristmas() {
        val c = countdown("countdown to Christmas")
        assertEquals("Christmas", c.title)
        assertEquals("2026-12-25", c.date)
    }

    @Test fun holidayEaster() {
        val c = countdown("countdown to Easter")
        assertEquals("Easter", c.title)
        // Easter 2026 (Apr 5) is past NOW → rolls to Easter 2027 (Mar 28, via Computus).
        assertEquals("2027-03-28", c.date)
    }

    @Test fun clockTimeStillEvent() {
        assertNotNull(p("dentist Tuesday 3pm") as? CaptureIntent.Event)
    }

    @Test fun whenLabelCountsDays() {
        assertEquals("Tue, Jun 23 · 12 days", countdown("12 days until Disney").whenLabel)
    }
}

class CaptureHeuristicPersonTest {
    @Test fun sonIsKid() {
        val m = person("add my son Max")
        assertEquals("Max", m.name)
        assertEquals("kid", m.memberType)
        assertFalse(m.isAdmin)
    }

    @Test fun daughterIsKid() {
        val m = person("add my daughter Jane")
        assertEquals("Jane", m.name)
        assertEquals("kid", m.memberType)
    }

    @Test fun wifeIsAdult() {
        val m = person("add my wife Sara")
        assertEquals("Sara", m.name)
        assertEquals("adult", m.memberType)
    }

    @Test fun familyMemberDefaultsAdult() {
        val m = person("add a family member named Robin")
        assertEquals("Robin", m.name)
        assertEquals("adult", m.memberType)
    }

    @Test fun profileForName() {
        assertEquals("Max", person("create a profile for Max").name)
    }

    @Test fun dropsTrailingAge() {
        val m = person("add my son Max, age 8")
        assertEquals("Max", m.name)
        assertNull(m.birthday)
    }

    @Test fun momsBirthdayIsNotPerson() {
        assertNull(p("add my mom's birthday on June 5") as? CaptureIntent.Person)
    }

    @Test fun boyScoutsMeetingIsNotPerson() {
        assertNull(p("add boy scouts meeting Tuesday") as? CaptureIntent.Person)
    }

    @Test fun sonMaxStillPerson() {
        assertEquals("Max", (p("add my son Max") as? CaptureIntent.Person)?.name)
    }

    @Test fun familyMemberJaneStillPerson() {
        val m = person("add a family member Jane")
        assertEquals("Jane", m.name)
        assertEquals("adult", m.memberType)
    }
}

class CaptureHeuristicGoalTest {
    // Last day of the next occurrence of a 0-based month, computed from pinnedNow.
    private fun endOfNextMonth(mo0: Int): String {
        var year = pinnedNow.year
        if (mo0 < pinnedNow.monthValue - 1) year += 1
        val first = LocalDate.of(year, mo0 + 1, 1)
        return first.withDayOfMonth(first.lengthOfMonth()).toString()
    }

    @Test fun personalGoalRunMilesBySeptember() {
        val g = goal("set a personal goal to run 10 miles by september")
        assertEquals("Run", g.title)
        assertEquals("total", g.goalType)
        assertEquals(10.0, g.targetValue)
        assertEquals("miles", g.unit)
        assertEquals(endOfNextMonth(8), g.deadline)
    }

    @Test fun personalGoalRunMilesNoDeadline() {
        val g = goal("set a personal goal to run 10 miles")
        assertEquals("Run", g.title)
        assertEquals("total", g.goalType)
        assertEquals(10.0, g.targetValue)
        assertEquals("miles", g.unit)
        assertNull(g.deadline)
    }

    @Test fun newGoalReadBooks() {
        val g = goal("set a new goal to read 20 books")
        assertEquals("Read", g.title)
        assertEquals("count", g.goalType)
        assertEquals(20.0, g.targetValue)
        assertEquals("books", g.unit)
        assertNull(g.deadline)
    }

    @Test fun thisYearDeadline() {
        val g = goal("set a goal to read 20 books this year")
        assertEquals("count", g.goalType)
        assertEquals(20.0, g.targetValue)
        assertEquals("books", g.unit)
        assertEquals("${pinnedNow.year}-12-31", g.deadline)
    }

    @Test fun moneyTotal() {
        val g = goal("my goal is to save $500")
        assertEquals("Save", g.title)
        assertEquals("total", g.goalType)
        assertEquals(500.0, g.targetValue)
        assertEquals("dollars", g.unit)
    }

    @Test fun iWantToGetInShape() {
        val g = goal("I want to get in shape")
        assertEquals("Get in shape", g.title)
        assertEquals("habit", g.goalType)
        assertNull(g.targetValue)
        assertNull(g.unit)
    }

    @Test fun newGoalColon() {
        val g = goal("new goal: meditate every day")
        assertEquals("Meditate every day", g.title)
        assertEquals("habit", g.goalType)
    }

    @Test fun iWantFishForDinnerIsMeal() {
        assertNotNull(p("I want fish for dinner") as? CaptureIntent.Meal)
    }

    @Test fun iWantToHaveTacosForDinnerIsMeal() {
        val m = meal("I want to have tacos for dinner tomorrow")
        assertTrue(m.title.lowercase().contains("tacos"))
        assertEquals("dinner", m.mealType)
    }

    @Test fun iWantToGetInShapeStaysGoal() {
        val g = goal("I want to get in shape")
        assertEquals("Get in shape", g.title)
        assertEquals("habit", g.goalType)
    }

    @Test fun defaultsAssignment() {
        assertEquals("shared_total", goal("set a goal to run 10 miles").trackingMode)
    }

    @Test fun audienceEveryoneFromFamilyPhrase() {
        assertEquals("everyone", goal("set a family goal to walk 30 min per day").audience)
    }

    @Test fun audienceMeFromPersonalPhrase() {
        assertEquals("me", goal("set a personal goal to run 10 miles").audience)
    }

    @Test fun audienceNilWithoutHint() {
        assertNull(goal("set a goal to read 20 books").audience)
    }

    @Test fun summarizesGoal() {
        val s = CaptureSummary.of(p("set a goal to read 20 books")!!)
        assertEquals("🎯", s.icon)
        assertEquals("Goal", s.kind)
        assertEquals("Read", s.primary)
        assertTrue(s.detail.contains("20 books"))
    }
}

class CaptureHeuristicPantryTest {
    @Test fun addMilkToThePantry() {
        val i = pantry("add milk to the pantry")
        assertEquals("Milk", i.name)
        assertEquals("Pantry", i.location)
        assertNull(i.amount)
        assertNull(i.unit)
    }

    @Test fun putCansOfBeansInThePantry() {
        val i = pantry("put 2 cans of beans in the pantry")
        assertEquals("Beans", i.name)
        assertEquals("2", i.amount)
        assertEquals("cans", i.unit)
        assertEquals("Pantry", i.location)
    }

    @Test fun weHaveMilkInTheFridge() {
        val i = pantry("we have milk in the fridge")
        assertEquals("Milk", i.name)
        assertEquals("Fridge", i.location)
    }

    @Test fun bareAddMilkStaysGrocery() {
        assertNotNull(p("add milk") as? CaptureIntent.Grocery)
    }

    @Test fun addMilkToShoppingListStaysGrocery() {
        assertNotNull(p("add milk to the shopping list") as? CaptureIntent.Grocery)
    }

    @Test fun summarizesPantry() {
        val s = CaptureSummary.of(p("put 2 cans of beans in the pantry")!!)
        assertEquals("🥫", s.icon)
        assertEquals("Pantry", s.kind)
        assertEquals("2 cans Beans", s.primary)
        assertTrue(s.detail.contains("Pantry"))
    }
}

class CaptureHeuristicRewardTest {
    @Test fun rewardWithCost() {
        val r = reward("add a reward: ice cream night for 50 stars")
        assertEquals("Ice cream night", r.title)
        assertEquals(50, r.cost)
        assertNull(r.requiresApproval)
    }

    @Test fun rewardCostsPoints() {
        val r = reward("new reward extra screen time costs 100 points")
        assertEquals("Extra screen time", r.title)
        assertEquals(100, r.cost)
    }

    @Test fun rewardNoCost() {
        val r = reward("reward: movie night")
        assertEquals("Movie night", r.title)
        assertNull(r.cost)
    }

    @Test fun bareItemStaysGrocery() {
        assertNotNull(p("add ice cream") as? CaptureIntent.Grocery)
    }

    @Test fun summarizesReward() {
        val s = CaptureSummary.of(p("add a reward: ice cream night for 50 stars")!!)
        assertEquals("🎁", s.icon)
        assertEquals("Reward", s.kind)
        assertEquals("Ice cream night", s.primary)
        assertTrue(s.detail.contains("50★"))
    }
}

class CaptureHeuristicListTest {
    @Test fun knownListByTokenOverlap() {
        val l = assertNotNull(p("add tent to camping gear", lists = listOf("Camping gear")) as? CaptureIntent.ListItem)
        assertEquals("Tent", l.itemName)
        assertEquals("Camping gear", l.listName)
    }

    @Test fun namedListPhrase() {
        val l = assertNotNull(p("add sunscreen to the packing list") as? CaptureIntent.ListItem)
        assertEquals("Sunscreen", l.itemName)
        assertEquals("Packing", l.listName)
    }
}

class CaptureHeuristicEdgeTest {
    @Test fun emptyInput() {
        assertNull(p(""))
        assertNull(p("   "))
    }

    @Test fun confidence() {
        assertTrue(CaptureHeuristic.looksConfident(p("Soccer Tue 4pm for Wally"), "Soccer Tue 4pm for Wally"))
        assertTrue(CaptureHeuristic.looksConfident(p("2 lbs chicken thighs"), "2 lbs chicken thighs"))
        assertFalse(CaptureHeuristic.looksConfident(p("milk"), "milk"))
    }
}

// Tier 2 — mutate verbs (mirrors parse.test.ts › "parseCapture — mutate verbs").
class CaptureHeuristicMutateTest {
    @Test fun markChoreDone() {
        val m = mutate("mark the trash chore done")
        assertEquals("complete", m.verb)
        assertEquals("chore", m.targetKind)
        assertTrue(m.description.lowercase().contains("trash"))
    }

    @Test fun logGoalMinutes() {
        val m = mutate("log 20 min on my reading goal")
        assertEquals("log", m.verb)
        assertEquals("goal", m.targetKind)
        assertEquals("reading", m.description.lowercase())
        assertEquals(num(20.0), m.args["minutes"])
    }

    @Test fun completeChoreByVerbDefault() {
        val m = mutate("mark set the table done for Elaine")
        assertEquals("complete", m.verb)
        assertEquals("chore", m.targetKind)
        assertEquals("set the table", m.description.lowercase())
    }

    @Test fun addHoursToGoalNotGrocery() {
        val m = mutate("add 10 hours to our outside goal for kevin and wally")
        assertEquals("log", m.verb)
        assertEquals("goal", m.targetKind)
        assertEquals("outside", m.description.lowercase())
        assertEquals(num(10.0), m.args["hours"])
    }

    @Test fun deleteEvent() {
        val m = mutate("delete the dentist appointment")
        assertEquals("delete", m.verb)
        assertEquals("event", m.targetKind)
    }

    @Test fun crossListItem() {
        val m = mutate("cross milk off the list")
        assertEquals("complete", m.verb)
        assertEquals("listItem", m.targetKind)
    }

    @Test fun reassignChorePerson() {
        val m = mutate("give the dishes to Wally")
        assertEquals("reassign", m.verb)
        assertEquals("chore", m.targetKind)
        assertEquals(str("Wally"), m.args["personName"])
    }

    @Test fun recordEventNotGoalLog() {
        val e = ev("record the school play Friday 7pm")
        assertEquals(5, dow(e.startsAt))
        assertEquals(19, hour(e.startsAt))
    }

    @Test fun logMinutesGuard() {
        val m = mutate("log 30 minutes on my reading goal")
        assertEquals("log", m.verb)
        assertEquals("goal", m.targetKind)
        assertEquals(num(30.0), m.args["minutes"])
    }

    @Test fun leadingOffCrossOff() {
        val m = mutate("cross off milk")
        assertEquals("complete", m.verb)
        assertEquals("listItem", m.targetKind)
        assertEquals("milk", m.description.lowercase())
    }

    @Test fun leadingOffCheckTick() {
        val m1 = mutate("check off milk")
        assertEquals("complete", m1.verb)
        assertEquals("milk", m1.description.lowercase())
        val m2 = mutate("tick off the bread")
        assertEquals("complete", m2.verb)
        assertEquals("bread", m2.description.lowercase())
    }

    @Test fun trailingOffStillWorks() {
        val m = mutate("cross milk off")
        assertEquals("complete", m.verb)
        assertEquals("listItem", m.targetKind)
        assertEquals("milk", m.description.lowercase())
    }

    @Test fun spentMinutesIsLog() {
        val m = mutate("I spent 30 minutes on my reading goal")
        assertEquals("log", m.verb)
        assertEquals("goal", m.targetKind)
        assertEquals(num(30.0), m.args["minutes"])
    }

    @Test fun spentPointsIsRedeem() {
        val m = mutate("Wally spent 50 points on the ice cream reward")
        assertEquals("redeem", m.verb)
        assertEquals("reward", m.targetKind)
        assertTrue(m.description.lowercase().contains("ice cream"))
    }

    @Test fun rescheduleDateAndTime() {
        val m = mutate("move soccer to Thursday 4pm")
        assertEquals("reschedule", m.verb)
        assertEquals("event", m.targetKind)
        assertEquals("soccer", m.description.lowercase())
        // NOW is Thursday Jun 11 2026 — a bare "Thursday" is today.
        assertEquals(mapOf("date" to str("2026-06-11"), "time" to str("16:00")), m.args)
    }

    @Test fun rescheduleDateOnly() {
        val m = mutate("reschedule the dentist appointment to tomorrow")
        assertEquals("reschedule", m.verb)
        assertEquals(mapOf("date" to str("2026-06-12")), m.args)
    }

    @Test fun rescheduleTimeOnly() {
        val m = mutate("move piano lesson to 3pm")
        assertEquals("reschedule", m.verb)
        assertEquals(mapOf("time" to str("15:00")), m.args)
    }

    @Test fun rescheduleNextFriday() {
        val m = mutate("push book club to next Friday")
        assertEquals("reschedule", m.verb)
        assertEquals(mapOf("date" to str("2026-06-19")), m.args)
    }

    @Test fun rescheduleFirstToWins() {
        val m = mutate("move soccer to Friday for Wally")
        assertEquals("reschedule", m.verb)
        assertEquals(mapOf("date" to str("2026-06-12")), m.args)
    }

    @Test fun rescheduleBareEmptyArgs() {
        val m = mutate("reschedule soccer")
        assertEquals("reschedule", m.verb)
        assertTrue(m.args.isEmpty())
    }

    @Test fun mutateNeverConfident() {
        assertFalse(CaptureHeuristic.looksConfident(p("mark the trash chore done"), "mark the trash chore done"))
        assertFalse(CaptureHeuristic.looksConfident(p("delete the dentist appointment"), "delete the dentist appointment"))
    }

    @Test fun createPhrasesStillParseAsCreate() {
        assertEquals("event", p("Soccer Tue 4pm for Wally")?.kind)
        assertEquals("grocery", p("add milk to the grocery list")?.kind)
        assertEquals("goal", p("set a goal to read 20 books")?.kind)
        assertEquals("reward", p("add a reward: ice cream night for 50 stars")?.kind)
    }

    @Test fun summarizesMutate() {
        val s = CaptureSummary.of(mutate("delete the dentist appointment"))
        assertTrue(s.primary.lowercase().contains("dentist"))
        assertTrue(s.kind.isNotEmpty())
    }
}
