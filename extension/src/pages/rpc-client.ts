import { ext } from '../lib/ext'
import { t } from '../lib/i18n'
import type { RpcRequest, RpcResponse } from '../lib/model'
import { UserFacingError } from '../lib/relay-errors'

/** Send an RPC to the service worker and await its typed response. */
export function rpc(req: RpcRequest): Promise<RpcResponse> {
  return ext.runtime.sendMessage(req) as Promise<RpcResponse>
}

/** Narrowing helper: throw on `{ok:false}` responses so callers get the payload. */
export async function rpcOk<T extends RpcResponse & { ok: true }>(req: RpcRequest): Promise<T> {
  const res = await rpc(req)
  // Chrome can resolve sendMessage with no payload when the service worker was
  // stopped or failed before replying. Do not leak a JavaScript property-access
  // crash into the connection UI; tell the user the one useful recovery step.
  if (!res || typeof res !== 'object' || !('ok' in res)) {
    throw new UserFacingError(t('chooser.rpc.noResponse'))
  }
  // `res.error` is a sentence the background chose from the catalog (rpc.ts), so it is safe to show.
  if (!res.ok) throw new UserFacingError(res.error)
  return res as T
}
