import { describe, expect, it } from 'vitest';
import { placeStormLabel, type LabelBox } from '../app/lib/stormLabelLayout';

describe('storm identity label layout', () => {
  const viewport = { width: 800, height: 600 };
  it('places newly confirmed children without suppressing an existing label', () => {
    const boxes: LabelBox[] = [];
    for (let i = 0; i < 4; i++) {
      boxes.push(placeStormLabel({ x: 400, y: 200, width: 140, height: 100 }, boxes, viewport));
    }
    expect(new Set(boxes.map(box => `${box.x}:${box.y}`)).size).toBe(4);
    for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i], b = boxes[j];
      expect(a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y).toBe(true);
    }
  });
  it('keeps a boundary label on screen after resize', () => {
    const box = placeStormLabel({ x: 780, y: 590, width: 140, height: 100 }, [], viewport);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });
  it('retains a label even when all free space is occupied', () => {
    expect(placeStormLabel({ x: 0, y: 0, width: 100, height: 100 },
      [{ x: 0, y: 0, width: 800, height: 600 }], viewport)).toMatchObject({ width: 100, height: 100 });
  });
});
