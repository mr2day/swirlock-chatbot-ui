import type { BackendDescriptor } from '../../src/app/core/state/chat-ui-state.service';

/**
 * Shared fixture for the three backends the agent currently exposes.
 * Scenarios use this as the discovery payload so they don't each
 * have to redeclare the list.
 */
export const BACKENDS_FIXTURE: readonly BackendDescriptor[] = [
  {
    name: 'anthropic',
    displayName: 'Claude Haiku 4.5',
    modelId: 'claude-haiku-4-5-20251001',
    location: 'cloud',
  },
  {
    name: 'mistral-online',
    displayName: 'Ministral 14B',
    modelId: 'ministral-14b-latest',
    location: 'cloud',
  },
  {
    name: 'ollama-local',
    displayName: 'Ollama (local)',
    modelId: 'qwen3:14b',
    location: 'local',
  },
];
