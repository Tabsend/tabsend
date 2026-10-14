package io.tabsend.app.receive

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import android.util.Log
import io.tabsend.app.logic.Inbox
import io.tabsend.app.store.Store

/**
 * Invisible launcher behind every received-link tap: one link's notification,
 * and the batch summary's "Open all".
 *
 * A notification action can reliably start ONE activity on modern Android
 * (broadcast/service trampolines that then start activities are banned since
 * 12), so this activity is that one: it comes to the foreground, fans out a VIEW
 * intent per URL to the default browser, and finishes. Foreground apps may start
 * activities freely, so the fan-out itself is unrestricted.
 *
 * It also carries the message ids, which is why single links now come through
 * here too rather than through a direct VIEW PendingIntent: Android gives an app
 * no callback when a notification opens a URL itself, so this trampoline is the
 * only place that can record that the user actually opened the tab [P-7].
 */
class OpenLinksActivity : Activity() {

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val urls = intent.getStringArrayListExtra(EXTRA_URLS).orEmpty()
        val ids = intent.getStringArrayListExtra(EXTRA_MESSAGE_IDS).orEmpty()

        for (url in urls) {
            // Re-check the scheme HERE as well as at post time: this is the step
            // that turns a stored string back into a navigation, and the check
            // that makes that safe belongs next to it.
            if (!LinkPolicy.isOpenableWebUrl(url)) continue
            try {
                startActivity(
                    Intent(Intent.ACTION_VIEW, Uri.parse(url)).apply {
                        addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                    },
                )
            } catch (_: ActivityNotFoundException) {
                // No browser for this URL; skip it, keep opening the rest.
            }
        }

        // A tap on a tab's notification is one of the moments Android lets an app start its
        // instant-delivery service, so a fallback decided in the background takes effect
        // here [G10]. After the links are away; never in their way.
        try {
            StreamService.sync(this)
        } catch (e: Exception) {
            Log.w("Tabsend", "could not settle instant delivery: ${e.message}")
        }

        // Bookkeeping strictly AFTER the links are away, in its own guard: opening
        // the tab is the job, and a storage failure must never be able to stop it.
        if (ids.isNotEmpty()) {
            try {
                Store.get(this).updateInbox { list ->
                    Inbox.markOpened(list, ids, System.currentTimeMillis())
                }
            } catch (e: Exception) {
                Log.w("Tabsend", "could not mark received tabs opened: ${e.message}")
            }
        }

        finish()
    }

    companion object {
        const val EXTRA_URLS = "urls"

        /** Relay message ids matching [EXTRA_URLS], so the inbox can mark them opened. */
        const val EXTRA_MESSAGE_IDS = "messageIds"
    }
}
