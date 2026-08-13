/**
 * Whole minutes for a duration given in seconds, floored up to at least 1 so
 * callers can say "expires in N minutes" without ever showing "0 minutes".
 */
export function minutesFromSeconds(seconds: number): number {
  return Math.max(1, Math.round(seconds / 60));
}
