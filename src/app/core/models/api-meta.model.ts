/**
 * Synthetic compatibility meta block for local UI state. The v4 ecosystem
 * protocol itself uses the shared WebSocket envelope.
 */
export interface ApiMeta {
  requestId: string;
  correlationId: string;
  apiVersion: string;
  servedAt: string;
}
