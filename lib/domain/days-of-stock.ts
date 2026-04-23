export function computeDaysOfStock(input: {
  onHand: number;
  velocityPerDay: number;
}): number {
  if (input.onHand <= 0) return 0;
  if (input.velocityPerDay <= 0) return Infinity;
  return input.onHand / input.velocityPerDay;
}
