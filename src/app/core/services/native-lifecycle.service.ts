import { Injectable } from '@angular/core';

/**
 * Native (Capacitor) UX glue that the regular web build doesn't need:
 *
 * - **Back button**: by default the Capacitor Android shell ignores
 *   the system back gesture, which means a tap of the phone's back
 *   button while on a non-history root page does nothing — the user
 *   has to open the app switcher and swipe the app up to close it.
 *   We wire it to navigate back when history exists, and to exit
 *   the app cleanly when it doesn't.
 * - **Pull-to-refresh**: Capacitor's webview ships without Chrome's
 *   built-in pull-to-refresh. We add a tiny touch listener that
 *   reloads the page when the user drags down from the top of any
 *   already-scrolled-to-top container by more than a threshold.
 *   Reloading the webview also triggers the @capgo/capacitor-updater
 *   apply-pending step, so a downloaded live-update bundle gets
 *   activated on the next pull.
 *
 * Both behaviours are no-ops in the regular web build.
 */
@Injectable({ providedIn: 'root' })
export class NativeLifecycleService {
  private wired = false;

  initIfNative(): void {
    if (this.wired) return;
    if (!this.isNative()) return;
    this.wired = true;
    void this.wireBackButton();
    this.wirePullToRefresh();
  }

  private isNative(): boolean {
    return (
      typeof window !== 'undefined' &&
      (window as unknown as {
        Capacitor?: { isNativePlatform?: () => boolean };
      }).Capacitor?.isNativePlatform?.() === true
    );
  }

  /**
   * Routes the hardware back button. Goes back through router history
   * when possible; exits the app cleanly when there is no history
   * (i.e. we are on the entry route). This matches what users expect
   * from native Android apps and removes the need to use the
   * task-switcher + swipe-up just to close the app.
   */
  private async wireBackButton(): Promise<void> {
    try {
      const { App } = await import('@capacitor/app');
      await App.addListener('backButton', ({ canGoBack }) => {
        if (canGoBack) {
          window.history.back();
        } else {
          void App.exitApp();
        }
      });
    } catch (err) {
      console.warn('[native-lifecycle] back-button wire failed:', err);
    }
  }

  /**
   * Minimal pull-to-refresh. Listens for a touchstart whose nearest
   * scrollable ancestor is at scrollTop === 0, then checks the
   * touchend Y delta. If the user dragged down by more than the
   * threshold without releasing early, the page reloads.
   *
   * The "nearest scrollable ancestor" check means the gesture won't
   * fire when the user is scrolling INSIDE a list that has more
   * content above — only when they're already at the top and try to
   * pull further.
   */
  private wirePullToRefresh(): void {
    const THRESHOLD = 100;
    let startY = 0;
    let pulling = false;

    const startedAtScrollTop = (target: EventTarget | null): boolean => {
      let el = target as HTMLElement | null;
      while (el && el !== document.body && el !== document.documentElement) {
        const style = window.getComputedStyle(el);
        if (style.overflowY === 'auto' || style.overflowY === 'scroll') {
          return el.scrollTop === 0;
        }
        el = el.parentElement;
      }
      return true;
    };

    const onTouchStart = (e: TouchEvent): void => {
      if (!startedAtScrollTop(e.target) || e.touches.length !== 1) {
        pulling = false;
        return;
      }
      startY = e.touches[0].clientY;
      pulling = true;
    };

    const onTouchEnd = (e: TouchEvent): void => {
      if (!pulling) return;
      pulling = false;
      const endY = e.changedTouches[0]?.clientY ?? startY;
      if (endY - startY >= THRESHOLD) {
        window.location.reload();
      }
    };

    document.addEventListener('touchstart', onTouchStart, { passive: true });
    document.addEventListener('touchend', onTouchEnd, { passive: true });
  }
}
