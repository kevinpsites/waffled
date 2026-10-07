package app.waffled.feature.capture

import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import java.time.LocalDate
import java.time.LocalDateTime
import java.time.ZoneOffset
import java.time.ZonedDateTime
import java.time.format.DateTimeFormatter
import java.time.temporal.ChronoUnit
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.regex.Pattern

// ⚠️ KEEP IN SYNC — the third copy of one natural-language parser:
//   web  apps/web/src/lib/capture/parse.ts            (tests: parse.test.ts)
//   iOS  apps/ios/Sources/Waffled/Sync/CaptureHeuristic.swift (tests: CaptureHeuristicTests.swift)
//   here CaptureHeuristic.kt                           (tests: CaptureHeuristicTest.kt)
// A parsing RULE change lands in all three, with all three test suites updated.
// Plan section 7.1 records the debt: parsing should move server-side.

/**
 * On-device heuristic for the "Add anything" bar — the offline / no-provider fallback.
 * Routing priority: mutate → person → goal → reward → task → meal → list → countdown →
 * event → pantry → grocery (bare nouns fall back to grocery). [ZonedDateTime] `now`
 * carries the household zone, so the logic is deterministic in tests.
 *
 * Regexes run on java.util.regex over UTF-16 indices, matching the JS/NSString semantics
 * the other two copies rely on.
 */
object CaptureHeuristic {

    private class Hit(val start: Int, val end: Int, val groups: List<String?>) {
        operator fun get(i: Int): String? = groups.getOrNull(i)
        val span get() = Span(start, end)
    }

    private data class Span(val start: Int, val end: Int)

    private val cache = ConcurrentHashMap<Pair<String, Boolean>, Pattern>()

    private fun pattern(re: String, ci: Boolean): Pattern =
        cache.getOrPut(re to ci) { Pattern.compile(re, if (ci) Pattern.CASE_INSENSITIVE else 0) }

    private fun firstMatch(re: String, s: String, ci: Boolean = true): Hit? {
        val m = pattern(re, ci).matcher(s)
        if (!m.find()) return null
        return Hit(m.start(), m.end(), (0..m.groupCount()).map { m.group(it) })
    }

    private fun allMatches(re: String, s: String): List<Hit> {
        val m = pattern(re, true).matcher(s)
        val out = mutableListOf<Hit>()
        while (m.find()) out += Hit(m.start(), m.end(), (0..m.groupCount()).map { m.group(it) })
        return out
    }

    private fun test(re: String, s: String) = firstMatch(re, s) != null

    private fun replaceAll(re: String, s: String, with: String): String =
        pattern(re, true).matcher(s).replaceAll(java.util.regex.Matcher.quoteReplacement(with))

    private fun replaceFirst(re: String, s: String, with: String): String {
        val m = firstMatch(re, s) ?: return s
        return s.substring(0, m.start) + with + s.substring(minOf(m.end, s.length))
    }

    // ---- dates ---------------------------------------------------------------------

    private val formatters = ConcurrentHashMap<String, DateTimeFormatter>()
    private fun fmt(d: LocalDate, pattern: String): String =
        formatters.getOrPut(pattern) { DateTimeFormatter.ofPattern(pattern, Locale.US) }.format(d)

    private val isoMillis = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US).withZone(ZoneOffset.UTC)

    private fun weekday0(d: LocalDate) = d.dayOfWeek.value % 7

    /** JS `new Date(y, mo0, d)` semantics: month and day overflow roll over (day 0 = last of previous month). */
    private fun ymd(y: Int, mo0: Int, d: Int): LocalDate =
        LocalDate.of(y, 1, 1).plusMonths(mo0.toLong()).plusDays((d - 1).toLong())

    private fun ymdString(d: LocalDate) = d.toString()

    // ---- constants -----------------------------------------------------------------

    private val weekdays = mapOf(
        "sun" to 0, "sunday" to 0, "mon" to 1, "monday" to 1, "tue" to 2, "tues" to 2, "tuesday" to 2,
        "wed" to 3, "weds" to 3, "wednesday" to 3, "thu" to 4, "thur" to 4, "thurs" to 4, "thursday" to 4,
        "fri" to 5, "friday" to 5, "sat" to 6, "saturday" to 6,
    )
    private val byday = listOf("SU", "MO", "TU", "WE", "TH", "FR", "SA")
    private val dayShort = listOf("Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat")
    private val months = mapOf(
        "jan" to 0, "january" to 0, "feb" to 1, "february" to 1, "mar" to 2, "march" to 2, "apr" to 3, "april" to 3,
        "may" to 4, "jun" to 5, "june" to 5, "jul" to 6, "july" to 6, "aug" to 7, "august" to 7, "sep" to 8, "sept" to 8,
        "september" to 8, "oct" to 9, "october" to 9, "nov" to 10, "november" to 10, "dec" to 11, "december" to 11,
    )
    private val mealTypes = setOf("breakfast", "lunch", "dinner", "snack")

    private const val WEEKDAY_RE = "sun|sunday|mon|monday|tues?|tuesday|wed|weds|wednesday|thur?s?|thursday|fri|friday|sat|saturday"
    private const val MONTH_RE = "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december"

    private fun mealTypeFrom(word: String?): String {
        val w = word.orEmpty().lowercase()
        if (w == "supper") return "dinner"
        if (w == "brunch") return "lunch"
        return if (w in mealTypes) w else "dinner"
    }

    private fun cap(s: String) = if (s.isEmpty()) s else s.substring(0, 1).uppercase() + s.substring(1)

    private class DayHit(val date: LocalDate, val label: String, val span: Span, val eveningHint: Boolean)
    private class TimeHit(val h: Int, val m: Int, val label: String, val span: Span)

    // ---- findDay -------------------------------------------------------------------

    private fun findDay(text: String, now: ZonedDateTime): DayHit? {
        val base = now.toLocalDate()

        firstMatch("""\b(today|tonight|tomorrow|this evening)\b""", text)?.let { m ->
            val word = m[1].orEmpty().lowercase()
            val evening = word == "tonight" || word == "this evening"
            val d = if (word == "tomorrow") base.plusDays(1) else base
            val label = if (word == "tomorrow") "Tomorrow" else if (evening) "Tonight" else "Today"
            return DayHit(d, label, m.span, evening)
        }

        firstMatch("""\b(next\s+)?($WEEKDAY_RE)\b""", text)?.let { m ->
            val wd = weekdays[m[2].orEmpty().lowercase()] ?: 0
            var delta = (wd - weekday0(base) + 7) % 7
            if (m[1] != null) delta += 7 // "next" pushes a full week out
            val d = base.plusDays(delta.toLong())
            val label = fmt(d, "EEEE")
            return DayHit(d, if (m[1] != null) "Next $label" else label, m.span, false)
        }

        firstMatch("""\b($MONTH_RE)\.?\s+(\d{1,2})(?:st|nd|rd|th)?\b""", text)?.let { m ->
            val mo = months[m[1].orEmpty().lowercase()] ?: 0
            val day = m[2]?.toIntOrNull() ?: 1
            var year = now.year
            val nowMo = now.monthValue - 1
            if (mo < nowMo || (mo == nowMo && day < now.dayOfMonth)) year += 1
            val d = ymd(year, mo, day)
            return DayHit(d, fmt(d, "MMM d"), m.span, false)
        }

        firstMatch("""\b(\d{1,2})/(\d{1,2})(?:/(\d{2,4}))?\b""", text)?.let { m ->
            val mo = (m[1]?.toIntOrNull() ?: 1) - 1
            val day = m[2]?.toIntOrNull() ?: 0
            if (mo in 0..11 && day in 1..31) {
                var year = now.year
                val nowMo = now.monthValue - 1
                val y3 = m[3]
                if (y3 != null) {
                    year = (if (y3.length == 2) "20$y3" else y3).toIntOrNull() ?: year
                } else if (mo < nowMo || (mo == nowMo && day < now.dayOfMonth)) {
                    year += 1
                }
                val d = ymd(year, mo, day)
                return DayHit(d, fmt(d, "MMM d"), m.span, false)
            }
        }
        return null
    }

    // ---- weekday lists / recurrence ------------------------------------------------

    private class Weekdays(val codes: List<String>, val spans: List<Span>, val labels: List<String>)

    private fun findAllWeekdays(text: String): Weekdays {
        val codes = mutableListOf<String>()
        val labels = mutableListOf<String>()
        val spans = mutableListOf<Span>()
        for (m in allMatches("""\b($WEEKDAY_RE)\b""", text)) {
            val dow = weekdays[m[1].orEmpty().lowercase()] ?: 0
            spans += m.span
            val code = byday[dow]
            if (code !in codes) {
                codes += code
                labels += dayShort[dow]
            }
        }
        return Weekdays(codes, spans, labels)
    }

    private fun detectEventRecurrence(text: String, startWeekday: Int): Pair<String?, List<Span>> {
        val spans = mutableListOf<Span>()
        fun add(h: Hit?) { if (h != null) spans += h.span }

        firstMatch("""\b(every\s*day|everyday|daily|each\s*day)\b""", text)?.let { add(it); return "FREQ=DAILY" to spans }
        firstMatch("""\b(every\s+)?weekdays?\b""", text)?.let { m ->
            if (test("""\bevery\b""", m[0].orEmpty())) { add(m); return "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" to spans }
        }

        var interval = 1
        firstMatch("""\b(every other|bi-?weekly|fortnightly)\b""", text)?.let { interval = 2; add(it) }
        val everyN = firstMatch("""\bevery\s+(\d{1,2})\s+(day|week|month|year)s?\b""", text)
        if (everyN != null) {
            interval = maxOf(1, everyN[1]?.toIntOrNull() ?: 1)
            add(everyN)
        }
        val unit = everyN?.get(2)?.lowercase()
        val iv = if (interval > 1) ";INTERVAL=$interval" else ""

        if (unit == "year" || test("""\b(yearly|annually|every year)\b""", text)) {
            add(firstMatch("""\b(yearly|annually|every year)\b""", text))
            return "FREQ=YEARLY$iv" to spans
        }
        if (unit == "month" || test("""\b(monthly|every month)\b""", text)) {
            add(firstMatch("""\b(monthly|every month)\b""", text))
            return "FREQ=MONTHLY$iv" to spans
        }

        val recurringCtx = firstMatch("""\b(every other|bi-?weekly|fortnightly)\b""", text) != null ||
            everyN != null || test("""\bevery\b""", text) || test("""\bweekly\b""", text)
        val days = mutableListOf<String>()
        for (w in allMatches("""\b($WEEKDAY_RE)(s)?\b""", text)) {
            val plural = w[2] != null
            if (!recurringCtx && !plural) continue // a lone weekday is a date (findDay)
            val code = byday[weekdays[w[1].orEmpty().lowercase()] ?: 0]
            spans += w.span
            if (code !in days) days += code
        }
        if (days.isNotEmpty()) return "FREQ=WEEKLY$iv;BYDAY=${days.joinToString(",")}" to spans

        if (unit == "week" || test("""\b(weekly|every week)\b""", text)) {
            add(firstMatch("""\b(weekly|every week)\b""", text))
            return "FREQ=WEEKLY$iv;BYDAY=${byday[startWeekday]}" to spans
        }
        return null to spans
    }

    // ---- time ----------------------------------------------------------------------

    private fun findTime(text: String): TimeHit? {
        firstMatch("""\b(noon|midnight)\b""", text)?.let { m ->
            val noon = m[1].orEmpty().lowercase() == "noon"
            return TimeHit(if (noon) 12 else 0, 0, if (noon) "12:00 PM" else "12:00 AM", m.span)
        }
        firstMatch("""\b(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b""", text)?.let { m ->
            var h = (m[1]?.toIntOrNull() ?: 0) % 12
            if (m[3].orEmpty().lowercase() == "pm") h += 12
            val min = m[2]?.toIntOrNull() ?: 0
            return TimeHit(h, min, fmtTime(h, min), m.span)
        }
        firstMatch("""\bat\s+(\d{1,2})(?::(\d{2}))?\b""", text)?.let { m ->
            var h = m[1]?.toIntOrNull() ?: 0
            val min = m[2]?.toIntOrNull() ?: 0
            if (h < 7 && m[2] == null) h += 12 // "at 4" almost always the afternoon
            if (h > 23 || min > 59) return null
            return TimeHit(h, min, fmtTime(h, min), m.span)
        }
        return null
    }

    private fun fmtTime(h: Int, m: Int): String {
        val ap = if (h < 12) "AM" else "PM"
        val h12 = if (h % 12 == 0) 12 else h % 12
        return "$h12:${m.toString().padStart(2, '0')} $ap"
    }

    // ---- person --------------------------------------------------------------------

    private fun findPerson(text: String, persons: List<String>): Pair<String, Span>? {
        for (p in persons) {
            firstMatch("\\bfor\\s+${Pattern.quote(p)}\\b", text)?.let { return p to it.span }
        }
        for (p in persons) {
            firstMatch("\\b${Pattern.quote(p)}(?:['\u2019]s)?\\b", text)?.let { return p to it.span }
        }
        return null
    }

    // ---- cut / tidy ----------------------------------------------------------------

    private fun cut(text: String, spans: List<Span>): String {
        var out = text
        for (s in spans.sortedByDescending { it.start }) {
            if (s.start > out.length) continue
            out = out.substring(0, minOf(s.start, out.length)) + " " + out.substring(minOf(s.end, out.length))
        }
        return out
    }

    private fun tidy(s: String): String {
        var out = replaceFirst("""^\s*(?:\b(?:at|on|for|the|a|an|to)\b\s*)+""", s, "")
        out = replaceAll("""\s{2,}""", out, " ")
        out = replaceAll("""^[\s,.–-]+|[\s,.!?–-]+$""", out, "")
        return out.trim()
    }

    // ---- grocery / list patterns ---------------------------------------------------

    private const val GROCERY_VERB = """^\s*(add|buy|get|grab|need|pick up|picking up|purchase)\b"""
    private const val GROCERY_TO_LIST = """\bto\s+(the\s+)?(grocery\s+|shopping\s+)?list\b"""
    private const val UNITS = "lb|lbs|oz|ozs|g|kg|gal|gallon|gallons|dozen|bunch|bunches|can|cans|box|boxes|bag|bags|bottle|bottles|pack|packs|jar|jars|loaf|loaves|carton|cartons"
    private const val GROCERY_UNIT = """\b\d+\s?($UNITS)\b"""
    private const val TASK_SIGNAL = """^\s*(remind|remember to|todo|to-do|task)\b"""
    private const val CHORE_WORD = """\bchore\b"""

    private fun splitQuantity(s: String): Pair<String?, String> {
        firstMatch("""^\s*(\d+(?:\.\d+)?\s?(?:$UNITS)?|a\s+dozen|a\s+couple)\b""", s)?.let { m ->
            val rest = s.substring(minOf(m.end, s.length))
            val name = replaceFirst("""^\s*(of\s+)?""", rest, "").trim()
            if (name.isNotEmpty()) {
                val q = m[1].orEmpty().trim()
                return replaceFirst("""^a\s+""", q, "") to name
            }
        }
        return null to s.trim()
    }

    private fun matchKnownList(text: String, lists: List<String>): String? {
        fun norm(s: String): String {
            var out = replaceAll("""[^a-z0-9 ]""", s.lowercase(), " ")
            out = replaceAll("""\b(the|a|an|my|our|list|to|for)\b""", out, " ")
            out = replaceAll("""\s+""", out, " ")
            return out.trim()
        }
        val ttoks = norm(text).split(" ").filter { it.isNotEmpty() }.toSet()
        var best: Pair<String, Double>? = null
        for (l in lists) {
            val ltoks = norm(l).split(" ").filter { it.isNotEmpty() }
            if (ltoks.isEmpty()) continue
            val score = ltoks.count { it in ttoks }.toDouble() / ltoks.size
            if (score >= 0.6 && (best == null || score > best.second)) best = l to score
        }
        return best?.first
    }

    // ---- countdown -----------------------------------------------------------------

    private fun countdownWhen(target: LocalDate, now: ZonedDateTime): String {
        val days = ChronoUnit.DAYS.between(now.toLocalDate(), target)
        val rel = if (days <= 0) "Today" else if (days == 1L) "Tomorrow" else "$days days"
        return "${fmt(target, "EEE, MMM d")} · $rel"
    }

    // ---- holidays ------------------------------------------------------------------
    // KEEP IN SYNC with the web `findHoliday` and the server `resolveDayFromText`.

    private class HolidayHit(val date: LocalDate, val label: String, val span: Span)

    private fun nthWeekdayOfMonth(year: Int, month: Int, targetDow: Int, n: Int): LocalDate {
        val first = ymd(year, month - 1, 1)
        val offset = (targetDow - weekday0(first) + 7) % 7
        return ymd(year, month - 1, 1 + offset + (n - 1) * 7)
    }

    private fun lastWeekdayOfMonth(year: Int, month: Int, targetDow: Int): LocalDate {
        val last = ymd(year, month, 0)
        val offset = (weekday0(last) - targetDow + 7) % 7
        return ymd(year, month - 1, last.dayOfMonth - offset)
    }

    /** Anonymous Gregorian algorithm (Computus). */
    private fun easterSunday(year: Int): LocalDate {
        val a = year % 19
        val b = year / 100
        val c = year % 100
        val d = b / 4
        val e = b % 4
        val f = (b + 8) / 25
        val g = (b - f + 1) / 3
        val h = (19 * a + b - d - g + 15) % 30
        val i = c / 4
        val k = c % 4
        val l = (32 + 2 * e + 2 * i - h - k) % 7
        val m = (a + 11 * h + 22 * l) / 451
        val month = (h + l - 7 * m + 114) / 31
        val day = ((h + l - 7 * m + 114) % 31) + 1
        return ymd(year, month - 1, day)
    }

    private class HolidayDef(val re: String, val label: String, val calc: (Int) -> LocalDate)

    private val holidays = listOf(
        HolidayDef("""\bnew\s+year'?s?\s+eve\b""", "New Year's Eve") { ymd(it, 11, 31) },
        HolidayDef("""\bnew\s+year'?s?(?:\s+day)?\b""", "New Year's Day") { ymd(it, 0, 1) },
        HolidayDef("""\bvalentine'?s?(?:\s+day)?\b""", "Valentine's Day") { ymd(it, 1, 14) },
        HolidayDef("""\bst\.?\s+patrick'?s?(?:\s+day)?\b""", "St. Patrick's Day") { ymd(it, 2, 17) },
        HolidayDef("""\bcinco\s+de\s+mayo\b""", "Cinco de Mayo") { ymd(it, 4, 5) },
        HolidayDef("""\bjuneteenth\b""", "Juneteenth") { ymd(it, 5, 19) },
        HolidayDef("""\b(?:independence\s+day|july\s+4th|july\s+4|4th\s+of\s+july|fourth\s+of\s+july)\b""", "Independence Day") { ymd(it, 6, 4) },
        HolidayDef("""\bhalloween\b""", "Halloween") { ymd(it, 9, 31) },
        HolidayDef("""\bveterans'?\s+day\b""", "Veterans Day") { ymd(it, 10, 11) },
        HolidayDef("""\bchristmas\s+eve\b""", "Christmas Eve") { ymd(it, 11, 24) },
        HolidayDef("""\b(?:christmas|xmas)\b""", "Christmas") { ymd(it, 11, 25) },
        HolidayDef("""\bmlk(?:\s+day)?\b|\bmartin\s+luther\s+king(?:\s+jr\.?)?(?:\s+day)?\b""", "MLK Day") { nthWeekdayOfMonth(it, 1, 1, 3) },
        HolidayDef("""\bpresidents'?\s+day\b""", "Presidents' Day") { nthWeekdayOfMonth(it, 2, 1, 3) },
        HolidayDef("""\bmother'?s?\s+day\b""", "Mother's Day") { nthWeekdayOfMonth(it, 5, 0, 2) },
        HolidayDef("""\bmemorial\s+day\b""", "Memorial Day") { lastWeekdayOfMonth(it, 5, 1) },
        HolidayDef("""\bfather'?s?\s+day\b""", "Father's Day") { nthWeekdayOfMonth(it, 6, 0, 3) },
        HolidayDef("""\blabor\s+day\b""", "Labor Day") { nthWeekdayOfMonth(it, 9, 1, 1) },
        HolidayDef("""\bthanksgiving\b""", "Thanksgiving") { nthWeekdayOfMonth(it, 11, 4, 4) },
        HolidayDef("""\bgood\s+friday\b""", "Good Friday") { easterSunday(it).minusDays(2) },
        HolidayDef("""\beaster\b""", "Easter") { easterSunday(it) },
    )

    private fun findHoliday(text: String, now: ZonedDateTime): HolidayHit? {
        val base = now.toLocalDate()
        var best: HolidayHit? = null
        for (h in holidays) {
            val m = firstMatch(h.re, text) ?: continue
            var date = h.calc(now.year)
            if (date.isBefore(base)) date = h.calc(now.year + 1)
            // Earliest match wins; at equal starts the earlier entry ("Christmas Eve" over "Christmas").
            if (best == null || m.start < best.span.start) best = HolidayHit(date, h.label, m.span)
        }
        return best
    }

    /** A future day with NO clock time: "N days until X", "X in N days", "countdown to X [on <date>]". */
    private fun detectCountdown(text: String, now: ZonedDateTime): CaptureIntent? {
        if (findTime(text) != null) return null // a clock time → schedule an event instead
        var titleRaw: String? = null
        var target: LocalDate? = null
        val today = now.toLocalDate()

        firstMatch("""^\s*(\d{1,3})\s+(?:days?|sleeps?)\s+(?:until|til|till|to|before)\s+(.+)$""", text)?.let { m ->
            target = today.plusDays((m[1]?.toLongOrNull() ?: 0))
            titleRaw = m[2]
        }
        if (titleRaw == null) {
            firstMatch("""^(.+?)\s+in\s+(\d{1,3})\s+(?:days?|sleeps?)\s*$""", text)?.let { m ->
                target = today.plusDays((m[2]?.toLongOrNull() ?: 0))
                titleRaw = m[1]
            }
        }
        if (titleRaw == null) {
            firstMatch("""\bcountdown\s+(?:to|until|til|till|for)\s+(.+)$""", text)?.let { m ->
                val raw = m[1].orEmpty()
                titleRaw = raw
                val dh = findDay(raw, now)
                if (dh != null) {
                    target = dh.date
                    titleRaw = replaceFirst("""\b(?:on|to)\s*$""", cut(raw, listOf(dh.span)), "")
                } else {
                    findHoliday(raw, now)?.let { hh ->
                        target = hh.date
                        val remaining = tidy(cut(raw, listOf(hh.span)))
                        titleRaw = remaining.ifEmpty { hh.label }
                    }
                }
            }
        }
        val tRaw = titleRaw ?: return null
        val t = target ?: return null
        val title = cap(tidy(tRaw))
        return CaptureIntent.Countdown(title.ifEmpty { "Countdown" }, ymdString(t), null, countdownWhen(t, now))
    }

    // ---- new household member ------------------------------------------------------

    private const val REL_KID = "son|daughter|kid|child|boy|girl|baby"
    private const val REL_TEEN = "teenager|teen"
    private const val REL_ADULT = "husband|wife|spouse|partner|mom|mum|mommy|mother|dad|daddy|father|parent|adult|grandma|grandpa|grandmother|grandfather"

    private fun memberTypeForRel(word: String): String = when {
        test("^(?:$REL_KID)$", word.lowercase()) -> "kid"
        test("^(?:$REL_TEEN)$", word.lowercase()) -> "teen"
        else -> "adult"
    }

    /** Drop a trailing ", age 8" / "aged 8" — age maps to nothing today. */
    private fun cleanPersonName(raw: String): String =
        cap(tidy(replaceFirst("""[\s,]+(?:who\s+is\s+|aged?\s+)\d{1,3}\b.*$""", raw, "")))

    private fun detectPerson(text: String): CaptureIntent? {
        if (findTime(text) != null) return null // a clock time → scheduling, not a profile
        // A birthday / weekday / dated note is an event or countdown, not a profile.
        if (test("""\bbirthday\b""", text)) return null
        if (test("""\b(?:$WEEKDAY_RE)s?\b""", text)) return null
        if (test("""\b(?:$MONTH_RE)\.?\s+\d{1,2}\b""", text) || test("""\b\d{1,2}/\d{1,2}\b""", text)) return null
        // The lookahead stops "mom's"/"dad's" being read as a relationship.
        val relPat = "\\b(?:add|create|make|register)\\s+(?:my|our|a|an|the)?\\s*(?:new\\s+)?($REL_KID|$REL_TEEN|$REL_ADULT)(?![\u2019'\u02BC]s)\\b[\\s,:-]*(?:named\\s+|called\\s+)?(.+)$"
        firstMatch(relPat, text)?.let { m ->
            val name = cleanPersonName(m[2].orEmpty())
            if (name.isNotEmpty()) return CaptureIntent.Person(name, memberTypeForRel(m[1].orEmpty()), null, null, false)
        }
        val memPat = "\\b(?:add|create|make|register)\\s+(?:a\\s+|an\\s+|the\\s+|my\\s+|our\\s+)?(?:new\\s+)?(?:family\\s+member|household\\s+member|family\\s+profile|profile|person|member)\\b\\s*(?:for\\s+|named\\s+|called\\s+|[:-]\\s*)?(.+)$"
        firstMatch(memPat, text)?.let { m ->
            val name = cleanPersonName(m[1].orEmpty())
            if (name.isNotEmpty()) return CaptureIntent.Person(name, "adult", null, null, false)
        }
        return null
    }

    // ---- goal ----------------------------------------------------------------------

    private const val GOAL_TRIGGER = "^\\s*(?:set(?:ting)?\\s+(?:a\\s+|an\\s+|the\\s+|our\\s+|my\\s+|myself\\s+a\\s+|myself\\s+|us\\s+a\\s+|us\\s+)?(?:[a-z]+\\s+){0,3}?goal\\s+(?:to|of|:)\\s+|add\\s+(?:a\\s+|an\\s+|the\\s+|our\\s+|my\\s+)?(?:[a-z]+\\s+){0,3}?goal\\s+(?:to\\s+|of\\s+)?|(?:i|we)\\s+want\\s+to\\s+|(?:i|we)['\u2019]d\\s+like\\s+to\\s+|my\\s+goal\\s+is\\s+(?:to\\s+)?|our\\s+goal\\s+is\\s+(?:to\\s+)?|new\\s+goal\\s*[:-]\\s*)(.+)$"

    /** Units that ACCUMULATE → a `total` goal; anything else countable → a `count` goal. */
    private const val GOAL_TOTAL_UNIT = "^(?:miles?|mi|kilometers?|km|meters?|m|lbs?|pounds?|kgs?|kilograms?|kilos?|ounces?|oz|grams?|g|hours?|hrs?|hr|minutes?|mins?|min|seconds?|secs?|days?|weeks?|dollars?|usd|bucks?|cents?|gallons?|gal|liters?|litres?|l|calories?|cals?|cal|steps?|reps?|points?|pts?)$"

    private class Measure(val targetValue: Double, val unit: String, val goalType: String, val span: Span)

    private fun goalMeasure(text: String): Measure? {
        firstMatch("""(\$)\s?(\d+(?:\.\d+)?)""", text)?.let { return Measure(it[2]?.toDoubleOrNull() ?: 0.0, "dollars", "total", it.span) }
        firstMatch("""(\d+(?:\.\d+)?)\s+([A-Za-z]+)""", text)?.let { m ->
            val unit = m[2].orEmpty().lowercase()
            return Measure(m[1]?.toDoubleOrNull() ?: 0.0, unit, if (test(GOAL_TOTAL_UNIT, unit)) "total" else "count", m.span)
        }
        return null
    }

    private class Deadline(val date: String, val start: Int, val end: Int)

    private fun goalDeadline(text: String, now: ZonedDateTime): Deadline? {
        firstMatch("""\b(?:by\s+|before\s+)?(?:the\s+end\s+of\s+)?this\s+(year|month)\b""", text)?.let { ty ->
            val d = if (ty[1].orEmpty().lowercase() == "year") ymd(now.year, 11, 31) else ymd(now.year, now.monthValue, 0)
            return Deadline(ymdString(d), ty.start, ty.end)
        }
        firstMatch("""\bby\s+($MONTH_RE)\b""", text)?.let { bm ->
            if (!test("""^\s*\d""", text.substring(minOf(bm.end, text.length)))) {
                val mo = months[bm[1].orEmpty().lowercase()] ?: 0
                var year = now.year
                if (mo < now.monthValue - 1) year += 1
                return Deadline(ymdString(ymd(year, mo + 1, 0)), bm.start, bm.end)
            }
        }
        firstMatch("""\bby\s+""", text)?.let { by ->
            val after = text.substring(minOf(by.end, text.length))
            findDay(after, now)?.let { dh -> return Deadline(ymdString(dh.date), by.start, by.end + dh.span.end) }
        }
        return null
    }

    /** Who the goal is for, from the phrasing: "everyone", "me", or null for no hint. */
    private fun goalAudience(text: String): String? {
        if (test("""\b(family|our|everyone|shared|as a family|together|us|we want)\b""", text)) return "everyone"
        if (test("""\b(personal|my own|for myself|my goal|i want to|i['’]d like to)\b""", text)) return "me"
        return null
    }

    private fun detectGoal(text: String, now: ZonedDateTime): CaptureIntent? {
        val m = firstMatch(GOAL_TRIGGER, text) ?: return null
        // A soft trigger ("I want to") without the word "goal" must not hijack a meal phrase.
        val full = m[0].orEmpty()
        val bodyStr = m[1].orEmpty()
        val trigger = if (full.endsWith(bodyStr)) full.dropLast(bodyStr.length) else full
        val softTrigger = !trigger.lowercase().contains("goal")
        val mealSignal = test("""\bfor\s+(dinner|lunch|breakfast|supper|brunch)\b""", text) ||
            test("""\b(meal\s*plan|on the menu|dinner menu)\b""", text)
        if (softTrigger && mealSignal) return null

        var body = bodyStr
        // Deadline first, so a trailing "by september" isn't read as a target unit.
        var deadline: String? = null
        goalDeadline(body, now)?.let { dl ->
            deadline = dl.date
            body = body.substring(0, minOf(dl.start, body.length)) + " " + body.substring(minOf(dl.end, body.length))
        }
        var goalType = "habit"
        var targetValue: Double? = null
        var unit: String? = null
        goalMeasure(body)?.let { meas ->
            goalType = meas.goalType
            targetValue = meas.targetValue
            unit = meas.unit
            body = body.substring(0, minOf(meas.span.start, body.length)) + " " + body.substring(minOf(meas.span.end, body.length))
        }
        val title = cap(tidy(body))
        if (title.isEmpty()) return null
        return CaptureIntent.Goal(title, goalType, targetValue, unit, deadline, "shared_total", goalAudience(text))
    }

    // ---- pantry --------------------------------------------------------------------
    // An item ALREADY on hand with an explicit pantry/fridge/freezer destination. A bare
    // "add milk" or "add milk to the shopping list" stays grocery.

    private const val PANTRY_TARGET = """\b(?:to|in|into|inside)\s+(?:the\s+|my\s+|our\s+)?(pantry|fridge|freezer|refrigerator)\b"""
    private const val PANTRY_LEAD = """^\s*(?:please\s+|kindly\s+|can you\s+)?(?:we\s+have\s+|i\s+have\s+|there(?:'s|\s+is|\s+are)\s+|add|put|throw|toss|drop|stock|store|stick|need|get|grab)?\s*(.+?)\s+(?:to|in|into|inside)\s+(?:the\s+|my\s+|our\s+)?(?:pantry|fridge|freezer|refrigerator)\b"""

    private fun pantryLocation(word: String): String = when (word.lowercase()) {
        "fridge", "refrigerator" -> "Fridge"
        "freezer" -> "Freezer"
        else -> "Pantry"
    }

    private fun splitAmountUnit(s: String): Triple<String?, String?, String> {
        val (quantity, name) = splitQuantity(s)
        val q = quantity ?: return Triple(null, null, name)
        firstMatch("""^(\d+(?:\.\d+)?)\s*(.*)$""", q)?.let { m ->
            val unit = m[2].orEmpty().trim()
            return Triple(m[1], unit.ifEmpty { null }, name)
        }
        return Triple(q, null, name)
    }

    private fun detectPantry(text: String): CaptureIntent? {
        val loc = firstMatch(PANTRY_TARGET, text) ?: return null
        val location = pantryLocation(loc[1].orEmpty())
        val basis = tidy(firstMatch(PANTRY_LEAD, text)?.get(1) ?: text)
        val (amount, unit, name) = splitAmountUnit(basis)
        val itemName = cap(name)
        if (itemName.isEmpty()) return null
        return CaptureIntent.Pantry(itemName, amount, unit, location, null, null)
    }

    // ---- reward --------------------------------------------------------------------
    // Triggers on the explicit word "reward". Offline can't know the household's
    // currency / category / approval default, so those stay null.

    private const val REWARD_WORD = """\breward\b"""
    private const val REWARD_LEAD = """^\s*(?:please\s+|kindly\s+|can you\s+)?(?:add|create|make|set\s*up|new|give)?\s*(?:a\s+|an\s+|the\s+)?(?:new\s+)?reward\b[\s:—-]*(?:called\s+|named\s+|for\s+|entitled\s+)?(.*)$"""
    private const val REWARD_COST = """\b(?:for|costs?|worth|priced\s+at|at|=)\s+(\d{1,6})\s*(?:stars?|points?|pts?|coins?)?\b|\b(\d{1,6})\s*(?:stars?|points?|pts?|coins?)\b"""

    private fun detectReward(text: String): CaptureIntent? {
        if (!test(REWARD_WORD, text)) return null
        var basis = firstMatch(REWARD_LEAD, text)?.get(1) ?: text
        var cost: Int? = null
        firstMatch(REWARD_COST, basis)?.let { cm ->
            cost = (cm[1] ?: cm[2])?.toIntOrNull()
            basis = basis.substring(0, cm.start) + " " + basis.substring(minOf(cm.end, basis.length))
        }
        basis = replaceFirst("""\b(?:for|costs?|worth|priced\s+at|at)\s*$""", basis, "")
        val title = cap(tidy(basis))
        if (title.isEmpty()) return null
        return CaptureIntent.Reward(title, null, cost, null, null, null)
    }

    // ---- mutate (Tier 2 — act on an existing row) ----------------------------------
    // A NON-committable marker: the real verb/targetKind/id come from the server intent +
    // /api/capture/resolve, so looksConfident is false and it never auto-commits.

    private class MutatePattern(val re: String, val verb: String)

    private val mutatePatterns = listOf(
        MutatePattern("""^\s*(?:please\s+)?(?:mark|set)\s+(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished|off)\b""", "complete"),
        MutatePattern("""^\s*(?:please\s+)?(?:check|cross|tick)\s+off\s+(.+)$""", "complete"),
        MutatePattern("""^\s*(?:please\s+)?(?:check|cross|tick)\s+(.+?)\s+off\b""", "complete"),
        MutatePattern("""^\s*(?:please\s+)?(?:complete|finish)\s+(.+)$""", "complete"),
        MutatePattern("""^\s*(?:please\s+)?(?:delete|remove|cancel)\s+(.+)$""", "delete"),
        MutatePattern("""^\s*(?:please\s+)?(?:reschedule|move|push)\s+(.+?)\s+(?:to|for)\s+.+$""", "reschedule"),
        MutatePattern("""^\s*(?:please\s+)?reschedule\s+(.+)$""", "reschedule"),
        MutatePattern("""^\s*(?:please\s+)?(?:reassign|give|assign)\s+(.+?)\s+to\s+.+$""", "reassign"),
        MutatePattern("""^\s*(?:please\s+)?redeem\s+(.+)$""", "redeem"),
        MutatePattern("""^\s*.+?\s+(?:spent|spend|spends)\s+.+?\b(?:points?|stars?|pts?|coins?)\b.*?\s+(?:on|for)\s+(.+)$""", "redeem"),
        MutatePattern("""^\s*.+?\s+(?:spent|spend|spends)\s+.+?\s+(?:on|for)\s+(.+?\breward\b.*)$""", "redeem"),
        // log needs real goal-log signal; a bare "log/record X" is NOT a mutate.
        MutatePattern("""^\s*(?:please\s+)?(?:log|record)\s+(\d+(?:\.\d+)?(?:\s+.+)?)$""", "log"),
        MutatePattern("""^\s*(?:please\s+)?(?:log|record)\s+(.+?\bgoal\b.*)$""", "log"),
        MutatePattern("""^\s*.+?\s+(?:spent|spend|spends)\s+(\d+(?:\.\d+)?\s*(?:hours?|hrs?|minutes?|mins?)\b.*)$""", "log"),
        MutatePattern("""^\s*(?:please\s+)?add\s+.+?\s+to\s+(.+?\bgoal\b.*)$""", "log"),
    )

    private val verbDefaultKind = mapOf(
        "complete" to "chore", "log" to "goal", "reschedule" to "event",
        "reassign" to "chore", "redeem" to "reward", "delete" to "event",
    )

    private fun guessTargetKind(text: String, verb: String): String = when {
        test("""\bchores?\b""", text) -> "chore"
        test("""\bgoals?\b""", text) -> "goal"
        test("""\breward\b""", text) -> "reward"
        test("""\b(appointment|meeting|event|practice|reservation)\b""", text) -> "event"
        test("""\b(?:list\s*item|item|list)\b""", text) || (verb == "complete" && test("""\boff\b""", text)) -> "listItem"
        else -> verbDefaultKind[verb] ?: "chore"
    }

    private fun mutateArgs(verb: String, text: String, now: ZonedDateTime): Map<String, JsonElement> {
        if (verb == "log") {
            firstMatch("""(\d+(?:\.\d+)?)\s*([a-z]+)""", text)?.let { m ->
                val n = m[1]?.toDoubleOrNull() ?: 0.0
                val unit = m[2].orEmpty().lowercase()
                if (test("""^(?:hours?|hrs?|hr)$""", unit)) return mapOf("hours" to JsonPrimitive(n))
                if (test("""^(?:minutes?|mins?|min)$""", unit)) return mapOf("minutes" to JsonPrimitive(n))
                return mapOf("amount" to JsonPrimitive(n))
            }
        }
        if (verb == "reassign") {
            firstMatch("""\bto\s+([A-Za-z][\w'’-]*)""", text)?.let { return mapOf("personName" to JsonPrimitive(it[1].orEmpty())) }
        }
        if (verb == "reschedule") {
            // Lazy `.*?` so a trailing participant clause can't swallow the spoken date.
            firstMatch("""^.*?\b(?:to|for)\s+(.+)$""", text)?.let { m ->
                val dest = m[1].orEmpty()
                val args = linkedMapOf<String, JsonElement>()
                findDay(dest, now)?.let { args["date"] = JsonPrimitive(ymdString(it.date)) }
                findTime(dest)?.let { args["time"] = JsonPrimitive(String.format(Locale.US, "%02d:%02d", it.h, it.m)) }
                return args
            }
        }
        return emptyMap()
    }

    /** Clean a captured noun phrase into a display description. */
    private fun mutateDescription(raw: String): String {
        var s = tidy(raw)
        firstMatch(""" (?:on|to) (?:my |our |the )?""", s)?.let { pre -> s = s.substring(minOf(pre.end, s.length)) }
        s = replaceFirst("""^\s*(?:my |our |the )""", s, "")
        s = replaceFirst("""^\s*\d+(?:\.\d+)?\s+[a-z]+\s+""", s, "")
        s = replaceFirst("""\s+for\s+[a-z].*$""", s, "")
        // Drop a trailing kind noun so the name drives ranking — unless that empties it.
        val bare = replaceFirst("""\s+(?:goals?|chores?|rewards?|events?|tasks?|items?)\s*$""", s, "")
        if (tidy(bare).isNotEmpty()) s = bare
        return tidy(s)
    }

    private fun detectMutate(text: String, now: ZonedDateTime): CaptureIntent? {
        for (pat in mutatePatterns) {
            val m = firstMatch(pat.re, text) ?: continue
            val description = mutateDescription(m[1].orEmpty())
            if (description.isEmpty()) continue
            return CaptureIntent.Mutate(pat.verb, guessTargetKind(text, pat.verb), description, mutateArgs(pat.verb, text, now))
        }
        return null
    }

    // ---- parse ---------------------------------------------------------------------

    fun parse(
        raw: String,
        persons: List<String> = emptyList(),
        now: ZonedDateTime = ZonedDateTime.now(),
        lists: List<String> = emptyList(),
    ): CaptureIntent? {
        val text = raw.trim()
        if (text.isEmpty()) return null

        val person = findPerson(text, persons)

        detectMutate(text, now)?.let { return it }
        detectPerson(text)?.let { return it }
        detectGoal(text, now)?.let { return it }
        detectReward(text)?.let { return it }

        // TASK / CHORE — an explicit keyword wins over the date heuristics.
        if (test(TASK_SIGNAL, text) || test(CHORE_WORD, text)) return parseTask(text, persons)

        // MEAL — "meal plan" phrasing, or "<dish> for dinner/lunch" (no clock time).
        val mealPhrase = test("""\b(meal\s*plan|on the menu|dinner menu)\b""", text)
        val forMeal = firstMatch("""\bfor\s+(dinner|lunch|breakfast|supper|brunch)\b""", text)
        val eatOut = test("""\b(eat|eating|dining|going)\s*out\b|\btake\s*-?out\b|\border(?:ing)?\s+in\b|\bdelivery\b|\btakeaway\b""", text)
        if (mealPhrase || ((forMeal != null || eatOut) && findTime(text) == null)) {
            val mealType = mealTypeFrom(forMeal?.get(1))
            val mDay = findDay(text, now)
            val date = mDay?.let { ymdString(it.date) }
            val whenLabel = "${mDay?.label ?: "Today"} · ${cap(mealType)}"
            if (eatOut) return CaptureIntent.Meal("Eating out", date, mealType, whenLabel)
            var t = cut(text, listOfNotNull(mDay?.span, forMeal?.span))
            t = replaceAll("""\b(?:on|to|onto|in)\s+(?:the\s+)?(?:meal\s*plan|menu|dinner menu)\b""", t, "")
            t = replaceAll("""\b(?:meal\s*plan|on the menu|dinner menu)\b""", t, "")
            t = replaceFirst("""^\s*(?:please\s+|kindly\s+|let'?s?\s+|can we\s+|i\s+want\s+(?:to\s+)?)?(?:put|add|plan|make|do|have|cook|throw|schedule)\b""", t, "")
            t = replaceAll("""\b(?:please|kindly)\b""", t, "")
            return CaptureIntent.Meal(cap(tidy(t)).ifEmpty { "Meal" }, date, mealType, whenLabel)
        }

        // LIST — a non-grocery named list.
        var listName = matchKnownList(text, lists)
        if (listName == null) {
            firstMatch("""\b(?:to|on|onto|in)\s+(?:the\s+|my\s+|our\s+)?([a-z0-9][a-z0-9 ]*?)\s+list\b""", text)?.let { g ->
                val name = g[1].orEmpty().trim()
                if (!test("""^(grocery|shopping|to-?do)\s*$""", name)) listName = cap(name)
            }
        }
        listName?.let { ln ->
            val im = firstMatch("""^\s*(?:please\s+|kindly\s+|can you\s+)?(?:add|put|throw|toss|drop|need|get|grab)?\s*(.+?)\s+(?:to|on|onto|in)\s+(?:the\s+|my\s+|our\s+)?""", text)
            val (quantity, name) = splitQuantity(tidy(im?.get(1) ?: text))
            val itemName = cap(name)
            if (itemName.isNotEmpty()) return CaptureIntent.ListItem(itemName, ln, quantity)
        }

        // COUNTDOWN — before the event branch so "countdown to X on <date>" isn't a dated event.
        detectCountdown(text, now)?.let { return it }

        val day = findDay(text, now)
        val time = findTime(text)
        val startWeekday = day?.let { weekday0(it.date) } ?: weekday0(now.toLocalDate())
        val (rrule, recSpans) = detectEventRecurrence(text, startWeekday)

        // EVENT — a concrete day/time, or a recurrence cue.
        if (day != null || time != null || rrule != null) {
            val base = now.toLocalDate()
            val targetDay: LocalDate = when {
                day != null -> day.date
                rrule != null -> firstMatch("""FREQ=WEEKLY.*BYDAY=([A-Z]{2})""", rrule, ci = false)?.let { bd ->
                    val idx = byday.indexOf(bd[1]).coerceAtLeast(0)
                    base.plusDays(((idx - weekday0(base) + 7) % 7).toLong())
                } ?: base
                else -> base
            }
            var allDay = true
            var target: LocalDateTime = targetDay.atStartOfDay()
            if (time != null) {
                target = targetDay.atTime(time.h, time.m)
                allDay = false
            } else if (day?.eveningHint == true) {
                target = targetDay.atTime(18, 0)
                allDay = false
            }

            val spans = listOfNotNull(day?.span, time?.span, person?.second) + recSpans
            var titleRaw = cut(text, spans)
            if (rrule != null) titleRaw = replaceAll("""\b(every|each|other|and|on)\b""", titleRaw, " ")
            titleRaw = replaceFirst("""^\s*(?:please\s+|kindly\s+)?(?:add|create|schedule|set\s*up|put|new|make)\b""", titleRaw, "")
            titleRaw = replaceAll("""\b(?:to|on|in)\s+(?:the\s+|my\s+|our\s+)?calendar\b""", titleRaw, "")
            val title = cap(tidy(titleRaw))
            val dayLabel = day?.label ?: fmt(targetDay, "EEE, MMM d")
            val timePart = if (allDay) "All day" else time?.label ?: if (day?.eveningHint == true) "6:00 PM" else ""
            val whenLabel = listOf(dayLabel, timePart).filter { it.isNotEmpty() }.joinToString(" · ")
            val scheduleLabel = if (rrule != null) CaptureRecurrence.describeRrule(rrule, targetDay) else ""
            return CaptureIntent.Event(
                title = title.ifEmpty { "Event" },
                startsAt = isoMillis.format(target.atZone(now.zone).toInstant()),
                allDay = allDay,
                personName = person?.first,
                rrule = rrule,
                scheduleLabel = scheduleLabel,
                whenLabel = whenLabel,
            )
        }

        // PANTRY — before the grocery fallback so it isn't mis-routed to the shopping list.
        detectPantry(text)?.let { return it }

        // GROCERY — verbs, "to the list", units, or the bare-noun fallback.
        var stripped = cut(text, listOfNotNull(person?.second))
        stripped = replaceFirst(GROCERY_VERB, stripped, "")
        stripped = replaceFirst(GROCERY_TO_LIST, stripped, "")
        val (quantity, name) = splitQuantity(stripped.trim())
        val finalName = cap(replaceAll("""^[\s,]+|[\s,]+$""", name, ""))
        if (finalName.isEmpty()) return null
        return CaptureIntent.Grocery(finalName, quantity)
    }

    private fun parseTask(text: String, persons: List<String>): CaptureIntent {
        val quote = firstMatch("""["“]([^"”]+)["”]""", text)
        val rest = if (quote != null) text.substring(0, quote.start) + " " + text.substring(quote.end) else text

        val wd = findAllWeekdays(rest)
        val dailyRe = """\b(every\s*day|everyday|daily|each\s*day)\b"""
        var rrule: String? = null
        var scheduleLabel = ""
        if (test(dailyRe, rest)) {
            rrule = "FREQ=DAILY"
            scheduleLabel = "Every day"
        } else if (wd.codes.isNotEmpty()) {
            rrule = "FREQ=WEEKLY;BYDAY=${wd.codes.joinToString(",")}"
            scheduleLabel = wd.labels.joinToString(" & ")
        }
        val starM = firstMatch("""\b(\d{1,2})\s*stars?\b""", rest)
        val stars = starM?.get(1)?.toIntOrNull()
        val personHit = findPerson(rest, persons)

        if (quote != null) {
            val inner = replaceAll("""\s{2,}""", replaceFirst("""\s+as\s+an?\s+(chores?|tasks?)\b""", quote[1].orEmpty(), ""), " ")
            val title = cap(inner.trim())
            return CaptureIntent.Task(title.ifEmpty { "Task" }, personHit?.first, stars, rrule, scheduleLabel)
        }
        val spans = listOfNotNull(personHit?.second) + wd.spans + listOfNotNull(starM?.span)
        var t = cut(rest, spans)
        t = replaceFirst("""\bto\s+(?:the\s+)?(?:chores?|tasks?|grocery|shopping|to-?do)?\s*lists?\b.*$""", t, "")
        t = replaceFirst("""^\s*(?:please\s+|kindly\s+)?(?:add|make|create|set\s*up|give|new|put|remind\w*|remember\s+to)\b""", t, "")
        t = replaceFirst("""^\s*(?:an?\s+)?(?:chores?|tasks?)\b[:\s]+(?:to\s+|for\s+)?""", t, "")
        t = replaceFirst("""^\s*to\s+""", t, "")
        t = replaceFirst(dailyRe, t, "")
        t = replaceAll("""\b(night|nights|evening|evenings|morning|mornings|tonight)\b""", t, "")
        t = replaceAll("""\b(?:every|each|worth|and)\b""", t, "")
        t = replaceAll("""\s*,\s*""", t, " ")
        t = replaceAll("""\b(?:for|on|to|with)\s+(?=\s|$)""", t, " ")
        t = replaceFirst("""\b(?:for|on|to|with)\s*$""", t, "")
        val tt = cap(tidy(t))
        return CaptureIntent.Task(tt.ifEmpty { "Task" }, personHit?.first, stars, rrule, scheduleLabel)
    }

    /**
     * Whether the on-device guess is strong enough to show before the server answers.
     * Every kind needs an explicit signal EXCEPT the bare-noun grocery fallback; a mutate
     * marker is never confident (it forces the server resolve path).
     */
    fun looksConfident(intent: CaptureIntent?, text: String): Boolean = when (intent) {
        null, is CaptureIntent.Mutate -> false
        is CaptureIntent.Grocery -> test("""\b(buy|grab|pick(?:ing)?\s*up|purchase)\b""", text) ||
            test(GROCERY_TO_LIST, text) || test(GROCERY_UNIT, text)
        else -> true
    }
}
