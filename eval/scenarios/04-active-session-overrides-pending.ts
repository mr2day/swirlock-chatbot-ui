import { ChatUiState } from '../../src/app/core/state/chat-ui-state.service';
import { BACKENDS_FIXTURE } from '../lib/backends-fixture';
import { equal, type AssertionResult } from '../lib/assertions';

export default {
  // An open session's pinned backend wins over the pre-selection.
  // This is what makes "switch to a different model mid-conversation"
  // do the right thing.
  name: 'active session backend overrides pending pre-selection',
  run(): AssertionResult[] {
    const state = new ChatUiState();
    state.setDiscovery(BACKENDS_FIXTURE, 'mistral-online');

    // User had picked 'anthropic' on the landing page...
    state.setPendingBackend('anthropic');

    // ...then opened (or created) a session pinned to 'ollama-local'.
    state.setActiveSession('s1', 'ollama-local');

    return [
      equal(state.effectiveBackend(), 'ollama-local', 'session backend wins'),
      equal(state.pendingBackend(), 'anthropic', 'pending preserved underneath'),
      equal(state.hasActiveSession(), true, 'session is active'),
    ];
  },
};
