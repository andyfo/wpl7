/**
 * The demo's clock stands still at DEMO_NOW. Everything the demo seeds is dated relative to it,
 * so "2 minutes ago", every absolute date and every chart's time axis are the same on every run:
 * the panel works out a chart's window from its own clock, and a clock that ticked would move
 * the axis by however long the run had taken. The shooter pins the browser's clock to the same
 * instant (docs/site/scripts/shoot.ts). Timers still run on real time; the demo starts neither
 * the job worker nor the schedulers, which are what would wait for the clock to move.
 */
export const DEMO_NOW = Date.UTC(2026, 9, 5, 10, 0, 0);

const RealDate = Date;

class DemoDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(DEMO_NOW);
    else super(...(args as [string | number | Date]));
  }
  static override now(): number {
    return DEMO_NOW;
  }
}

globalThis.Date = DemoDate as DateConstructor;

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

/** A moment `ms` before the demo's "now". */
export const ago = (ms: number): number => DEMO_NOW - ms;
