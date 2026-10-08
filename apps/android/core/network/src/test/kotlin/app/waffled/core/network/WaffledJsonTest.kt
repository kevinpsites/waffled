package app.waffled.core.network

import kotlinx.serialization.Serializable
import kotlin.test.Test
import kotlin.test.assertEquals

class WaffledJsonTest {

    @Serializable
    private data class Row(val name: String, val amount: Int = 0)

    @Test fun anExplicitNullFallsBackToTheFieldDefault() {
        // The API sends `null` for unset numbers (e.g. a chore's rewardAmount).
        assertEquals(Row("a", 0), WaffledJson.decodeFromString(Row.serializer(), """{"name":"a","amount":null}"""))
    }
}
