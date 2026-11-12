import { GOODBYE_NOTE_MAX, type LeaveResponse } from '@tabsend/shared'
import type { FastifyInstance } from 'fastify'
import type { AppContext } from '../context'
import { fail } from '../errors'
import { hashToken, newId } from '../ids'
import { makeRateLimit } from '../ratelimit'
import { removeEndpoint } from '../removal'
import { iso } from '../time'
import { asObject, reqString } from '../validate'

/**
 * The page a browser opens after the Tabsend extension is uninstalled [PLANS P-31 item 1].
 *
 * The extension set it with `runtime.setUninstallURL`, carrying a leave token in the
 * fragment. Uninstalling wiped the extension's storage, so the device it names is gone
 * for certain: the page removes it on load, with no click, then says so. The fragment
 * never reaches this route or its log; the script reads it and posts it.
 *
 * The optional feedback box appears only on a hosted relay (`TABSEND_PROFILE=hosted`).
 * On a self-hosted relay the note would go to the person who just uninstalled, so there
 * is no box. A note is stored with its time and nothing else.
 *
 * English and German, picked from the browser's language, like the extension. No
 * script, font, image or analytics from anywhere else.
 */
function goodbyePage(withNote: boolean): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Tabsend</title>
  <style>
    :root { color-scheme: light dark; font: 16px/1.5 system-ui, sans-serif; }
    body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #f5f4ef; color: #18201b; }
    main { box-sizing: border-box; width: min(92vw, 34rem); padding: 2rem; border: 1px solid #d7d4c9; border-radius: 1rem; background: #fff; box-shadow: 0 1rem 3rem #15201818; }
    h1 { margin: 0 0 .75rem; font-size: 1.6rem; line-height: 1.2; }
    p { margin: .7rem 0; }
    .muted { color: #59635d; }
    label { display: block; margin-top: 1.4rem; font-weight: 600; }
    textarea { box-sizing: border-box; width: 100%; min-height: 6rem; margin: .5rem 0; padding: .6rem; border: 1px solid #d7d4c9; border-radius: .6rem; font: inherit; background: transparent; color: inherit; }
    button { border: 0; border-radius: .6rem; padding: .6rem 1rem; font: inherit; font-weight: 650; cursor: pointer; background: #1f6f50; color: white; }
    button:disabled { opacity: .6; cursor: default; }
    a { color: #176344; }
    #noteStatus { min-height: 1.5em; color: #176344; }
    footer { margin-top: 1.4rem; padding-top: 1rem; border-top: 1px solid #d7d4c9; font-size: .875rem; }
    footer a { margin-right: .9rem; text-decoration: none; }
    @media (prefers-color-scheme: dark) {
      body { background: #111512; color: #edf2ee; }
      main { background: #1b211d; border-color: #39423c; box-shadow: none; }
      .muted { color: #aeb9b1; }
      a, #noteStatus { color: #8bd6b2; }
      textarea, footer { border-color: #39423c; }
    }
  </style>
</head>
<body>
  <main>
    <h1 id="title"></h1>
    <p id="body" class="muted"></p>
    <form id="noteForm" hidden>
      <label for="note" id="noteLabel"></label>
      <textarea id="note" maxlength="${GOODBYE_NOTE_MAX}"></textarea>
      <button id="send" type="submit"></button>
      <p id="noteStatus" role="status"></p>
    </form>
    <footer aria-label="Tabsend website">
      <a href="https://tabsend.org">tabsend.org</a>
      <a id="support" href="https://tabsend.org/support"></a>
    </footer>
  </main>
  <script>
    const WITH_NOTE = ${withNote ? 'true' : 'false'}
    const TEXT = {
      en: {
        working: 'Removing this browser from your devices',
        workingBody: 'One moment.',
        removed: (name) => name + ' was removed from your devices',
        removedNoName: 'This browser was removed from your devices',
        removedBody: 'Your other devices won\\u2019t send links to it any more. To use Tabsend here again, install it and pair it.',
        noToken: 'Tabsend was uninstalled',
        noTokenBody: 'If this browser is still in your device list, remove it there from one of your other devices, so they stop sending links to it.',
        failed: 'Tabsend could not remove this browser',
        failedBody: 'Your relay did not answer, so this browser may still be in your device list. Remove it there from one of your other devices, so they stop sending links to it.',
        noteLabel: 'Why did you remove Tabsend? (optional)',
        send: 'Send feedback',
        sent: 'Thank you for telling us.',
        notSent: 'That did not go through. Please try again later.',
        support: 'Support',
      },
      de: {
        working: 'Dieser Browser wird aus deinen Ger\\u00e4ten entfernt',
        workingBody: 'Einen Moment.',
        removed: (name) => name + ' wurde aus deinen Ger\\u00e4ten entfernt',
        removedNoName: 'Dieser Browser wurde aus deinen Ger\\u00e4ten entfernt',
        removedBody: 'Deine anderen Ger\\u00e4te senden keine Links mehr dorthin. Um Tabsend hier wieder zu nutzen, installiere es und kopple es neu.',
        noToken: 'Tabsend wurde deinstalliert',
        noTokenBody: 'Falls dieser Browser noch in deiner Ger\\u00e4teliste steht, entferne ihn dort auf einem deiner anderen Ger\\u00e4te, damit sie keine Links mehr dorthin senden.',
        failed: 'Tabsend konnte diesen Browser nicht entfernen',
        failedBody: 'Dein Relay hat nicht geantwortet, darum steht dieser Browser vielleicht noch in deiner Ger\\u00e4teliste. Entferne ihn dort auf einem deiner anderen Ger\\u00e4te, damit sie keine Links mehr dorthin senden.',
        noteLabel: 'Warum hast du Tabsend entfernt? (optional)',
        send: 'Feedback senden',
        sent: 'Danke, dass du es uns sagst.',
        notSent: 'Das hat nicht geklappt. Bitte versuche es sp\\u00e4ter noch einmal.',
        support: 'Hilfe',
      },
    }
    const lang = (navigator.language || 'en').toLowerCase().startsWith('de') ? 'de' : 'en'
    const t = TEXT[lang]
    document.documentElement.lang = lang
    const $ = (id) => document.getElementById(id)
    $('support').textContent = t.support
    function show(title, body) {
      $('title').textContent = title
      $('body').textContent = body
      document.title = title
    }
    // The token is in the fragment, which browsers never send to the relay. Clear it from
    // the address bar once read, so a reload or a copied address does not carry it.
    const token = new URLSearchParams(location.hash.slice(1)).get('t')
    // The relay's own address, so a relay served under a path still finds its routes.
    const base = location.pathname.replace(/goodbye$/, '')
    history.replaceState(null, '', location.pathname)
    async function leave() {
      if (!token) return show(t.noToken, t.noTokenBody)
      show(t.working, t.workingBody)
      try {
        const res = await fetch(base + 'v1/endpoints/leave', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ leaveToken: token }),
        })
        if (!res.ok) return show(t.failed, t.failedBody)
        const answer = await res.json()
        show(answer.label ? t.removed(answer.label) : t.removedNoName, t.removedBody)
      } catch {
        show(t.failed, t.failedBody)
      }
    }
    leave()
    if (WITH_NOTE) {
      $('noteForm').hidden = false
      $('noteLabel').textContent = t.noteLabel
      $('send').textContent = t.send
      $('noteForm').addEventListener('submit', async (event) => {
        event.preventDefault()
        const note = $('note').value.trim()
        if (!note) return
        $('send').disabled = true
        try {
          const res = await fetch(base + 'goodbye/note', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ note }),
          })
          if (!res.ok) throw new Error(String(res.status))
          $('noteStatus').textContent = t.sent
          $('note').disabled = true
        } catch {
          $('noteStatus').textContent = t.notSent
          $('send').disabled = false
        }
      })
    }
  </script>
</body>
</html>`
}

export function registerGoodbyeRoutes(app: FastifyInstance, ctx: AppContext): void {
  const rateLimit = makeRateLimit(ctx.rateLimiter)
  const withNote = ctx.config.profile === 'hosted'
  const page = goodbyePage(withNote)

  app.get('/goodbye', async (_request, reply) => {
    reply
      .header('Cache-Control', 'no-store')
      .header('Referrer-Policy', 'no-referrer')
      .header('X-Content-Type-Options', 'nosniff')
      .type('text/html; charset=utf-8')
      .send(page)
  })

  // POST /v1/endpoints/leave — remove the endpoint a leave token names. No auth: the
  // token is the authority, and it can do nothing else. Idempotent: a token that names
  // nothing (already removed, or replaced) answers `removed: false`, not an error, so a
  // reloaded page says the same thing twice.
  app.post('/v1/endpoints/leave', { preHandler: rateLimit }, async (request) => {
    const leaveToken = reqString(asObject(request.body), 'leaveToken')
    const hash = hashToken(leaveToken)
    const target = await ctx.db
      .selectFrom('endpoints')
      .select(['id', 'group_id'])
      .where('leave_token_hash', '=', hash)
      .executeTakeFirst()
    const none: LeaveResponse = { removed: false }
    if (!target) return none
    // Read again under the group's hold: the token must still name this endpoint when the
    // removal runs, not only when it was looked up.
    const removed = await removeEndpoint(
      ctx,
      target.group_id,
      (trx) =>
        trx
          .selectFrom('endpoints')
          .selectAll()
          .where('id', '=', target.id)
          .where('leave_token_hash', '=', hash)
          .executeTakeFirst(),
      request.log,
    )
    if (!removed) return none
    request.log.info({ endpointId: removed.id }, 'endpoint left with its leave token')
    const response: LeaveResponse = { removed: true, label: removed.label }
    return response
  })

  // POST /goodbye/note — the optional feedback box, hosted only (see the page above).
  app.post('/goodbye/note', { preHandler: rateLimit }, async (request, reply) => {
    if (!withNote) fail('not_found', 'This relay does not take feedback notes.')
    const note = reqString(asObject(request.body), 'note').trim()
    if (note.length === 0 || note.length > GOODBYE_NOTE_MAX) {
      fail('invalid_request', `A note holds 1 to ${GOODBYE_NOTE_MAX} characters.`)
    }
    await ctx.db
      .insertInto('goodbye_notes')
      .values({ id: newId(), note, created_at: iso(ctx.now()) })
      .execute()
    reply.code(201).send({ ok: true })
  })
}
