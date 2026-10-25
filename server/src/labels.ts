/**
 * Evidence labels. Every value Fieldbook reports says where it came from:
 *
 *  measured  — measured on the device or on the Mac
 *  captured  — a real screenshot taken by the system
 *  rendered  — drawn by the app itself
 *  reported  — the app's own state or words, or the tester's note; not checked
 *  missing   — could not be had; `reason` says why
 *
 * A label is never upgraded: a reported value stays reported, even when it looks right.
 */

export type Label = "measured" | "captured" | "rendered" | "reported" | "missing";

export interface Labeled<T> {
  label: Label;
  value?: T;
  /** For missing values: why. */
  reason?: string;
  /** Where the value came from, for example "devicectl info apps". */
  source?: string;
}

export function measured<T>(value: T, source: string): Labeled<T> {
  return { label: "measured", value, source };
}

export function captured<T>(value: T, source: string): Labeled<T> {
  return { label: "captured", value, source };
}

export function rendered<T>(value: T, source: string): Labeled<T> {
  return { label: "rendered", value, source };
}

export function reported<T>(value: T, source: string): Labeled<T> {
  return { label: "reported", value, source };
}

export function missing<T = never>(reason: string): Labeled<T> {
  return { label: "missing", reason };
}

export function has<T>(labeled: Labeled<T> | undefined): labeled is Labeled<T> & { value: T } {
  return labeled !== undefined && labeled.label !== "missing" && labeled.value !== undefined;
}

/** "412 (measured)" or "missing: the app did not answer". */
export function describe<T>(labeled: Labeled<T> | undefined, format: (value: T) => string = String): string {
  if (!labeled) return "missing";
  if (!has(labeled)) return `missing${labeled.reason ? `: ${labeled.reason}` : ""}`;
  return `${format(labeled.value)} (${labeled.label})`;
}
