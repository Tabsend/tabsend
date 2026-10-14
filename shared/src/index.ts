/**
 * Barrel for @tabsend/shared — the single source of truth for Tabsend's wire
 * contracts. Import from here, e.g.:
 *
 *   import type { Endpoint, Message, EncryptedEnvelope, SendRequest } from '@tabsend/shared'
 *   import { DEFAULT_CLIENT_SETTINGS, PAIRING_LINK, API_VERSION } from '@tabsend/shared'
 *
 * See DECISIONS.md (ADR 0001–0009) and INTERACTION_FLOWS.md for the rationale
 * behind every type in here.
 */
export * from './naming';
export * from './types';
export * from './newdevices';
export * from './keyrecord';
