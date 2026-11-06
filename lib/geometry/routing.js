/**
 * Orthogonal obstacle-avoiding routing (pure functions, no React/DOM deps; unit-test entry).
 *
 * Node boxes (padded 2px) are obstacles; the canvas builds an orthogonal
 * channel grid at box edges ±8px. Each edge runs A* on the grid
 * (cost = length + turns ×10 + occupied-channel crowding ×30), yielding an
 * orthogonal polyline that crosses no box and adapts to any layout/link combo.
 *
 * Three historical pitfalls (check first on regressions):
 * 1. Channel coordinates must not include points inside an obstacle (e.g. box
 *    centers) — endpoints snapping inside get stranded;
 * 2. Endpoints must be exact points 3px outside the box edge (after the 2px
 *    obstacle padding the box edge lies inside the obstacle);
 * 3. Anti-overlap nudges must slide along the edge (exits horizontally along
 *    the top/bottom edge, entries vertically along the side) — perpendicular
 *    nudges push the point back inside the obstacle, same effect as 1.
 *
 * The module is split into small steps (channels → A* → waypoints → fallback)
 * so each rule stays under the ub-mode CRAP budget.
 */
import { colX, nodeTop, NODE_W, NODE_H } from './layout.js';
export const OBST_PAD = 2;
export const EDGE_PAD = 8;
export const TURN_COST = 10;
export const CROWD_COST = 30;
/* ---- Segment/obstacle geometry ---- */
function withinInterval(value, lo, hi) {
    return value > lo && value < hi;
}
function spansOverlap(a1, a2, lo, hi) {
    return Math.max(a1, a2) > lo && Math.min(a1, a2) < hi;
}
/** Orthogonal segment crosses a box (open interval: touching an edge is allowed). */
function segmentHitsBox(x1, y1, x2, y2, o) {
    if (x1 === x2)
        return withinInterval(x1, o.x, o.x + o.w) && spansOverlap(y1, y2, o.y, o.y + o.h);
    if (y1 === y2)
        return withinInterval(y1, o.y, o.y + o.h) && spansOverlap(x1, x2, o.x, o.x + o.w);
    return false;
}
/** Does the orthogonal segment (x1,y1)-(x2,y2) cross any obstacle (open interval; edge-touching allowed)? */
export function segHitsObstacle(x1, y1, x2, y2, obs) {
    for (const o of obs) {
        if (segmentHitsBox(x1, y1, x2, y2, o))
            return true;
    }
    return false;
}
/* ---- Channel grid ---- */
/** Deduped channel coordinates (sorted; neighbours closer than 6px merged). */
function mergeChannels(values) {
    const sorted = [...values].sort((p, q) => p - q);
    const out = [];
    for (const v of sorted) {
        if (out.length === 0 || v - out[out.length - 1] > 6)
            out.push(v);
    }
    return out;
}
function buildChannels(obstacles, sx, sy, tx, ty) {
    /* Channel coordinates: all box edges ±8 plus both endpoints; deduped and near-neighbors merged. */
    const xsRaw = [sx, tx];
    const ysRaw = [sy, ty];
    for (const o of obstacles) {
        xsRaw.push(o.x - EDGE_PAD, o.x + o.w + EDGE_PAD);
        ysRaw.push(o.y - EDGE_PAD, o.y + o.h + EDGE_PAD);
    }
    return { xs: mergeChannels(xsRaw), ys: mergeChannels(ysRaw) };
}
/** Index of the nearest channel coordinate (first minimal wins, matching the value lookup it replaces). */
function nearestIndex(channels, value) {
    let best = 0;
    for (let i = 0; i < channels.length; i += 1) {
        if (Math.abs(channels[i] - value) < Math.abs(channels[best] - value))
            best = i;
    }
    return best;
}
/* ---- Channel occupancy (crowding cost for later edges) ---- */
function channelKey(x1, y1, x2, y2) {
    return x1 === x2 ? 'v' + String(x1) : 'h' + String(y1);
}
function crowdCost(occupied, x1, y1, x2, y2) {
    return (occupied.get(channelKey(x1, y1, x2, y2)) ?? 0) * CROWD_COST;
}
function markChannel(occupied, x1, y1, x2, y2) {
    const key = channelKey(x1, y1, x2, y2);
    occupied.set(key, (occupied.get(key) ?? 0) + 1);
}
function pointKey(x, y) {
    return String(x) + ',' + String(y);
}
function heuristic(grid, x, y) {
    return Math.abs(x - grid.xs[grid.t.x]) + Math.abs(y - grid.ys[grid.t.y]);
}
function inBounds(grid, x, y) {
    return x >= 0 && y >= 0 && x < grid.xs.length && y < grid.ys.length;
}
function canStep(grid, cx, cy, nx, ny) {
    if (!inBounds(grid, nx, ny))
        return false;
    return !segHitsObstacle(grid.xs[cx], grid.ys[cy], grid.xs[nx], grid.ys[ny], grid.obstacles);
}
/** Relax one neighbour edge into the open set (cheapest g wins; parent recorded for backtracking). */
function relaxNeighbor(grid, state, current, nx, ny, dir) {
    if (!canStep(grid, current.x, current.y, nx, ny))
        return;
    const ax = grid.xs[current.x];
    const ay = grid.ys[current.y];
    const bx = grid.xs[nx];
    const by = grid.ys[ny];
    const turn = current.dir !== '' && current.dir !== dir ? TURN_COST : 0;
    const g = current.g + (Math.abs(bx - ax) + Math.abs(by - ay)) + turn + crowdCost(grid.occupied, ax, ay, bx, by);
    const nk = pointKey(nx, ny);
    if (g < (state.bestG.get(nk) ?? Infinity)) {
        state.bestG.set(nk, g);
        state.parentMap.set(nk, pointKey(current.x, current.y));
        state.open.push({ x: nx, y: ny, g, f: g + heuristic(grid, grid.xs[nx], grid.ys[ny]), dir });
    }
}
/** A*: cost = step + turn ×10 + channel crowding ×30; returns the parent map or null on a dead end. */
function search(grid) {
    const state = {
        open: [{ x: grid.s.x, y: grid.s.y, g: 0, f: 0, dir: '' }],
        bestG: new Map([[pointKey(grid.s.x, grid.s.y), 0]]),
        parentMap: new Map(),
    };
    let expanded = 0;
    while (state.open.length > 0 && expanded < 60000) {
        state.open.sort((a, b) => a.f - b.f);
        const cur = state.open.shift();
        if (cur === undefined)
            break;
        expanded += 1;
        const ck = pointKey(cur.x, cur.y);
        if ((state.bestG.get(ck) ?? Infinity) < cur.g)
            continue;
        if (cur.x === grid.t.x && cur.y === grid.t.y)
            break;
        relaxNeighbor(grid, state, cur, cur.x + 1, cur.y, 'h');
        relaxNeighbor(grid, state, cur, cur.x - 1, cur.y, 'h');
        relaxNeighbor(grid, state, cur, cur.x, cur.y + 1, 'v');
        relaxNeighbor(grid, state, cur, cur.x, cur.y - 1, 'v');
    }
    return state.parentMap.has(pointKey(grid.t.x, grid.t.y)) ? state.parentMap : null;
}
/** Backtrack waypoints from the target grid point to the start grid point. */
function traceWaypoints(grid, parentMap) {
    const pts = [];
    const seen = new Set();
    let ck = pointKey(grid.t.x, grid.t.y);
    for (;;) {
        const comma = ck.indexOf(',');
        pts.unshift([grid.xs[Number(ck.slice(0, comma))], grid.ys[Number(ck.slice(comma + 1))]]);
        seen.add(ck);
        const parent = parentMap.get(ck);
        if (parent === undefined || seen.has(parent))
            break;
        ck = parent;
    }
    return pts;
}
/** Merge collinear points (drop interior waypoints of a straight run) and duplicate points. */
function simplifyPath(pts) {
    const out = [];
    for (const pt of pts) {
        const n = out.length;
        const straightRun = n >= 2 && (out[n - 1][0] === pt[0]) === (out[n - 2][0] === out[n - 1][0]);
        if (straightRun)
            out[out.length - 1] = pt;
        else if (n === 0 || out[n - 1][0] !== pt[0] || out[n - 1][1] !== pt[1])
            out.push(pt);
    }
    return out;
}
/* ---- Fallback when A* hits a grid dead end ---- */
/** Path string coordinates in order. */
function pointsOfPath(path) {
    const nums = path.match(/-?\d+(\.\d+)?/g) ?? [];
    const pts = [];
    for (let i = 0; i + 1 < nums.length; i += 2)
        pts.push([Number(nums[i]), Number(nums[i + 1])]);
    return pts;
}
function segmentCrossings(a, b, obstacles) {
    let n = 0;
    for (const o of obstacles) {
        if (segmentHitsBox(a[0], a[1], b[0], b[1], o))
            n += 1;
    }
    return n;
}
/** How many box crossings a candidate path makes (lower is better; 0 = clean). */
function crossingCount(pts, obstacles) {
    let n = 0;
    for (let i = 0; i + 1 < pts.length; i += 1)
        n += segmentCrossings(pts[i], pts[i + 1], obstacles);
    return n;
}
function uPath(sx, sy, tx, ty, corridorY) {
    return 'M ' + String(sx) + ' ' + String(sy) + ' L ' + String(sx) + ' ' + String(corridorY)
        + ' L ' + String(tx) + ' ' + String(corridorY) + ' L ' + String(tx) + ' ' + String(ty);
}
function lPath(sx, sy, tx, ty, horizontalFirst) {
    const midX = horizontalFirst ? tx : sx;
    const midY = horizontalFirst ? sy : ty;
    return 'M ' + String(sx) + ' ' + String(sy) + ' L ' + String(midX) + ' ' + String(midY)
        + ' L ' + String(tx) + ' ' + String(ty);
}
/* ① U-shape via an outer corridor (corridors lie outside every box, so no box
 * is crossed); ② orthogonal L polyline (never diagonal; pick the one crossing
 * fewer obstacles when it does). */
function fallbackPath(obstacles, sx, sy, tx, ty, corridorYs) {
    const candidates = [];
    for (const cy of corridorYs)
        candidates.push(uPath(sx, sy, tx, ty, cy));
    candidates.push(lPath(sx, sy, tx, ty, false));
    candidates.push(lPath(sx, sy, tx, ty, true));
    let best = null;
    let bestBad = Infinity;
    for (const candidate of candidates) {
        const bad = crossingCount(pointsOfPath(candidate), obstacles);
        if (bad === 0)
            return candidate;
        if (bad < bestBad) {
            bestBad = bad;
            best = candidate;
        }
    }
    return best ?? candidates[0];
}
function pathOf(pts) {
    return 'M ' + pts.map((p) => String(p[0]) + ' ' + String(p[1])).join(' L ');
}
export function routeOrthogonal(obstacles, sx, sy, tx, ty, occupied, corridorYs = []) {
    const { xs, ys } = buildChannels(obstacles, sx, sy, tx, ty);
    const grid = {
        xs,
        ys,
        s: { x: nearestIndex(xs, sx), y: nearestIndex(ys, sy) },
        t: { x: nearestIndex(xs, tx), y: nearestIndex(ys, ty) },
        obstacles,
        occupied,
    };
    const parentMap = search(grid);
    if (parentMap === null)
        return fallbackPath(obstacles, sx, sy, tx, ty, corridorYs);
    const pts = simplifyPath([[sx, sy], ...traceWaypoints(grid, parentMap), [tx, ty]]);
    for (let i = 0; i + 1 < pts.length; i += 1) {
        markChannel(occupied, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
    }
    return pathOf(pts);
}
/** Exit point: outer edge of the source box (bottom for down / top for up), nudged along the edge. */
function exitPoint(fx, fTop, j, up) {
    return { x: fx + j * 10, y: up ? fTop - 3 : fTop + NODE_H + 3 };
}
/** Entry point: facing side edge of the target box, nudged along the edge. */
function entryPoint(tx, tTop, childOnRight, j) {
    const sideX = childOnRight ? tx - NODE_W / 2 - 3 : tx + NODE_W / 2 + 3;
    return { x: sideX, y: tTop + NODE_H / 2 + j * 6 };
}
export function routeEdgePath(opts) {
    const { layout, obstacles, occupied, from, to, step } = opts;
    const fUp = (layout.sideOf.get(from) ?? 'up') === 'up';
    const tUp = (layout.sideOf.get(to) ?? 'up') === 'up';
    const fTop = nodeTop(layout, from);
    const tTop = nodeTop(layout, to);
    const fx = colX(layout, from);
    const tx = colX(layout, to);
    const j = (step % 3) - 1;
    /* Exit/entry candidates (user matrix; covers every parent-left/right combo):
     * side edges always face the counterpart — parent left of child ⇒ parent
     * exits right edge, child enters left edge; parent right ⇒ mirrored.
     * Nudges slide along the edge (j*10/j*6), never perpendicular — that would
     * push endpoints back inside the obstacle and strand them. */
    const childOnRight = tx > fx;
    const fromPoint = exitPoint(fx, fTop, j, fUp);
    const toPoint = entryPoint(tx, tTop, childOnRight, j);
    /* routeOrthogonal always returns a polyline with at least one segment for
     * distinct endpoints, so the primary exit/entry pair is final; the old
     * secondary-candidate loop never advanced past it (verified by the matrix
     * tests: every returned path starts/ends at these exact points). */
    return routeOrthogonal(obstacles, fromPoint.x, fromPoint.y, toPoint.x, toPoint.y, occupied);
}
//# sourceMappingURL=routing.js.map