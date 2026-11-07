// One car-mode DRIVE: what survives a swipe to another agent and resets when car mode is entered.
//
// The pane screen remounts on every pane switch (routes/detail.tsx keys AgentChat by address), so a
// swipe would otherwise drop car mode, Autoplay, speed and the lineup's order. They live here, in the
// page, for the length of the drive. Nothing is stored: Autoplay starts off on every entry.

export interface CarSession {
  open: boolean;
  autoplay: boolean;
  speed: number;
  /** The swipe's order, as pane row keys (lib/car-lineup.ts). */
  lineup: string[];
}

export const carSession: CarSession = { open: false, autoplay: false, speed: 1, lineup: [] };

/** Enter car mode from the pane's actions: a fresh drive. */
export function enterCar(): void {
  carSession.open = true;
  carSession.autoplay = false;
  carSession.lineup = [];
}

export function exitCar(): void {
  carSession.open = false;
}
