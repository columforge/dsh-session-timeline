/** Parses an "M x y L x y …" polyline into point pairs (routing output is always absolute coordinates). */
export function segmentPoints(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? []
  const pts = []
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])])
  return pts
}
