declare module "bun:test" {
  export function describe(name: string, fn: () => void): void;
  export function test(name: string, fn: () => void | Promise<void>): void;

  export interface Matchers<T> {
    toBe(expected: T): void;
    toEqual(expected: unknown): void;
    toHaveLength(length: number): void;
    toContain(item: unknown): void;
    toBeDefined(): void;
    toBeGreaterThan(num: number): void;
    toBeCloseTo(num: number, numDigits?: number): void;
    not: Matchers<T>;
  }

  export function expect<T>(actual: T): Matchers<T>;
}
