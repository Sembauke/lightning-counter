export interface CounterItem {
  type: 'digit' | 'comma';
  digit?: string;
  key: string;
}

export function buildCounterItems(totalCount: number): CounterItem[] {
  const raw = Math.max(0, Math.floor(totalCount)).toString();
  const digits = raw.split('');
  const len = digits.length;
  const items: CounterItem[] = [];

  digits.forEach((d, i) => {
    const posFromRight = len - 1 - i;
    if (i > 0 && posFromRight % 3 === 2) {
      items.push({ type: 'comma', key: `comma-${posFromRight}` });
    }
    items.push({ type: 'digit', digit: d, key: `pos-${posFromRight}` });
  });

  return items;
}
