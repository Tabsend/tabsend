/**
 * What one ring came back as, shared by both providers.
 *
 * Apple and Google are reached over different protocols with different error vocabularies,
 * but the forwarder only ever acts on three questions: did it go, is this doorbell address
 * dead, and what should the operator read in the log. One shape for both keeps `ring` in
 * `app.ts` provider-agnostic, which is what lets a second provider be additive rather than
 * a fork of the wake path.
 */
export type WakeOutcome =
  | { ok: true }
  /**
   * `deviceGone` means the provider PROVED this address rings nothing any more, so the
   * caller drops the row. Each provider decides that from its own answers, and both are
   * deliberately strict about it: a row kept in error is one stale address, while a row
   * deleted in error costs the user every wake until they re-pair, silently.
   */
  | { ok: false; deviceGone: boolean; status: number; reason: string }
