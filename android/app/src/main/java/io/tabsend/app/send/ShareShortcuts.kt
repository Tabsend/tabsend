package io.tabsend.app.send

import android.content.Context
import android.content.Intent
import androidx.core.content.pm.ShortcutInfoCompat
import androidx.core.content.pm.ShortcutManagerCompat
import androidx.core.graphics.drawable.IconCompat
import io.tabsend.app.R
import io.tabsend.app.logic.Chooser
import io.tabsend.app.logic.ShortcutPlan
import io.tabsend.app.logic.ShortcutTarget
import io.tabsend.app.store.Store
import io.tabsend.app.ui.MainActivity
import io.tabsend.app.wire.Endpoint

/**
 * Publishes one Sharing Shortcut per paired device, so `Reddit → Teilen per… →
 * MacBook Pro` lands in one tap instead of three (INTERACTION_FLOWS §2.6).
 *
 * These are ordinary dynamic shortcuts tagged with [CATEGORY_SEND_TARGET], which
 * `res/xml/shortcuts.xml` binds to [ShareActivity]'s `text/plain` share target.
 * Picking one delivers the same ACTION_SEND intent as the plain sheet entry, plus
 * the shortcut id — [ShareActivity] reads that and skips its own chooser dialog.
 * The send path underneath is untouched.
 *
 * Nothing here reaches the network or the relay: the device list is already on
 * the phone, and the shortcut carries only a label the user chose themselves.
 */
object ShareShortcuts {

    /** Matches the `<category>` in `res/xml/shortcuts.xml`. */
    const val CATEGORY_SEND_TARGET = "io.tabsend.app.category.SEND_TARGET"

    /**
     * Republish the shortcut set from a freshly-known device list.
     *
     * Called from every place that already refreshes endpoints (home screen,
     * share sheet, delivery drain), so the row tracks pairings, renames and MRU
     * order without a job of its own.
     *
     * Writes are skipped when the published set already matches. That is not just
     * an optimisation: the framework rate-limits shortcut updates from a
     * backgrounded app, and the drain path runs in the background on every
     * incoming tab — spending the quota on identical writes would leave a real
     * change (a device just renamed) silently dropped.
     */
    fun sync(context: Context, endpoints: List<Endpoint>) {
        val app = context.applicationContext
        val store = Store.get(app)
        val reg = store.registration ?: return clear(app)

        val rows = Chooser.build(endpoints, reg.endpointId, store.sourcePrefs, System.currentTimeMillis())
        val max = minOf(
            ShortcutPlan.MAX_TARGETS,
            ShortcutManagerCompat.getMaxShortcutCountPerActivity(app),
        )
        val plan = ShortcutPlan.build(rows, max)

        // Shortcut APIs throw on a handful of vendor/launcher edge cases (and
        // ShortcutManager is absent outright on some minimal images). A missing
        // shortcut is a lost convenience; a crash here would take down the screen
        // that called us, including the share sheet mid-send.
        try {
            val published = ShortcutManagerCompat.getDynamicShortcuts(app)
            val current = published
                .sortedBy { it.rank }
                .map { Triple(it.id, it.shortLabel.toString(), it.rank) }
            val wanted = plan.map { Triple(ShortcutPlan.shortcutIdFor(it.endpointId), it.label, it.rank) }
            if (current == wanted) return

            // Endpoints that left the group (or went stale) are removed as
            // long-lived, not merely dropped from the dynamic set: the system
            // keeps caching a long-lived shortcut for ranking after it stops
            // being published, so an unpaired laptop would otherwise linger in
            // the share sheet with nothing behind it.
            val keep = wanted.map { it.first }.toSet()
            val gone = published.map { it.id }.filterNot { it in keep }
            if (gone.isNotEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(app, gone)

            ShortcutManagerCompat.setDynamicShortcuts(app, plan.map { build(app, it) })
        } catch (e: Exception) {
            // Best-effort surface: the full share sheet entry still works.
        }
    }

    /** Republish from the last-known device list (post-send, so MRU order lands). */
    fun sync(context: Context) = sync(context, Store.get(context).cachedEndpoints)

    /**
     * Tell the system a target was actually used, so frequently-used devices
     * float up the Direct Share row. Ranking is the platform's to decide; this is
     * the only signal we get to feed it.
     *
     * Only counts against a shortcut the system currently knows, so callers must
     * [sync] before reporting — a report against an unpublished id is dropped.
     * History is keyed on the shortcut id, which is built from the relay's
     * endpoint id: renaming a device therefore keeps its accumulated ranking, and
     * only unpairing (a new endpoint id, plus the purge in [clear]) resets it.
     */
    fun reportUsed(context: Context, endpointId: String) {
        try {
            ShortcutManagerCompat.reportShortcutUsed(
                context.applicationContext,
                ShortcutPlan.shortcutIdFor(endpointId),
            )
        } catch (e: Exception) {
            // Ranking hint only — never worth failing a send that already landed.
        }
    }

    /** Unpair: the group is gone, so no device may keep a slot in the share sheet. */
    fun clear(context: Context) {
        val app = context.applicationContext
        try {
            val ids = ShortcutManagerCompat.getDynamicShortcuts(app).map { it.id }
            if (ids.isNotEmpty()) ShortcutManagerCompat.removeLongLivedShortcuts(app, ids)
            ShortcutManagerCompat.removeAllDynamicShortcuts(app)
        } catch (e: Exception) {
            // Nothing left to report to; the app is being torn down anyway.
        }
    }

    private fun build(context: Context, target: ShortcutTarget): ShortcutInfoCompat =
        ShortcutInfoCompat.Builder(context, ShortcutPlan.shortcutIdFor(target.endpointId))
            .setShortLabel(target.label)
            .setLongLabel("Send to ${target.label}")
            .setIcon(IconCompat.createWithResource(context, iconFor(target.kind)))
            .setCategories(setOf(CATEGORY_SEND_TARGET))
            // Long-lived so the system may cache and rank it; without this the
            // shortcut is only ever offered in publication order.
            .setLongLived(true)
            .setRank(target.rank)
            // Dynamic shortcuts also appear under a long-press of the app icon,
            // where there is no tab to send — so that launch opens the home
            // screen rather than a share sheet with nothing in it.
            .setIntent(Intent(context, MainActivity::class.java).setAction(Intent.ACTION_MAIN))
            .build()

    private fun iconFor(kind: String): Int =
        if (kind == "mobile") R.drawable.ic_shortcut_mobile else R.drawable.ic_shortcut_browser
}
