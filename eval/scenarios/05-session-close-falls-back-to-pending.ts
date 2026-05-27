import { ChatUiState } from '../../src/app/core/state/chat-ui-state.service';
import { BACKENDS_FIXTURE } from '../lib/backends-fixture';
import { equal, type AssertionResult } from '../lib/assertions';

export default {
  // When a session closes, the picker should show the user's
  // pre-selection again (not the closed session's backend, not the
  // runtime default if there was a pending pick). This was broken
  // before the resolution chain was centralised.
  name: 'closing the active session falls back to pending pre-selection',
  run(): AssertionResult[] {
    const state = new ChatUiState();
    state.setDiscovery(BACKENDS_FIXTURE, 'mistral-online');
    state.setPendingBackend('anthropic');
    state.setActiveSession('s1', 'ollama-local');

    // Sanity: while session is active, session backend wins.
    const midOk =
      state.effectiveBackend() === 'ollama-local';

    // User closes the session (e.g. clicks "New chat" landing).
    state.setActiveSession(null, null);

    return [
      { ok: midOk, message: 'pre-close: session backend was effective ✓' },
      equal(state.effectiveBackend(), 'anthropic', 'post-close: falls back to pending'),
      equal(state.hasActiveSession(), false, 'no active session after close'),
    ];
  },
};
