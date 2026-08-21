package app.waffled.core.model

import kotlinx.serialization.json.Json
import kotlin.test.Test
import kotlin.test.assertEquals

/**
 * `Person` arrives in TWO different shapes and must decode both.
 *
 *  - **PowerSync rows** use the database's snake_case columns (`color_hex`).
 *  - **The REST API** emits camelCase (`colorHex`) — `persons.ts:23` maps one to the
 *    other on the way out.
 *
 * Handling only one is a silent failure, not an error: the field decodes as null, every
 * avatar goes grey, and nothing anywhere reports a problem. A feature agent hit exactly
 * this and had to write a parallel DTO to work around it.
 */
class PersonWireFormatTest {

    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; isLenient = true }

    @Test
    fun decodesTheSnakeCaseShapeFromSyncedRows() {
        val p = json.decodeFromString(
            Person.serializer(),
            """{"id":"p1","name":"Jerry","household_id":"h1","color_hex":"#2F7FED",
                "avatar_emoji":"😎","member_type":"adult","sort_order":1}""",
        )
        assertEquals("#2F7FED", p.colorHex)
        assertEquals("😎", p.avatarEmoji)
        assertEquals("h1", p.householdId)
        assertEquals("adult", p.memberType)
        assertEquals(1, p.sortOrder)
    }

    @Test
    fun decodesTheCamelCaseShapeFromTheRestApi() {
        val p = json.decodeFromString(
            Person.serializer(),
            """{"id":"p1","name":"Jerry","householdId":"h1","colorHex":"#2F7FED",
                "avatarEmoji":"😎","memberType":"adult","sortOrder":1,"isAdmin":true}""",
        )
        assertEquals("#2F7FED", p.colorHex, "REST camelCase must not decode to null")
        assertEquals("😎", p.avatarEmoji)
        assertEquals("h1", p.householdId)
        assertEquals("adult", p.memberType)
        assertEquals(1, p.sortOrder)
        assertEquals(true, p.isAdmin)
    }

    @Test
    fun householdDecodesBothShapesToo() {
        val snake = json.decodeFromString(
            Household.serializer(),
            """{"id":"h1","name":"The Seinfelds","week_start":"monday"}""",
        )
        val camel = json.decodeFromString(
            Household.serializer(),
            """{"id":"h1","name":"The Seinfelds","weekStart":"monday"}""",
        )
        assertEquals("monday", snake.weekStart)
        assertEquals("monday", camel.weekStart)
    }
}
