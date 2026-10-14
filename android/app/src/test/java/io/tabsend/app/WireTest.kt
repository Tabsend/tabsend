package io.tabsend.app

import io.tabsend.app.wire.BatchInfo
import io.tabsend.app.wire.GroupKeyDelivery
import io.tabsend.app.wire.GroupKeyRecord
import io.tabsend.app.wire.HistoryEntry
import io.tabsend.app.wire.SendPayload
import io.tabsend.app.wire.SendResponse
import io.tabsend.app.wire.WireJson
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * SendPayload parsing against the shapes `shared/src/types.ts` puts on the wire.
 * The optional fields (`historyOf`, `batch`) must parse when present, default to
 * null when absent (old senders), and unknown future fields must be ignored —
 * the tolerance the whole wire layer promises (see WireJson).
 */
class WireTest {

    /**
     * `SendResponse.rejected[].limit` [0030] rides with `limit_reached` and names
     * which per-group cap refused the item. Additive in both directions: a relay
     * that predates it simply omits the field, and this app must read that as an
     * unnamed cap rather than failing to parse the response at all.
     */
    @Test
    fun `a rejection carries the cap that refused it, and survives one without`() {
        val named = """{"accepted":[],"rejected":[{"id":"m-1","reason":"limit_reached",
            "limit":"sends_per_window"}]}""".trimIndent()
        val withLimit = WireJson.decodeFromString(SendResponse.serializer(), named)
        assertEquals("limit_reached", withLimit.rejected.first().reason)
        assertEquals("sends_per_window", withLimit.rejected.first().limit)

        val older = """{"accepted":[],"rejected":[{"id":"m-1","reason":"unknown_target"}]}"""
        assertNull(WireJson.decodeFromString(SendResponse.serializer(), older).rejected.first().limit)
    }

    @Test
    fun `parses a batch payload`() {
        val json = """
            {"url":"https://a.example/1","title":"One","sentAt":"2026-08-03T00:00:00.000Z",
             "batch":{"id":"b-123","count":3}}
        """.trimIndent()
        val payload = WireJson.decodeFromString(SendPayload.serializer(), json)
        assertEquals(BatchInfo(id = "b-123", count = 3), payload.batch)
        assertNull(payload.historyOf)
    }

    @Test
    fun `batch defaults to null when absent (old sender)`() {
        val json = """{"url":"https://a.example/1","sentAt":"2026-08-03T00:00:00.000Z"}"""
        val payload = WireJson.decodeFromString(SendPayload.serializer(), json)
        assertNull(payload.batch)
    }

    @Test
    fun `unknown payload fields are ignored, including inside batch`() {
        val json = """
            {"url":"https://a.example/1","sentAt":"2026-08-03T00:00:00.000Z",
             "batch":{"id":"b-9","count":2,"futureField":true},"somethingNew":"x"}
        """.trimIndent()
        val payload = WireJson.decodeFromString(SendPayload.serializer(), json)
        assertEquals("b-9", payload.batch?.id)
        assertEquals(2, payload.batch?.count)
    }

    @Test
    fun `batch survives an encode-decode round-trip`() {
        val original = SendPayload(
            url = "https://a.example/1",
            title = "One",
            sentAt = "2026-08-03T00:00:00.000Z",
            batch = BatchInfo(id = "b-123", count = 3),
        )
        val encoded = WireJson.encodeToString(SendPayload.serializer(), original)
        assertEquals(original, WireJson.decodeFromString(SendPayload.serializer(), encoded))
    }

    /**
     * A history row exactly as `GET /v1/messages?history=1` writes it [0028]. The
     * relay omits nothing here, but `deliveredAt`/`ackedAt` are the two fields a
     * client reads a verdict out of, so their null form is worth pinning.
     */
    @Test
    fun `parses a history row, nulls and all`() {
        val json = """
            {"id":"m-1","sourceEndpointId":"e-src","targetEndpointId":"e-tgt",
             "createdAt":"2026-08-06T10:00:00.000Z","expiresAt":"2026-08-13T10:00:00.000Z",
             "deliveredAt":null,"ackedAt":null,
             "blob":{"alg":"xsalsa20-poly1305/secretbox","keyId":"k1","nonce":"bm9uY2U=","ciphertext":"Y2lwaGVy"}}
        """.trimIndent()
        val entry = WireJson.decodeFromString(HistoryEntry.serializer(), json)
        assertEquals("m-1", entry.id)
        assertNull(entry.ackedAt)
        assertEquals("k1", entry.blob.keyId)
    }

    @Test
    fun `parses a group key delivery, and the record it seals`() {
        val json = """
            {"id":"gk-1","sourceEndpointId":"e-src","createdAt":"2026-08-06T10:00:00.000Z",
             "envelope":{"alg":"x25519-xsalsa20-poly1305/box","senderKeyId":"s","targetKeyId":"t",
                         "nonce":"bm9uY2U=","ciphertext":"Y2lwaGVy"}}
        """.trimIndent()
        val delivery = WireJson.decodeFromString(GroupKeyDelivery.serializer(), json)
        assertEquals("e-src", delivery.sourceEndpointId)
        assertEquals("s", delivery.envelope.senderKeyId)

        val record = WireJson.decodeFromString(
            GroupKeyRecord.serializer(),
            """{"key":"a2V5","keyId":"k1","createdAt":"2026-08-06T10:00:00.000Z"}""",
        )
        assertEquals("k1", record.keyId)
    }
}
