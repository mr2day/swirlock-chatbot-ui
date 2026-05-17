import { Injectable, signal } from '@angular/core';
import { Capacitor } from '@capacitor/core';
import { VERSION } from '../version';

/**
 * Self-hosted Capacitor Live Updates, fully manual.
 *
 * The plugin runs with autoUpdate=false. No silent download, no
 * silent next-launch apply. Everything happens because the user
 * tapped the sidebar button.
 *
 *  - On app start we POST the device's bundle version to the
 *    orchestrator's /updates endpoint via CapacitorUpdater.getLatest()
 *    and decide if a newer bundle exists.
 *  - The sidebar shows the button in both states: disabled with
 *    "You're on the latest version" when up-to-date, enabled with
 *    "Update available" when not.
 *  - On tap we download, set, and reload — synchronously from the
 *    user's perspective: they tap, the WebView reloads with the new
 *    bundle. No "wait, where did the old version go" surprise.
 *
 * On web everything is no-op — the button is hidden via `native`.
 */
@Injectable({ providedIn: 'root' })
export class LiveUpdateService {
  /** True only on the Capacitor native platform. The button is
   *  hidden on web because there's no live-update concept there. */
  readonly native = signal<boolean>(Capacitor.isNativePlatform());

  /** Manifest check is in flight. */
  readonly checking = signal<boolean>(false);

  /** Manifest returned a newer bundle. */
  readonly available = signal<boolean>(false);

  /** Version string of the available bundle, for display. */
  readonly availableVersion = signal<string | null>(null);

  /** Download/apply is in flight (post-tap). */
  readonly applying = signal<boolean>(false);

  private latestUrl: string | null = null;
  private latestVersion: string | null = null;

  constructor() {
    if (this.native()) void this.checkForUpdate();
  }

  /** Quietly asks the orchestrator if a newer bundle exists. No
   *  download. Safe to call repeatedly. */
  async checkForUpdate(): Promise<void> {
    if (!this.native()) return;
    if (this.checking()) return;
    this.checking.set(true);
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
      // getLatest() POSTs to capacitor.config's updateUrl and returns
      // the manifest fields. If the server says no update the shape
      // is { message: 'no update available' } — we treat any missing
      // version/url the same way.
      const latest = (await CapacitorUpdater.getLatest()) as {
        version?: string;
        url?: string;
      };
      const version = latest?.version ?? null;
      const url = latest?.url ?? null;
      if (version && url && this.isNewer(version, VERSION.bundle)) {
        this.latestVersion = version;
        this.latestUrl = url;
        this.availableVersion.set(version);
        this.available.set(true);
      } else {
        this.latestVersion = null;
        this.latestUrl = null;
        this.availableVersion.set(null);
        this.available.set(false);
      }
    } catch (err) {
      console.error('[live-update] check failed', err);
      this.available.set(false);
    } finally {
      this.checking.set(false);
    }
  }

  /** User tapped the button. Download the bundle, set it active,
   *  reload the WebView. The user sees a normal app reload. */
  async applyUpdate(): Promise<void> {
    if (!this.available() || !this.latestUrl || !this.latestVersion) return;
    if (this.applying()) return;
    this.applying.set(true);
    try {
      const { CapacitorUpdater } = await import('@capgo/capacitor-updater');
      const bundle = await CapacitorUpdater.download({
        url: this.latestUrl,
        version: this.latestVersion,
      });
      await CapacitorUpdater.set({ id: bundle.id });
      await CapacitorUpdater.reload();
    } catch (err) {
      console.error('[live-update] apply failed', err);
      this.applying.set(false);
    }
  }

  /** Strict semver-ish compare; we only ship `0.0.<n>` so a numeric
   *  segment-by-segment compare is enough. */
  private isNewer(a: string, b: string): boolean {
    const pa = a.split('.').map((s) => Number.parseInt(s, 10) || 0);
    const pb = b.split('.').map((s) => Number.parseInt(s, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const x = pa[i] ?? 0;
      const y = pb[i] ?? 0;
      if (x > y) return true;
      if (x < y) return false;
    }
    return false;
  }
}
