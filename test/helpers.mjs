/** 把 "M x y L x y …" 折线解析成点对（路由输出恒为绝对坐标）。 */
export function segmentPoints(d) {
  const nums = d.match(/-?\d+(?:\.\d+)?/g) ?? []
  const pts = []
  for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])])
  return pts
}
