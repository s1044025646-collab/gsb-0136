// Standard normal CDF and chi-square survival helpers (no external deps).

export function normalCdf(x: number): number {
  return 0.5 * (1 + erf(x / Math.SQRT2));
}

// Abramowitz & Stegun 7.1.26 approximation, |error| < 1.5e-7.
function erf(x: number): number {
  const sign = x < 0 ? -1 : 1;
  const ax = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * ax);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-ax * ax);
  return sign * y;
}

// Survival function of chi-square with 1 degree of freedom.
export function chiSquare1Survival(x: number): number {
  if (x <= 0) return 1;
  return 2 * (1 - normalCdf(Math.sqrt(x)));
}
