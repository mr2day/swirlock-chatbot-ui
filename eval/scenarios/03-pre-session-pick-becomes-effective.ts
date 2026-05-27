import { ChatUiState } from '../../src/app/core/state/chat-ui-state.service';
import { BACKENDS_FIXTURE } from '../lib/backends-fixture';
import { equal, type AssertionResult } from '../lib/assertions';

export default {
  // This is the exact case Nick caught: pick a backend on the landing
  // page (no active session), and the picker has to honour it. Before
  // the ChatUiState refactor, the pick was silently swallowed.
  name: 'user picks backend pre-session — effectiveBackend becomes the pick',
  run(): AssertionResult[] {
    const state = new ChatUiState();
    state.setDiscovery(BACKENDS_FIXTURE, 'mistral-online');

    // User clicks 'anthropic' in the sidebar with no active session.
    state.setPendingBackend('anthropic');

    return [
      equal(state.effectiveBackend(), 'anthropic', 'effective backend = pending pick'),
      equal(state.hasActiveSession(), false, 'still no active session'),
      equal(state.pendingBackend(), 'anthropic', 'pending backend recorded'),
    ];
  },
};
