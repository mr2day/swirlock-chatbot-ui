import { Injectable } from '@angular/core';
import type { UserLocation } from '../models/chat.model';

const STORAGE_KEY = 'swirlock.location.permission';
type StoredPermission = 'granted' | 'denied';

@Injectable({ providedIn: 'root' })
export class LocationService {
  getStoredPermission(): StoredPermission | null {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      if (value === 'granted' || value === 'denied') return value;
      return null;
    } catch {
      return null;
    }
  }

  setStoredPermission(value: StoredPermission): void {
    try {
      localStorage.setItem(STORAGE_KEY, value);
    } catch {
      // localStorage unavailable (private mode, etc) — nothing to do.
    }
  }

  clearStoredPermission(): void {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      // no-op
    }
  }

  /**
   * Reads the current physical location via the browser geolocation API.
   * The browser may show its own permission prompt on first use.
   */
  fetchCurrentLocation(timeoutMs = 15_000): Promise<UserLocation | null> {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      return Promise.resolve(null);
    }

    return new Promise<UserLocation | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (position) => {
          resolve({
            latitude: position.coords.latitude,
            longitude: position.coords.longitude,
            ...(typeof position.coords.accuracy === 'number'
              ? { accuracyMeters: position.coords.accuracy }
              : {}),
            capturedAt: new Date(position.timestamp).toISOString(),
          });
        },
        () => resolve(null),
        {
          enableHighAccuracy: false,
          timeout: timeoutMs,
          maximumAge: 60_000,
        },
      );
    });
  }
}
