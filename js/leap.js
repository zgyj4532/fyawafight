export function leapSample(t, T, H) {
  const u = T > 0 ? Math.min(Math.max(t, 0), T) / T : 1;
  return { u, height: 4 * H * u * (1 - u) };
}
