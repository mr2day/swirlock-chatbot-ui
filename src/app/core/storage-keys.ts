/**
 * Shared localStorage keys. One file so producer + consumer of each
 * key agree on a single literal, and the dependency direction doesn't
 * have to flow through Angular DI (which would force circular
 * imports between services that share state via storage).
 */

/**
 * Stores the user's preferred backend (e.g. `mistral-online`) when
 * they pick a model in the sidebar before an active session exists.
 * `BackendService` writes it; `SessionService` reads it on
 * `createSession` and passes it as `defaultBackend` so the new
 * session honors the pre-selection.
 */
export const BACKEND_PREFERENCE_KEY = 'swirlock.preferredBackend';
