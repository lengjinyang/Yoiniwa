export function percentileSorted(sortedValues: readonly number[], fraction: number) {
  if (!sortedValues.length) return 0;
  const clamped = Math.max(0, Math.min(1, fraction));
  return sortedValues[Math.min(sortedValues.length - 1, Math.floor(sortedValues.length * clamped))];
}

export function percentile(values: readonly number[], fraction: number) {
  return percentileSorted([...values].sort((left, right) => left - right), fraction);
}
