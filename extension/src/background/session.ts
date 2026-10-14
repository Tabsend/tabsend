import type { Identity, Registration } from '../lib/model'
import { getIdentity, getRegistration } from '../lib/storage'
import { NOT_REGISTERED_ERROR } from '../lib/strings'

export interface Session {
  registration: Registration
  identity: Identity
}

/** The current session, or null if this install hasn't registered yet. */
export async function currentSession(): Promise<Session | null> {
  const [registration, identity] = await Promise.all([getRegistration(), getIdentity()])
  if (!registration || !identity) return null
  return { registration, identity }
}

/** Like currentSession but throws — for paths that require registration. */
export async function requireSession(): Promise<Session> {
  const session = await currentSession()
  if (!session) throw new Error(NOT_REGISTERED_ERROR)
  return session
}
