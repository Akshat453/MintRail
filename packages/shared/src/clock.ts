/** Time access goes through here so tests can freeze it. */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = { now: () => new Date() };

export class FrozenClock implements Clock {
  private current: Date;
  constructor(start: Date) {
    this.current = new Date(start);
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}
