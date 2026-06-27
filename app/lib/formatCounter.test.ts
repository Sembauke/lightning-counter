import { describe, it, expect } from 'vitest';
import { buildCounterItems } from './formatCounter';

function render(n: number): string {
  return buildCounterItems(n)
    .map(item => (item.type === 'comma' ? ',' : item.digit!))
    .join('');
}

describe('buildCounterItems', () => {
  it('renders single digit correctly', () => {
    expect(render(0)).toBe('0');
    expect(render(9)).toBe('9');
  });

  it('renders two-digit numbers without commas', () => {
    expect(render(10)).toBe('10');
    expect(render(99)).toBe('99');
  });

  it('renders three-digit numbers without commas', () => {
    expect(render(100)).toBe('100');
    expect(render(999)).toBe('999');
  });

  it('inserts comma at thousands boundary', () => {
    expect(render(1000)).toBe('1,000');
    expect(render(9999)).toBe('9,999');
  });

  it('does NOT insert comma before the units digit (the bug)', () => {
    expect(render(25703)).toBe('25,703');
    expect(render(257039)).toBe('257,039');
    expect(render(1000000)).toBe('1,000,000');
  });

  it('handles large numbers with multiple commas', () => {
    expect(render(1234567)).toBe('1,234,567');
    expect(render(12345678)).toBe('12,345,678');
    expect(render(123456789)).toBe('123,456,789');
  });

  it('assigns stable keys keyed from the right', () => {
    const items = buildCounterItems(1234);
    const digitItems = items.filter(i => i.type === 'digit');
    expect(digitItems.map(i => i.key)).toEqual(['pos-3', 'pos-2', 'pos-1', 'pos-0']);
  });

  it('keys are stable when number grows (e.g. 999 → 1000)', () => {
    const before = buildCounterItems(999).filter(i => i.type === 'digit').map(i => i.key);
    const after  = buildCounterItems(1000).filter(i => i.type === 'digit').map(i => i.key);
    // pos-0, pos-1, pos-2 must exist in both so React reuses the DOM nodes
    expect(before).toContain('pos-0');
    expect(after).toContain('pos-0');
    expect(before).toContain('pos-1');
    expect(after).toContain('pos-1');
    expect(before).toContain('pos-2');
    expect(after).toContain('pos-2');
  });
});
