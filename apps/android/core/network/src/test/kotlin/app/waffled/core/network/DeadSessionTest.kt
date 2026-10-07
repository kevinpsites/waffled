package app.waffled.core.network

import io.ktor.client.HttpClient
import io.ktor.client.engine.mock.MockEngine
import io.ktor.client.engine.mock.respond
import io.ktor.client.statement.bodyAsText
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.headersOf
import kotlinx.coroutines.test.runTest
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull

/**
 * Twin of `AuthDeadSessionTests.swift`. A token can outlive its household (a restored
 * database, a deleted household), and the server answers 403 `NoHousehold`. Refreshing
 * mints another token for the same hole, so the session must end — but ONLY on that code:
 * an ordinary permission denial is also a 403, and signing a kid out for lacking
 * `chore.manage` would be worse than the stuck session.
 */
class DeadSessionTest {

    @Test
    fun theMissingHouseholdCodeIsReadOffTheBody() {
        val body = """{"error":"NoHousehold","message":"No household for this account; create one first"}"""
        assertEquals("NoHousehold", ApiErrorText.code(body))
    }

    @Test
    fun anOrdinaryPermissionDenialIsNotTheMissingHouseholdCode() {
        val body = """{"error":"AuthError","message":"You do not have permission to do this"}"""
        assertEquals("AuthError", ApiErrorText.code(body))
    }

    @Test
    fun anUnreadableBodyYieldsNoCode() {
        assertNull(ApiErrorText.code("<html>503</html>"))
        assertNull(ApiErrorText.code(""))
        assertNull(ApiErrorText.code(null))
        assertNull(ApiErrorText.code("""{"error":42}"""))
    }

    private class FakeTokens : TokenProvider {
        var ended = 0
        var refreshes = 0
        override suspend fun accessToken(): String? = "token"
        override suspend fun refreshAccessToken(failedToken: String?): String? {
            refreshes++
            return "fresh"
        }
        override fun sessionEnded() {
            ended++
        }
    }

    private fun client(status: Int, body: String) = HttpClient(
        MockEngine {
            respond(
                body,
                HttpStatusCode.fromValue(status),
                headersOf(HttpHeaders.ContentType, "application/json"),
            )
        },
    ) { expectSuccess = false }

    private suspend fun call(tokens: TokenProvider, status: Int, body: String) =
        WaffledHttp.authorized(client(status, body), tokens, HttpMethod.Get, "http://x/api/chores") {
            it.bodyAsText()
        }

    @Test
    fun aGoneHouseholdEndsTheSessionWithoutRefreshing() = runTest {
        val tokens = FakeTokens()
        val error = assertFailsWith<WaffledApiException> {
            call(tokens, 403, """{"error":"NoHousehold","message":"No household for this account"}""")
        }
        assertEquals(403, error.status)
        assertEquals(1, tokens.ended)
        assertEquals(0, tokens.refreshes)
    }

    @Test
    fun aPermissionDenialDoesNotEndTheSession() = runTest {
        val tokens = FakeTokens()
        assertFailsWith<WaffledApiException> {
            call(tokens, 403, """{"error":"AuthError","message":"You do not have permission to do this"}""")
        }
        assertFailsWith<WaffledApiException> {
            call(tokens, 403, """{"error":"AuthError","message":"The chores module is not enabled"}""")
        }
        assertEquals(0, tokens.ended)
    }

    @Test
    fun aNoHouseholdCodeOnAnotherStatusIsNotADeadSession() = runTest {
        val tokens = FakeTokens()
        assertFailsWith<WaffledApiException> {
            call(tokens, 500, """{"error":"NoHousehold"}""")
        }
        assertEquals(0, tokens.ended)
    }

    @Test
    fun aProviderThatDoesNotCareStillCompiles() = runTest {
        // sessionEnded() has a default so the many test fakes need no change.
        val quiet = object : TokenProvider {
            override suspend fun accessToken(): String? = null
            override suspend fun refreshAccessToken(failedToken: String?): String? = null
        }
        assertFailsWith<WaffledApiException> { call(quiet, 403, """{"error":"NoHousehold"}""") }
    }
}
