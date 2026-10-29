/**
 * 血缘链合并语义（纯函数，无 React/DOM 依赖；单测入口）。
 *
 * 血缘链 = 原生边（header.parentSession 推导，handoff/分支）∪ 手工衔接
 * （from = 创建较早一方）。凡「链」上的语义——出入度（金紫框判据）、
 * 分支判定（⑂N 徽章、连线显形类别）、详情区血缘/衔接到叙述——一律在
 * 合并链上计算；来源（原生/手工）只影响展示标注（颜色、（手工）字样），
 * 不改变链语义。手工边由 host 按创建时间归一，与原生 parent→child 同向。
 */

export interface LineageEdge {
  from: string
  to: string
}

export interface LineageLink {
  from: string
  to: string
}

export interface LineageDegree {
  /** 合并入度（原生 + 手工；紫框「待接前驱」判据用） */
  in: number
  /** 合并出度（原生 + 手工；金框「待接后继」判据、⑂N 徽章、分支判定用） */
  out: number
  nativeIn: number
  manualIn: number
  nativeOut: number
  manualOut: number
}

/** 合并出入度：原生边与手工边同权计入（一处计算，徽章/框判据/详情共用）。 */
export function lineageDegrees(
  edges: LineageEdge[],
  links: LineageLink[],
): Map<string, LineageDegree> {
  const m = new Map<string, LineageDegree>()
  const touch = (id: string): LineageDegree => {
    let d = m.get(id)
    if (d === undefined) {
      d = { in: 0, out: 0, nativeIn: 0, manualIn: 0, nativeOut: 0, manualOut: 0 }
      m.set(id, d)
    }
    return d
  }
  for (const e of edges) {
    const f = touch(e.from)
    const t = touch(e.to)
    f.out += 1
    f.nativeOut += 1
    t.in += 1
    t.nativeIn += 1
  }
  for (const l of links) {
    const f = touch(l.from)
    const t = touch(l.to)
    f.out += 1
    f.manualOut += 1
    t.in += 1
    t.manualIn += 1
  }
  return m
}

/** 连线显形类别：合并出度 ≥ 2 = 分支（扇出，紫实线），否则 = handoff（链式，蓝实线）。
 *  host 的 edges[].kind 保持原生口径（按原生子数分类），展示类别以此推导——
 *  父会话另有手工后继时，原生单子边也按分支显形（链语义合并的结果）。 */
export function displayKind(
  edge: LineageEdge,
  degrees: Map<string, LineageDegree>,
): 'handoff' | 'branch' {
  return (degrees.get(edge.from)?.out ?? 0) >= 2 ? 'branch' : 'handoff'
}
