package io.tabsend.app.logic

import io.tabsend.app.wire.GroupServiceState
import java.time.Instant
import java.time.ZoneId
import java.util.Locale

/**
 * What Tabsend's own service has told this phone's group about its plan [PLANS.md P-19]: the
 * free trial and when it ends, the trial ended, or just "an account".
 *
 * The words come from the relay (`GET /v1/group`, field `service`), which the account site
 * writes when a trial starts, a plan changes or a group is paused. A relay with no account site
 * (every self-hosted one) sends nothing, and then the phone shows no trial line, no notice and
 * no Account group. Nothing is ever worked out from a date or a tap: a guessed "trial ended"
 * would tell a person who just paid that their sending is paused. The iPhone's twin is
 * `GroupService.swift`.
 */
sealed interface ServicePlan {
    /** Sending runs on the free trial. [endsAt] is null only if the relay's date cannot be read. */
    data class Trial(val endsAt: Long?) : ServicePlan

    /** The trial ended and sending is paused for that reason. */
    data object TrialEnded : ServicePlan

    /**
     * An account on the service with nothing to show: paid, lifetime, free time, or paused for
     * another reason (which the send errors already explain).
     */
    data object Account : ServicePlan
}

object GroupService {

    /** A state this build does not know is null, not a guess. */
    fun plan(service: GroupServiceState?): ServicePlan? = when (service?.state) {
        "trial" -> ServicePlan.Trial(service.trialEndsAt?.let(::parseIsoMillis))
        "trial_ended" -> ServicePlan.TrialEnded
        "account" -> ServicePlan.Account
        else -> null
    }

    /**
     * The short day ("Nov 18" in English, "18. Nov." in German), in [zone] (the phone's own) and
     * written the way [locale] writes it (docs/L10N.md, rule 5).
     */
    fun shortDay(
        millis: Long,
        zone: ZoneId = ZoneId.systemDefault(),
        locale: Locale = Locale.getDefault(),
        patterns: DatePatterns = PlatformDatePatterns,
    ): String = patterns.formatter(locale, DateSkeleton.SHORT_DAY).format(Instant.ofEpochMilli(millis).atZone(zone))
}
