import { Injectable, signal } from '@angular/core';

/**
 * Listens for new web-bundle downloads from
 * @capgo/capacitor-updater (native APK only — no-op on web) and
 * exposes them as a "tap to install" prompt the sidebar surfaces.
 *
 * Flow on native:
 *   1. App launches with bundle X. Plugin checks manifest, finds Y > X,
 *      downloads Y in background, fires `updateAvailable`.
 *   2. We catch the event and flip `updateAvailable` true.
 *   3. User taps the sidebar button → applyUpdate() switches the
 *      active bundle to Y and reloads the WebView.
 *
 * On web, the @capgo/capacitor-updater import fails (no native
 * runtime), so the service stays silent and `updateAvailable` never
 * flips — exactly what we want there.
 */
@Injectable({ providedIn: 'root' })
export class LiveUpdateService {
  readonly updateAvailable = signal<boolean>(false);
  readonly availableVersion = signal<string | null>(null);
  private pendingBundleId: string | null = null;
  private listenerWired = false;

  constructor() {
    void this.wireListener();
  }

  async applyUpdate(): Promise<void> {
    if (!this.pendingBundleId) return;
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
      await CapacitorUpdater.set({ id: this.pendingBundleId });
      // Plugin-managed reload — handles the bundle swap + WebView
      // restart. window.location.reload() also works as a fallback
      // but bypasses some plugin housekeeping.
      await CapacitorUpdater.reload();
    } catch (err) {
      // If the plugin reload errored (or doesn't exist on web),
      // fall back to a plain WebView reload. The next cold start
      // path is the safety net.
      console.error('[live-update] apply failed, falling back to location.reload', err);
      window.location.reload();
    }
  }

  private async wireListener(): Promise<void> {
    if (this.listenerWired) return;
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
      // Listener signature: (info: { bundle: { id, version, downloaded, ... } })
      await CapacitorUpdater.addListener(
        'updateAvailable',
        (info: { bundle?: { id?: string; version?: string } }) => {
          const id = info?.bundle?.id;
          const version = info?.bundle?.version ?? null;
          if (!id) return;
          this.pendingBundleId = id;
          this.availableVersion.set(version);
          this.updateAvailable.set(true);
        },
      );
      this.listenerWired = true;
    } catch {
      // Web build — plugin not present. Service stays silent.
    }
  }
}
