package app.waffled.feature.settings

import kotlinx.coroutines.test.runTest
import org.junit.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue

/** Translation of the iOS `StoredProofsModelTests`. */
class StoredProofsModelTest {

    private fun proof(id: String) = SettingsApi.StoredProof(
        instanceId = id,
        choreTitle = "Put away dishes",
        emoji = "dishwasher",
        personName = "Avery",
        proofUrl = "/media/proofs/$id.jpg",
        completedAt = "2026-07-25T12:00:00.000Z",
    )

    @Test
    fun `failed single delete keeps proof and reports failure`() = runTest {
        val item = proof("proof-1")
        var changes = 0
        val model = StoredProofsModel(
            proofs = listOf(item),
            deleteProof = { error("offline") },
            clearProofs = { 0 },
            onChanged = { changes++ },
        )

        val deleted = model.delete(item)

        assertFalse(deleted)
        assertEquals(listOf("proof-1"), model.proofs.map { it.instanceId })
        assertEquals("Couldn’t delete this photo. Check your connection and try again.", model.errorMessage)
        assertFalse(model.busy)
        assertEquals(0, changes)
    }

    @Test
    fun `successful single delete removes proof and notifies parent`() = runTest {
        val first = proof("proof-1")
        val second = proof("proof-2")
        var changes = 0
        val deletedIds = mutableListOf<String>()
        val model = StoredProofsModel(
            proofs = listOf(first, second),
            deleteProof = { deletedIds += it },
            clearProofs = { 0 },
            onChanged = { changes++ },
        )

        val deleted = model.delete(first)

        assertTrue(deleted)
        assertEquals(listOf("proof-1"), deletedIds)
        assertEquals(listOf("proof-2"), model.proofs.map { it.instanceId })
        assertNull(model.errorMessage)
        assertEquals(1, changes)
    }

    @Test
    fun `failed clear all keeps proofs and reports failure`() = runTest {
        var changes = 0
        val model = StoredProofsModel(
            proofs = listOf(proof("proof-1"), proof("proof-2")),
            deleteProof = {},
            clearProofs = { error("offline") },
            onChanged = { changes++ },
        )

        val cleared = model.clearAll()

        assertFalse(cleared)
        assertEquals(listOf("proof-1", "proof-2"), model.proofs.map { it.instanceId })
        assertEquals("Couldn’t clear stored photos. Check your connection and try again.", model.errorMessage)
        assertFalse(model.busy)
        assertEquals(0, changes)
    }

    @Test
    fun `successful clear all removes proofs and notifies parent`() = runTest {
        var changes = 0
        var clearCount = 0
        val model = StoredProofsModel(
            proofs = listOf(proof("proof-1"), proof("proof-2")),
            deleteProof = {},
            clearProofs = { clearCount++; 2 },
            onChanged = { changes++ },
        )

        val cleared = model.clearAll()

        assertTrue(cleared)
        assertEquals(1, clearCount)
        assertTrue(model.proofs.isEmpty())
        assertNull(model.errorMessage)
        assertEquals(1, changes)
    }
}
