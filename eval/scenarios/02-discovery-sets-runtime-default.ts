import { ChatUiState } from '../../src/app/core/state/chat-ui-state.service';
import { BACKENDS_FIXTURE } from '../lib/backends-fixture';
import { equal, type AssertionResult } from '../lib/assertions';

export default {
  name: 'discovery alone sets the effective backend to the runtime default',
  run(): AssertionResult[] {
    const state = new ChatUiState();
    state.setDiscovery(BACKENDS_FIXTURE, 'mistral-online');
    return [
      equal(state.effectiveBackend(), 'mistral-online', 'effectiveBackend = runtime default'),
      equal(state.availableBackends().length, 3, '3 backends available'),
      equal(state.hasActiveSession(), false, 'no active session yet'),
    ];
  },
};
