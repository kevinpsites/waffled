package app.waffled.feature.kiosk

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The PIN pad's pure state: 4–8 digits, wrong-PIN copy, and the lockout countdown. */
class PinPadStateTest {

    private fun typed(digits: String) = digits.fold(PinPadState()) { s, c -> s.press(c) }

    @Test fun submitNeedsAtLeastFourDigits() {
        assertFalse(typed("123").canSubmit)
        assertTrue(typed("1234").canSubmit)
    }

    @Test fun pinCapsAtEightDigits() {
        assertEquals("12345678", typed("1234567890").pin)
    }

    @Test fun dotsShowOneSpareSlotWithAFloorOfFour() {
        assertEquals(4, typed("").dotCount)
        assertEquals(4, typed("123").dotCount)
        assertEquals(5, typed("1234").dotCount)
        assertEquals(9, typed("12345678").dotCount)
    }

    @Test fun backspaceRemovesOneAndClearsTheMessage() {
        val s = typed("12").copy(message = "Incorrect PIN").backspace()
        assertEquals("1", s.pin)
        assertNull(s.message)
        assertEquals("", PinPadState().backspace().pin)
    }

    @Test fun wrongPinClearsTheEntryAndCountsTriesInPlainEnglish() {
        assertEquals("Incorrect PIN — 2 tries left", typed("1111").after(ClaimOutcome.WrongPin(2)).message)
        assertEquals("Incorrect PIN — 1 try left", typed("1111").after(ClaimOutcome.WrongPin(1)).message)
        val last = typed("1111").after(ClaimOutcome.WrongPin(0))
        assertEquals("Incorrect PIN", last.message)
        assertEquals("", last.pin)
    }

    @Test fun lockoutBlocksInputAndCountsDown() {
        var s = typed("1111").after(ClaimOutcome.LockedOut(2))
        assertEquals("", s.pin)
        assertEquals("Locked — try again in 2s", s.prompt)
        assertTrue(s.locked)
        assertEquals("", s.press('5').pin)
        s = s.tick()
        assertEquals("Locked — try again in 1s", s.prompt)
        s = s.tick()
        assertFalse(s.locked)
        assertEquals("Enter your PIN", s.prompt)
        assertEquals(s, s.tick())
    }

    @Test fun aGenericFailureKeepsTheEntry() {
        val s = typed("1234").after(ClaimOutcome.Failed("Couldn’t reach the server."))
        assertEquals("1234", s.pin)
        assertEquals("Couldn’t reach the server.", s.message)
    }

    @Test fun messageIsHiddenWhileLocked() {
        val s = PinPadState(message = "x", lockedFor = 3)
        assertNull(s.visibleMessage)
    }

    @Test fun pairingCodeNeedsFourCharacters() {
        assertFalse(KioskCodeEntry.canSubmit(" 12 ", busy = false))
        assertTrue(KioskCodeEntry.canSubmit(" 1234 ", busy = false))
        assertFalse(KioskCodeEntry.canSubmit("1234", busy = true))
    }
}
