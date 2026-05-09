/**
 * Synthetic compatibility meta block for local UI state. The v5 ecosystem
 * protocol itself uses the shared WebSocket envelope (no meta on the wire).
 */
export interface ApiMeta {
  requestId: string;
  correlationId: string;
  apiVersion: string;
  servedAt: string;
}
