import { Injectable, signal } from '@angular/core';

const MOBILE_BREAKPOINT_PX = 768;

/**
 * Tracks layout-level UI state that doesn't belong in any one component:
 * whether the sidebar is currently open (mobile drawer) and whether the
 * viewport is below the mobile breakpoint.
 *
 * On desktop the sidebar is always visible regardless of `sidebarOpen`,
 * thanks to the CSS in `main-layout.scss`. The `sidebarOpen` signal only
 * matters on mobile, where it controls the slide-in/out drawer.
 */
@Injectable({ providedIn: 'root' })
export class LayoutService {
  private readonly _sidebarOpen = signal<boolean>(this.computeInitialSidebar());
  private readonly _isMobile = signal<boolean>(this.computeIsMobile());

  readonly sidebarOpen = this._sidebarOpen.asReadonly();
  readonly isMobile = this._isMobile.asReadonly();

  constructor() {
    if (typeof window !== 'undefined') {
      window.addEventListener('resize', () => {
        const mobile = this.computeIsMobile();
        this._isMobile.set(mobile);
        // When growing into desktop, force-open. When shrinking into
        // mobile, force-close so the drawer doesn't cover the chat.
        this._sidebarOpen.set(!mobile);
      });
    }
  }

  toggleSidebar(): void {
    this._sidebarOpen.update((v) => !v);
  }

  openSidebar(): void {
    this._sidebarOpen.set(true);
  }

  closeSidebar(): void {
    this._sidebarOpen.set(false);
  }

  /**
   * On mobile only, close the sidebar after a navigation tap so the
   * newly-opened chat fills the screen. No-op on desktop.
   */
  closeSidebarOnMobileNav(): void {
    if (this._isMobile()) this._sidebarOpen.set(false);
  }

  private computeIsMobile(): boolean {
    if (typeof window === 'undefined') return false;
    return window.innerWidth < MOBILE_BREAKPOINT_PX;
  }

  private computeInitialSidebar(): boolean {
    return !this.computeIsMobile();
  }
}
