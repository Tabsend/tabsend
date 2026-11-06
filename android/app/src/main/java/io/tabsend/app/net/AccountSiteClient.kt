package io.tabsend.app.net

import io.tabsend.app.logic.AccountLink
import io.tabsend.app.logic.AccountSite
import io.tabsend.app.logic.Pairing
import io.tabsend.app.logic.parseIsoMillis
import io.tabsend.app.wire.WireJson
import kotlinx.serialization.Serializable
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException
import java.util.concurrent.TimeUnit

/**
 * What the account site hands the app after it used a `/app-start` link [PLANS.md P-19].
 * The iPhone's twin is `AccountHandBack` in `AccountLink.swift`.
 */
data class AccountHandBack(
    /**
     * This use made the account. False for a person who already had one (a new phone), who
     * must not be told a trial has started.
     */
    val created: Boolean,
    /**
     * The group's first setup link, ready for pairing. Null when the group already has a
     * device: this phone is added from a device that is paired.
     */
    val setupLink: String?,
    /** When the trial ends, in epoch milliseconds. Only for a [created] account. */
    val trialEndsAt: Long?,
)

/** Why the account site's answer could not be used. */
class AccountSiteException(val kind: Kind) : IOException(kind.name) {
    enum class Kind {
        /** The link is old or was already used (the site answered 410). */
        LINK_EXPIRED,

        /** The site could not be reached. */
        UNREACHABLE,

        /** The site answered something this app does not understand. */
        UNEXPECTED,
    }
}

/**
 * The one call the app makes to the account site: use a sign-up link (`POST /api/app/redeem`).
 * No cookie, no sign-in: the token in the emailed link is the credential, single use and good
 * for 15 minutes, exactly as when a web page posts it. Blocking: call off the main thread.
 */
class AccountSiteClient(
    private val site: () -> String = { AccountSite.base },
    private val http: OkHttpClient = shared,
) {
    fun redeem(token: String): AccountHandBack {
        if (!AccountLink.isPlausible(token)) throw AccountSiteException(AccountSiteException.Kind.UNEXPECTED)
        val body = WireJson.encodeToString(RedeemRequest.serializer(), RedeemRequest(token)).toRequestBody(JSON)
        val request = try {
            Request.Builder().url("${site().trimEnd('/')}/api/app/redeem").post(body).build()
        } catch (_: IllegalArgumentException) {
            throw AccountSiteException(AccountSiteException.Kind.UNEXPECTED)
        }
        val status: Int
        val text: String
        try {
            http.newCall(request).execute().use { resp ->
                status = resp.code
                text = resp.body?.string().orEmpty()
            }
        } catch (_: IOException) {
            throw AccountSiteException(AccountSiteException.Kind.UNREACHABLE)
        }
        if (status == 410) throw AccountSiteException(AccountSiteException.Kind.LINK_EXPIRED)
        if (status != 200) throw AccountSiteException(AccountSiteException.Kind.UNEXPECTED)
        val answer = try {
            WireJson.decodeFromString(RedeemResponse.serializer(), text)
        } catch (_: Exception) {
            throw AccountSiteException(AccountSiteException.Kind.UNEXPECTED)
        }
        // A setup link the app cannot read is no setup link; say so now, not at the pairing.
        if (answer.setupLink != null && Pairing.parse(answer.setupLink) == null) {
            throw AccountSiteException(AccountSiteException.Kind.UNEXPECTED)
        }
        return AccountHandBack(
            created = answer.created,
            setupLink = answer.setupLink,
            trialEndsAt = answer.trialEndsAt?.let(::parseIsoMillis),
        )
    }

    @Serializable
    private data class RedeemRequest(val token: String)

    @Serializable
    private data class RedeemResponse(
        val created: Boolean,
        val setupLink: String? = null,
        val trialEndsAt: String? = null,
    )

    private companion object {
        val JSON = "application/json; charset=utf-8".toMediaType()
        val shared: OkHttpClient = OkHttpClient.Builder()
            .connectTimeout(15, TimeUnit.SECONDS)
            .readTimeout(20, TimeUnit.SECONDS)
            .build()
    }
}
