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
import { type Layout } from './layout.js';
export interface Obstacle {
    x: number;
    y: number;
    w: number;
    h: number;
}
export declare const OBST_PAD = 2;
export declare const EDGE_PAD = 8;
export declare const TURN_COST = 10;
export declare const CROWD_COST = 30;
/** Does the orthogonal segment (x1,y1)-(x2,y2) cross any obstacle (open interval; edge-touching allowed)? */
export declare function segHitsObstacle(x1: number, y1: number, x2: number, y2: number, obs: Obstacle[]): boolean;
export declare function routeOrthogonal(obstacles: Obstacle[], sx: number, sy: number, tx: number, ty: number, occupied: Map<string, number>, corridorYs?: number[]): string;
/** Edge routing (shared by handoff/branch/manual links): picks exit/entry candidates per the user matrix and runs A* per combination. */
export interface EdgeRouteOptions {
    layout: Layout;
    obstacles: Obstacle[];
    occupied: Map<string, number>;
    from: string;
    to: string;
    /** Same-direction edge index (avoids coinciding start/end; j = step % 3 - 1). */
    step: number;
}
export declare function routeEdgePath(opts: EdgeRouteOptions): string;
