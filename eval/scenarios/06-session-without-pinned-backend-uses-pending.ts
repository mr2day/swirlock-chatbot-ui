import { ChatUiState } from '../../src/app/core/state/chat-ui-state.service';
import { BACKENDS_FIXTURE } from '../lib/backends-fixture';
import { equal, type AssertionResult } from '../lib/assertions';

export default {
  // Legacy session rows or sessions created with no defaultBackend
  // present `activeSessionBackend === null`. The resolution chain
  // must skip over that null and fall through to pending, then to
  // the runtime default — not return null itself.
  name: 'active session with null pinned backend falls through to pending',
  run(): AssertionResult[] {
    const state = new ChatUiState();
    state.setDiscovery(BACKENDS_FIXTURE, 'mistral-online');
    state.setPendingBackend('anthropic');
    state.setActiveSession('s-legacy', null);

    return [
      equal(state.hasActiveSession(), true, 'session is active'),
      equal(state.activeSessionBackend(), null, 'session has no pinned backend'),
      equal(state.effectiveBackend(), 'anthropic', 'falls through to pending'),
    ];
  },
};
