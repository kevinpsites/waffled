package app.waffled.core.model

import kotlin.test.Test
import kotlin.test.assertEquals

class CurrencyTest {

    @Test
    fun fallsBackWhenTheHouseholdConfiguredNoSymbolOrLabel() {
        val bare = Currency(key = "stars")
        assertEquals("★", bare.displaySymbol)
        assertEquals("stars", bare.displayLabel)
    }

    @Test
    fun usesTheConfiguredSymbolAndLabelWhenPresent() {
        val c = Currency(key = "stars", label = "Gold stars", symbol = "⭐")
        assertEquals("⭐", c.displaySymbol)
        assertEquals("Gold stars", c.displayLabel)
    }
}

class ProgressPercentTest {

    @Test
    fun truncatesRatherThanRoundingUp() {
        // 999/1000 must read 99%, never a rounded 100% telling a child their jar is full
        // when it is not.
        assertEquals(99, progressPercent(999, 1000))
        assertEquals(0, progressPercent(9, 1000))
    }

    @Test
    fun reachesOneHundredOnlyWhenActuallyThere() {
        assertEquals(100, progressPercent(1000, 1000))
        assertEquals(100, progressPercent(1500, 1000), "must never exceed 100")
    }

    @Test
    fun handlesTheDegenerateCasesWithoutDividingByZero() {
        assertEquals(0, progressPercent(50, 0))
        assertEquals(0, progressPercent(50, -1))
        assertEquals(0, progressPercent(0, 100))
        assertEquals(0, progressPercent(-5, 100), "a negative balance is not negative progress")
    }

    @Test
    fun doesNotOverflowOnLargeBalances() {
        // current * 100 in Int would overflow past ~21m; the computation widens to Long.
        assertEquals(50, progressPercent(1_000_000_000, 2_000_000_000))
    }
}
