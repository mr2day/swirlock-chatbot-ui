/**
 * v3 envelope `meta` block, present on every orchestrator response and on
 * every WebSocket event. See
 * `swirlock-chatbot-contracts/docs/versions/v3/API_CONVENTIONS.md`.
 */
export interface ApiMeta {
  requestId: string;
  correlationId: string;
  apiVersion: string;
  servedAt: string;
}
