import { ChatUiState } from '../../src/app/core/state/chat-ui-state.service';
import { equal, type AssertionResult } from '../lib/assertions';

export default {
  name: 'empty state returns null for everything that depends on discovery',
  run(): AssertionResult[] {
    const state = new ChatUiState();
    return [
      equal(state.effectiveBackend(), null, 'effectiveBackend null at boot'),
      equal(state.hasActiveSession(), false, 'no active session at boot'),
      equal(state.runtimeDefault(), null, 'no runtime default at boot'),
      equal(state.availableBackends().length, 0, 'no available backends at boot'),
    ];
  },
};
