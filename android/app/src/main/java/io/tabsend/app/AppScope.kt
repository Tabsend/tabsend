package io.tabsend.app

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob

/**
 * Process-lifetime coroutine scope, for work that must outlive the screen that
 * started it.
 *
 * The share sheet is the reason this exists. It is a transient, translucent
 * activity sitting on top of a frozen browser, so it has to go away the instant
 * the user picks a target — but the send it starts takes a network round trip.
 * On [androidx.lifecycle.lifecycleScope] that work is cancelled by `finish()`,
 * which forces the activity to stay on screen for the whole POST. Here it isn't.
 *
 * [Dispatchers.Main.immediate] to match `lifecycleScope`, so a body moved over
 * from one keeps running on the thread it already assumed (the outcome toast
 * needs it, and the send itself switches to IO on its own). [SupervisorJob] so
 * one failed send can't cancel the scope for every later one.
 *
 * Nothing durable rides on this scope: [io.tabsend.app.send.Sender] queues an
 * item BEFORE it POSTs and only dequeues on a definite answer, so a process
 * death mid-send loses nothing — the drain/heartbeat workers pick it up.
 */
object AppScope : CoroutineScope by CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
