package app.waffled.feature.settings

import app.waffled.core.network.WaffledApiException
import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** The role × capability grid on Family & People (iOS `PermissionsCard`). */
class PermissionsMatrixModelTest {

    private val start = mapOf(
        "adult" to mapOf("chore.manage" to true),
        "teen" to mapOf("chore.manage" to false),
    )

    @Test
    fun `grid lists three roles and four capabilities with iOS copy`() {
        assertEquals(listOf("adult", "teen", "kid"), PermissionsGrid.roles)
        assertEquals(listOf("chore.manage", "chore.approve", "reward.manage", "reward.approve"), PermissionsGrid.capabilities)
        assertEquals("Teens", PermissionsGrid.roleLabel("teen"))
        assertEquals("Approve redemptions", PermissionsGrid.capabilityLabel("reward.approve"))
        assertEquals("OK or send back finished chores", PermissionsGrid.capabilitySubtitle("chore.approve"))
    }

    @Test
    fun `a 403 on load hides the card instead of erroring`() = runTest {
        val model = PermissionsMatrixModel(
            fetch = { throw WaffledApiException(403, "Forbidden") },
            save = { it },
        )
        model.load()
        assertTrue(model.hidden)
        assertNull(model.matrix)
    }

    @Test
    fun `toggle flips one cell optimistically and adopts the saved matrix`() = runTest {
        var sent: Map<String, Map<String, Boolean>>? = null
        val model = PermissionsMatrixModel(fetch = { start }, save = { sent = it; it })
        model.load()

        model.toggle("teen", "chore.manage")

        assertEquals(true, sent?.get("teen")?.get("chore.manage"))
        assertEquals(true, model.matrix?.get("teen")?.get("chore.manage"))
        assertEquals(true, model.matrix?.get("adult")?.get("chore.manage"))
        assertFalse(model.saving)
    }

    @Test
    fun `toggle of an absent role creates its row`() = runTest {
        val model = PermissionsMatrixModel(fetch = { start }, save = { it })
        model.load()
        model.toggle("kid", "reward.approve")
        assertEquals(true, model.matrix?.get("kid")?.get("reward.approve"))
    }

    @Test
    fun `failed save reverts the whole matrix`() = runTest {
        val model = PermissionsMatrixModel(fetch = { start }, save = { error("offline") })
        model.load()
        model.toggle("teen", "chore.manage")
        assertEquals(start, model.matrix)
        assertFalse(model.saving)
    }
}
