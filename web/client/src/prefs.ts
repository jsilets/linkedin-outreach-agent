import { useCallback, useState } from 'react';

// Lightweight UI preferences: every filter, sort, and dropdown selection is
// remembered per browser via localStorage, written on each change. Keys are
// namespaced under "loa.pref." and hold JSON. This is presentation state only —
// nothing here is a source of truth, so a cleared store just reverts defaults.

const NS = 'loa.pref.';

export function readPref<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(NS + key);
    if (raw === null) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writePref<T>(key: string, value: T): void {
  try {
    if (value === undefined) localStorage.removeItem(NS + key);
    else localStorage.setItem(NS + key, JSON.stringify(value));
  } catch {
    // Storage full or blocked (private mode): the selection still works, it
    // just won't survive a reload.
  }
}

// useState that hydrates from and persists to localStorage. The setter accepts
// a value or an updater fn, like setState.
export function usePref<T>(key: string, fallback: T): [T, (v: T | ((prev: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readPref(key, fallback));
  const set = useCallback(
    (v: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v;
        writePref(key, next);
        return next;
      });
    },
    [key],
  );
  return [value, set];
}
