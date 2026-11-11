window.__ModuleLoader__.load({
	id: "@columforge/session-timeline",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		/** Top of a node box on one side at one depth row. */
		function rowTop(side, depth, axisY) {
			return side === "up" ? axisY - 26 - 96 - depth * 112 : axisY + 26 + depth * 112;
		}
		/** Dependency = native parent if present, else manual predecessor (both normalized to parent→child). */
		function dependencyOf(node, state) {
			return state.nativeParent.get(node.id) ?? state.manualParent.get(node.id);
		}
		/** Record one assignment and widen the side's max depth. */
		function commitAssignment(state, nodeId, side, depth) {
			state.sideOf.set(nodeId, side);
			state.depthOf.set(nodeId, depth);
			if (side === "up" && depth > state.upMax) state.upMax = depth;
			if (side === "down" && depth > state.downMax) state.downMax = depth;
		}
		/** Standalone node: alternate sides, depth 0. */
		function assignStandalone(node, state) {
			const side = state.flip % 2 === 0 ? "up" : "down";
			state.flip += 1;
			commitAssignment(state, node.id, side, 0);
		}
		/**
		* Assign one node when its dependency is already assigned.
		* @returns true when the node was assigned (standalone counts), false when deferred.
		*/
		function assignNode(node, state) {
			const dep = dependencyOf(node, state);
			if (dep === void 0) {
				assignStandalone(node, state);
				return true;
			}
			if (!state.sideOf.has(dep)) return false;
			const side = state.sideOf.get(dep) ?? "up";
			const depth = (state.depthOf.get(dep) ?? 0) + 1;
			commitAssignment(state, node.id, side, depth);
			return true;
		}
		function assignSides(byCreation, state) {
			const pending = byCreation;
			let progressed = true;
			while (pending.length > 0 && progressed) {
				progressed = false;
				for (let pi = pending.length - 1; pi >= 0; pi -= 1) {
					if (!assignNode(pending[pi], state)) continue;
					pending.splice(pi, 1);
					progressed = true;
				}
			}
			for (const node of pending) assignStandalone(node, state);
		}
		/** Outer box bounds per side (Infinity/-Infinity when no nodes on that side). */
		function outerBounds(nodes, sideOf, depthOf, axisY) {
			let up = Infinity;
			let down = -Infinity;
			for (const node of nodes) {
				const side = sideOf.get(node.id) ?? "up";
				const top = rowTop(side, depthOf.get(node.id) ?? 0, axisY);
				if (side === "up") up = Math.min(up, top);
				else down = Math.max(down, top + 96);
			}
			return {
				up,
				down
			};
		}
		function computeLayout(nodesIn, edges, manualLinks) {
			const nodes = nodesIn;
			const nativeParent = /* @__PURE__ */ new Map();
			for (const e of edges) nativeParent.set(e.to, e.from);
			const manualParent = /* @__PURE__ */ new Map();
			for (const l of manualLinks) manualParent.set(l.to, l.from);
			const byCreation = [...nodesIn].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
			const state = {
				nativeParent,
				manualParent,
				sideOf: /* @__PURE__ */ new Map(),
				depthOf: /* @__PURE__ */ new Map(),
				flip: 0,
				upMax: 0,
				downMax: 0
			};
			assignSides(byCreation, state);
			const colOf = /* @__PURE__ */ new Map();
			nodesIn.forEach((n, i) => {
				colOf.set(n.id, i);
			});
			const upBlock = (state.upMax + 1) * 96 + state.upMax * 16;
			const downBlock = (state.downMax + 1) * 96 + state.downMax * 16;
			const axisY = 16 + upBlock + 26;
			const outer = outerBounds(nodes, state.sideOf, state.depthOf, axisY);
			const corridorUp = (outer.up === Infinity ? 16 : outer.up) - 12;
			const corridorDown = (outer.down === -Infinity ? axisY + 26 + 96 : outer.down) + 12;
			return {
				nodes,
				colOf,
				sideOf: state.sideOf,
				depthOf: state.depthOf,
				axisY,
				innerW: Math.max(nodes.length * 140 + 24, 320),
				innerH: axisY + 26 + downBlock + 16,
				maxDepth: Math.max(state.upMax, state.downMax),
				corridorUp,
				corridorDown
			};
		}
		function colX(layout, id) {
			return (layout.colOf.get(id) ?? 0) * 140 + 140 / 2;
		}
		function nodeTop(layout, id) {
			return rowTop(layout.sideOf.get(id) ?? "up", layout.depthOf.get(id) ?? 0, layout.axisY);
		}
		function withinInterval(value, lo, hi) {
			return value > lo && value < hi;
		}
		function spansOverlap(a1, a2, lo, hi) {
			return Math.max(a1, a2) > lo && Math.min(a1, a2) < hi;
		}
		/** Orthogonal segment crosses a box (open interval: touching an edge is allowed). */
		function segmentHitsBox(x1, y1, x2, y2, o) {
			if (x1 === x2) return withinInterval(x1, o.x, o.x + o.w) && spansOverlap(y1, y2, o.y, o.y + o.h);
			if (y1 === y2) return withinInterval(y1, o.y, o.y + o.h) && spansOverlap(x1, x2, o.x, o.x + o.w);
			return false;
		}
		/** Does the orthogonal segment (x1,y1)-(x2,y2) cross any obstacle (open interval; edge-touching allowed)? */
		function segHitsObstacle(x1, y1, x2, y2, obs) {
			for (const o of obs) if (segmentHitsBox(x1, y1, x2, y2, o)) return true;
			return false;
		}
		/** Deduped channel coordinates (sorted; neighbours closer than 6px merged). */
		function mergeChannels(values) {
			const sorted = [...values].sort((p, q) => p - q);
			const out = [];
			for (const v of sorted) if (out.length === 0 || v - out[out.length - 1] > 6) out.push(v);
			return out;
		}
		function buildChannels(obstacles, sx, sy, tx, ty) {
			const xsRaw = [sx, tx];
			const ysRaw = [sy, ty];
			for (const o of obstacles) {
				xsRaw.push(o.x - 8, o.x + o.w + 8);
				ysRaw.push(o.y - 8, o.y + o.h + 8);
			}
			return {
				xs: mergeChannels(xsRaw),
				ys: mergeChannels(ysRaw)
			};
		}
		/** Index of the nearest channel coordinate (first minimal wins, matching the value lookup it replaces). */
		function nearestIndex(channels, value) {
			let best = 0;
			for (let i = 0; i < channels.length; i += 1) if (Math.abs(channels[i] - value) < Math.abs(channels[best] - value)) best = i;
			return best;
		}
		function channelKey(x1, y1, x2, y2) {
			return x1 === x2 ? "v" + String(x1) : "h" + String(y1);
		}
		function crowdCost(occupied, x1, y1, x2, y2) {
			return (occupied.get(channelKey(x1, y1, x2, y2)) ?? 0) * 30;
		}
		function markChannel(occupied, x1, y1, x2, y2) {
			const key = channelKey(x1, y1, x2, y2);
			occupied.set(key, (occupied.get(key) ?? 0) + 1);
		}
		function pointKey(x, y) {
			return String(x) + "," + String(y);
		}
		function heuristic(grid, x, y) {
			return Math.abs(x - grid.xs[grid.t.x]) + Math.abs(y - grid.ys[grid.t.y]);
		}
		function inBounds(grid, x, y) {
			return x >= 0 && y >= 0 && x < grid.xs.length && y < grid.ys.length;
		}
		function canStep(grid, cx, cy, nx, ny) {
			if (!inBounds(grid, nx, ny)) return false;
			return !segHitsObstacle(grid.xs[cx], grid.ys[cy], grid.xs[nx], grid.ys[ny], grid.obstacles);
		}
		/** Relax one neighbour edge into the open set (cheapest g wins; parent recorded for backtracking). */
		function relaxNeighbor(grid, state, current, nx, ny, dir) {
			if (!canStep(grid, current.x, current.y, nx, ny)) return;
			const ax = grid.xs[current.x];
			const ay = grid.ys[current.y];
			const bx = grid.xs[nx];
			const by = grid.ys[ny];
			const turn = current.dir !== "" && current.dir !== dir ? 10 : 0;
			const g = current.g + (Math.abs(bx - ax) + Math.abs(by - ay)) + turn + crowdCost(grid.occupied, ax, ay, bx, by);
			const nk = pointKey(nx, ny);
			if (g < (state.bestG.get(nk) ?? Infinity)) {
				state.bestG.set(nk, g);
				state.parentMap.set(nk, pointKey(current.x, current.y));
				state.open.push({
					x: nx,
					y: ny,
					g,
					f: g + heuristic(grid, grid.xs[nx], grid.ys[ny]),
					dir
				});
			}
		}
		/** A*: cost = step + turn ×10 + channel crowding ×30; returns the parent map or null on a dead end. */
		function search(grid) {
			const state = {
				open: [{
					x: grid.s.x,
					y: grid.s.y,
					g: 0,
					f: 0,
					dir: ""
				}],
				bestG: new Map([[pointKey(grid.s.x, grid.s.y), 0]]),
				parentMap: /* @__PURE__ */ new Map()
			};
			let expanded = 0;
			while (state.open.length > 0 && expanded < 6e4) {
				state.open.sort((a, b) => a.f - b.f);
				const cur = state.open.shift();
				if (cur === void 0) break;
				expanded += 1;
				const ck = pointKey(cur.x, cur.y);
				if ((state.bestG.get(ck) ?? Infinity) < cur.g) continue;
				if (cur.x === grid.t.x && cur.y === grid.t.y) break;
				relaxNeighbor(grid, state, cur, cur.x + 1, cur.y, "h");
				relaxNeighbor(grid, state, cur, cur.x - 1, cur.y, "h");
				relaxNeighbor(grid, state, cur, cur.x, cur.y + 1, "v");
				relaxNeighbor(grid, state, cur, cur.x, cur.y - 1, "v");
			}
			return state.parentMap.has(pointKey(grid.t.x, grid.t.y)) ? state.parentMap : null;
		}
		/** Backtrack waypoints from the target grid point to the start grid point. */
		function traceWaypoints(grid, parentMap) {
			const pts = [];
			const seen = /* @__PURE__ */ new Set();
			let ck = pointKey(grid.t.x, grid.t.y);
			for (;;) {
				const comma = ck.indexOf(",");
				pts.unshift([grid.xs[Number(ck.slice(0, comma))], grid.ys[Number(ck.slice(comma + 1))]]);
				seen.add(ck);
				const parent = parentMap.get(ck);
				if (parent === void 0 || seen.has(parent)) break;
				ck = parent;
			}
			return pts;
		}
		/** Merge collinear points (drop interior waypoints of a straight run) and duplicate points. */
		function simplifyPath(pts) {
			const out = [];
			for (const pt of pts) {
				const n = out.length;
				if (n >= 2 && out[n - 1][0] === pt[0] === (out[n - 2][0] === out[n - 1][0])) out[out.length - 1] = pt;
				else if (n === 0 || out[n - 1][0] !== pt[0] || out[n - 1][1] !== pt[1]) out.push(pt);
			}
			return out;
		}
		/** Path string coordinates in order. */
		function pointsOfPath(path) {
			const nums = path.match(/-?\d+(\.\d+)?/g) ?? [];
			const pts = [];
			for (let i = 0; i + 1 < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
			return pts;
		}
		function segmentCrossings(a, b, obstacles) {
			let n = 0;
			for (const o of obstacles) if (segmentHitsBox(a[0], a[1], b[0], b[1], o)) n += 1;
			return n;
		}
		/** How many box crossings a candidate path makes (lower is better; 0 = clean). */
		function crossingCount(pts, obstacles) {
			let n = 0;
			for (let i = 0; i + 1 < pts.length; i += 1) n += segmentCrossings(pts[i], pts[i + 1], obstacles);
			return n;
		}
		function uPath(sx, sy, tx, ty, corridorY) {
			return "M " + String(sx) + " " + String(sy) + " L " + String(sx) + " " + String(corridorY) + " L " + String(tx) + " " + String(corridorY) + " L " + String(tx) + " " + String(ty);
		}
		function lPath(sx, sy, tx, ty, horizontalFirst) {
			const midX = horizontalFirst ? tx : sx;
			const midY = horizontalFirst ? sy : ty;
			return "M " + String(sx) + " " + String(sy) + " L " + String(midX) + " " + String(midY) + " L " + String(tx) + " " + String(ty);
		}
		function fallbackPath(obstacles, sx, sy, tx, ty, corridorYs) {
			const candidates = [];
			for (const cy of corridorYs) candidates.push(uPath(sx, sy, tx, ty, cy));
			candidates.push(lPath(sx, sy, tx, ty, false));
			candidates.push(lPath(sx, sy, tx, ty, true));
			let best = null;
			let bestBad = Infinity;
			for (const candidate of candidates) {
				const bad = crossingCount(pointsOfPath(candidate), obstacles);
				if (bad === 0) return candidate;
				if (bad < bestBad) {
					bestBad = bad;
					best = candidate;
				}
			}
			return best ?? candidates[0];
		}
		function pathOf(pts) {
			return "M " + pts.map((p) => String(p[0]) + " " + String(p[1])).join(" L ");
		}
		function routeOrthogonal(obstacles, sx, sy, tx, ty, occupied, corridorYs = []) {
			const { xs, ys } = buildChannels(obstacles, sx, sy, tx, ty);
			const grid = {
				xs,
				ys,
				s: {
					x: nearestIndex(xs, sx),
					y: nearestIndex(ys, sy)
				},
				t: {
					x: nearestIndex(xs, tx),
					y: nearestIndex(ys, ty)
				},
				obstacles,
				occupied
			};
			const parentMap = search(grid);
			if (parentMap === null) return fallbackPath(obstacles, sx, sy, tx, ty, corridorYs);
			const pts = simplifyPath([
				[sx, sy],
				...traceWaypoints(grid, parentMap),
				[tx, ty]
			]);
			for (let i = 0; i + 1 < pts.length; i += 1) markChannel(occupied, pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1]);
			return pathOf(pts);
		}
		/** Exit point: outer edge of the source box (bottom for down / top for up), nudged along the edge. */
		function exitPoint(fx, fTop, j, up) {
			return {
				x: fx + j * 10,
				y: up ? fTop - 3 : fTop + 96 + 3
			};
		}
		/** Entry point: facing side edge of the target box, nudged along the edge. */
		function entryPoint(tx, tTop, childOnRight, j) {
			return {
				x: childOnRight ? tx - 132 / 2 - 3 : tx + 132 / 2 + 3,
				y: tTop + 96 / 2 + j * 6
			};
		}
		function routeEdgePath(opts) {
			const { layout, obstacles, occupied, from, to, step } = opts;
			const fUp = (layout.sideOf.get(from) ?? "up") === "up";
			layout.sideOf.get(to);
			const fTop = nodeTop(layout, from);
			const tTop = nodeTop(layout, to);
			const fx = colX(layout, from);
			const tx = colX(layout, to);
			const j = step % 3 - 1;
			const childOnRight = tx > fx;
			const fromPoint = exitPoint(fx, fTop, j, fUp);
			const toPoint = entryPoint(tx, tTop, childOnRight, j);
			return routeOrthogonal(obstacles, fromPoint.x, fromPoint.y, toPoint.x, toPoint.y, occupied);
		}
		//#endregion
		//#region src/geometry/lineage.ts
		/** Merged degrees: native and manual edges count equally (computed once; shared by badge/frame criteria/details). */
		function lineageDegrees(edges, links) {
			const m = /* @__PURE__ */ new Map();
			const touch = (id) => {
				let d = m.get(id);
				if (d === void 0) {
					d = {
						in: 0,
						out: 0,
						nativeIn: 0,
						manualIn: 0,
						nativeOut: 0,
						manualOut: 0
					};
					m.set(id, d);
				}
				return d;
			};
			for (const e of edges) {
				const f = touch(e.from);
				const t = touch(e.to);
				f.out += 1;
				f.nativeOut += 1;
				t.in += 1;
				t.nativeIn += 1;
			}
			for (const l of links) {
				const f = touch(l.from);
				const t = touch(l.to);
				f.out += 1;
				f.manualOut += 1;
				t.in += 1;
				t.manualIn += 1;
			}
			return m;
		}
		/** Display kind of a link: merged out-degree ≥ 2 = branch (fan-out, purple solid), else handoff (chained, blue solid).
		*  The host's edges[].kind keeps the native criterion (by native child count);
		*  display kind is derived here — when the parent also has a manual successor,
		*  a native single-child edge displays as a branch (result of merged chain
		*  semantics). */
		function displayKind(edge, degrees) {
			return (degrees.get(edge.from)?.out ?? 0) >= 2 ? "branch" : "handoff";
		}
		/** Shared scale: global columns by display order (same rule as the single view), skipping collapsed lanes. */
		function assignSharedColumns(nodesIn, laneOfNode, collapsed) {
			const colOf = /* @__PURE__ */ new Map();
			let ci = 0;
			for (const n of nodesIn) {
				if (collapsed !== void 0 && collapsed.has(laneOfNode(n))) continue;
				colOf.set(n.id, ci);
				ci += 1;
			}
			return colOf;
		}
		/** Group per lane, preserving display order; lane stacking order = first appearance. */
		function groupByLane(nodesIn, laneOfNode) {
			const laneIds = [];
			const byLane = /* @__PURE__ */ new Map();
			for (const n of nodesIn) {
				const lane = laneOfNode(n);
				const list = byLane.get(lane);
				if (list === void 0) {
					byLane.set(lane, [n]);
					laneIds.push(lane);
				} else list.push(n);
			}
			return {
				laneIds,
				byLane
			};
		}
		/** Collapsed lane: slim label-only band; its nodes stay out of nodes/colOf/laneOf. */
		function collapsedLane(laneId, y) {
			return {
				nodes: [],
				colOf: /* @__PURE__ */ new Map(),
				sideOf: /* @__PURE__ */ new Map(),
				depthOf: /* @__PURE__ */ new Map(),
				axisY: y + 28,
				innerW: 0,
				innerH: 28,
				maxDepth: 0,
				corridorUp: y,
				corridorDown: y + 28,
				id: laneId,
				top: y,
				collapsed: true
			};
		}
		/** One visible lane: fishbone on the lane's own nodes, then shared columns + stack offset. */
		function buildLane(laneId, laneNodes, y, colOf, edges, manualLinks) {
			const member = new Set(laneNodes.map((n) => n.id));
			const base = computeLayout(laneNodes, edges.filter((e) => member.has(e.from) && member.has(e.to)), manualLinks.filter((l) => member.has(l.from) && member.has(l.to)));
			const laneColOf = /* @__PURE__ */ new Map();
			for (const n of laneNodes) laneColOf.set(n.id, colOf.get(n.id) ?? 0);
			return {
				...base,
				id: laneId,
				top: y,
				collapsed: false,
				colOf: laneColOf,
				axisY: base.axisY + y,
				corridorUp: base.corridorUp + y,
				corridorDown: base.corridorDown + y
			};
		}
		/** `collapsed` = ids of lanes to render as slim label-only bands (their nodes stay out of the scale). */
		function computeLanesLayout(nodesIn, edges, manualLinks, laneOfNode, collapsed) {
			const colOf = assignSharedColumns(nodesIn, laneOfNode, collapsed);
			const { laneIds, byLane } = groupByLane(nodesIn, laneOfNode);
			const laneOf = /* @__PURE__ */ new Map();
			const laneById = /* @__PURE__ */ new Map();
			const lanes = [];
			let y = 26;
			for (const laneId of laneIds) {
				if (collapsed !== void 0 && collapsed.has(laneId)) {
					const lane = collapsedLane(laneId, y);
					laneById.set(laneId, lane);
					lanes.push(lane);
					y += 54;
					continue;
				}
				const laneNodes = byLane.get(laneId) ?? [];
				const lane = buildLane(laneId, laneNodes, y, colOf, edges, manualLinks);
				for (const n of laneNodes) laneOf.set(n.id, laneId);
				laneById.set(laneId, lane);
				lanes.push(lane);
				y += lane.innerH + 26;
			}
			const gridNodes = nodesIn.filter((n) => !(collapsed !== void 0 && collapsed.has(laneOfNode(n))));
			return {
				nodes: gridNodes,
				colOf,
				laneOf,
				laneById,
				lanes,
				innerW: Math.max(gridNodes.length * 140 + 24, 320),
				innerH: laneIds.length > 0 ? y - 26 : 26
			};
		}
		/** Absolute canvas y of a node box top within the lane stack (its own lane's axis). */
		function laneNodeTop(l, id) {
			const lane = l.laneById.get(l.laneOf.get(id) ?? "");
			if (lane === void 0) return 0;
			const side = lane.sideOf.get(id) ?? "up";
			const depth = lane.depthOf.get(id) ?? 0;
			if (side === "up") return lane.axisY - 26 - 96 - depth * 112;
			return lane.axisY + 26 + depth * 112;
		}
		//#endregion
		//#region src/client/locales.ts
		/** 客户端词典命名空间（ctx.locale.bind / slots.register 的 locale 选项）。 */
		const NS = "sessionTimeline";
		/** 简体中文词典——键位与占位符的基准。 */
		const zh = {
			"panel.title": "会话时间线",
			"fmt.count": "（{count}）",
			"guide.description": "鱼骨时间线：会话按创建时间交替分布在主轴上下，handoff/分支血缘弯折线衔接；可切「所有工作区」多线画布（每工作区一根时间线，刻度一致），拖动节点手工衔接，双击切换会话",
			"state.loading": "加载中…",
			"state.renderFailed": "会话时间线渲染失败：{message}",
			"error.noSession": "未定位当前会话，无法确定工作区",
			"error.requestFailed": "请求失败（网络/服务不可达），稍后自动重试轮询",
			"error.opFailed": "操作失败",
			"error.workspaceMissing": "工作区 {bucket} 不存在（桶不可读）",
			"error.locateMissing": "缺 session/workspace 参数",
			"error.sessionNotInBucket": "会话 {session} 不在任何工作区存储桶",
			"error.crossWorkspace": "两会话分属不同工作区，手工衔接不能跨工作区",
			"error.emptyFromTo": "from/to 不能为空",
			"error.linkSelf": "不能与自己衔接",
			"error.notTopLevel": "from/to 必须是该工作区的顶层会话",
			"error.nativeHandoff": "两会话已存在原生血缘（handoff），无需手工连线",
			"error.nativeBranch": "两会话已存在原生血缘（分支），无需手工连线",
			"error.storageRead": "存储文件读取失败：{message}",
			"error.storageWrite": "存储文件写入失败：{message}",
			"error.sessionMissing": "会话 {session} 不存在",
			"error.decodeFailed": "会话日志解码失败",
			"error.parseFailed": "解析失败：{message}",
			"error.unknownEndpoint": "未知端点 {method} {path}",
			"msg.linked": "已建立手工衔接",
			"msg.linkDuplicate": "已存在手工衔接",
			"msg.unlinked": "已断开手工衔接",
			"node.hint": "双击切换到该会话；拖到另一节点建立手工衔接",
			"node.untitled": "（无标题）",
			"node.tag.externalParent": "外部父",
			"header.workspaceTitle": "查看哪个工作区的时间线",
			"header.workspaceCurrent": "当前会话工作区",
			"header.workspaceAll": "所有工作区",
			"header.orderTitle": "时间方向",
			"header.orderOldNew": "从老到新",
			"header.orderNewOld": "从新到老",
			"header.sortTitle": "排序方式",
			"header.sortCreated": "按创建时间",
			"header.sortLast": "按最后活动",
			"header.archiveTitle": "归档会话显示",
			"header.archiveShowAll": "显示全部会话",
			"header.archiveHide": "隐藏归档会话",
			"header.laneFilter": "泳道筛选",
			"header.laneAll": "全选",
			"header.laneNone": "全不选",
			"header.laneOnlyCurrent": "只看当前工作区",
			"header.refresh": "刷新",
			"stats.unreadable": "{count} 个日志不可读",
			"zoom.out": "缩小（10%）",
			"zoom.in": "放大（10%）",
			"zoom.fit": "100%（原始比例）",
			"zoom.reset": "点击复位 100%",
			"canvas.hint": "空白处按住拖拽 = 平移 · 滚轮 = 上下滚动 · 画布缩放用左上角 −/+",
			"legend.action.dragNode": "拖到另一节点",
			"legend.action.doubleClick": "双击",
			"legend.meaning.manual": "衔接",
			"legend.meaning.switchSession": "打开",
			"legend.line.handoff": "handoff 链",
			"legend.line.branch": "分支",
			"legend.line.manual": "手工衔接",
			"legend.frame.awaitParent": "待接前驱",
			"legend.frame.awaitChild": "待接后继",
			"legend.frame.archived": "归档",
			"legend.tag.handoff": "调用过 handoff 或种子开场",
			"detail.hint": "外框滚轮 = 上一轮/下一轮 · 点轮次条直达 · 内容框内滚轮翻看对话",
			"detail.open": "切换到该会话",
			"detail.rangeHint": "创建 → 最近活动",
			"detail.forkInferred": "血缘推断",
			"detail.forkSourceMissing": "来源缺失",
			"lineage.fromMissing": "父会话 {id} 不在当前视图",
			"link.disconnect": "✕",
			"link.disconnectTitle": "断开该手工衔接",
			"handoff.count": "handoff × {count}",
			"handoff.seeded": "种子开场",
			"handoff.hit": "第 {turn} 轮 · {time} · #{seq}",
			"handoff.timeUnknown": "时间未知",
			"turns.position": "第 {turn} / {total} 轮",
			"turns.jump": "定位",
			"turns.jumpTitle": "在右侧对话中定位到该轮",
			"turns.suffixHandoff": "· handoff 调用轮",
			"turns.suffixFirst": "· 首轮",
			"turns.suffixLast": "· 末轮",
			"turns.none": "无对话轮",
			"turns.barTitle": "第 {turn} 轮",
			"turns.contentHint": "滚轮上下滑动翻看对话内容",
			"turns.roleUser": "用户",
			"turns.roleAssistant": "助手",
			"turns.noUserText": "（无文本）",
			"turns.noAssistantReply": "（本轮暂无助手回复）",
			"turns.reasoningPrefix": "[推理] ",
			"turns.truncated": "…（已截断）",
			"markdown.copy": "复制",
			"markdown.copied": "已复制",
			"markdown.codeBlock": "代码块",
			"markdown.wrap": "换行",
			"markdown.unwrap": "不换行",
			"markdown.footnotes": "脚注"
		};
		/** 语种 → 词典（client 注册用；zh 键位为基准）。 */
		const dictionaries = {
			zh,
			en: {
				"panel.title": "Session Timeline",
				"fmt.count": "({count})",
				"guide.description": "Fishbone timeline: sessions alternate above and below a central axis by creation time, joined by handoff/branch lineage links; switch to the all-workspaces canvas (one timeline per workspace on a shared scale), drag nodes to link manually, double-click to open a session",
				"state.loading": "Loading…",
				"state.renderFailed": "Session Timeline failed to render: {message}",
				"error.noSession": "No current session located; cannot determine the workspace",
				"error.requestFailed": "Request failed (network/service unreachable); polling retries automatically",
				"error.opFailed": "Operation failed",
				"error.workspaceMissing": "Workspace {bucket} does not exist (bucket unreadable)",
				"error.locateMissing": "Missing session/workspace parameter",
				"error.sessionNotInBucket": "Session {session} is not in any workspace bucket",
				"error.crossWorkspace": "The two sessions belong to different workspaces; a manual link cannot cross workspaces",
				"error.emptyFromTo": "from/to must not be empty",
				"error.linkSelf": "Cannot link a session to itself",
				"error.notTopLevel": "from/to must be top-level sessions of this workspace",
				"error.nativeHandoff": "These two sessions already have native lineage (handoff); no manual link needed",
				"error.nativeBranch": "These two sessions already have native lineage (branch); no manual link needed",
				"error.storageRead": "Failed to read the link storage file: {message}",
				"error.storageWrite": "Failed to write the link storage file: {message}",
				"error.sessionMissing": "Session {session} does not exist",
				"error.decodeFailed": "Failed to decode the session log",
				"error.parseFailed": "Parsing failed: {message}",
				"error.unknownEndpoint": "Unknown endpoint {method} {path}",
				"msg.linked": "Manual link created",
				"msg.linkDuplicate": "Manual link already exists",
				"msg.unlinked": "Manual link removed",
				"node.hint": "Double-click to switch to this session; drag onto another node to link manually",
				"node.untitled": "(untitled)",
				"node.tag.externalParent": "External parent",
				"header.workspaceTitle": "Which workspace timeline to view",
				"header.workspaceCurrent": "Current session workspace",
				"header.workspaceAll": "All workspaces",
				"header.orderTitle": "Time direction",
				"header.orderOldNew": "Oldest first",
				"header.orderNewOld": "Newest first",
				"header.sortTitle": "Sort by",
				"header.sortCreated": "Creation time",
				"header.sortLast": "Last activity",
				"header.archiveTitle": "Archived session display",
				"header.archiveShowAll": "Show all sessions",
				"header.archiveHide": "Hide archived sessions",
				"header.laneFilter": "Lane filter",
				"header.laneAll": "All",
				"header.laneNone": "None",
				"header.laneOnlyCurrent": "Only current workspace",
				"header.refresh": "Refresh",
				"stats.unreadable": "{count} unreadable logs",
				"zoom.out": "Zoom out (10%)",
				"zoom.in": "Zoom in (10%)",
				"zoom.fit": "100% (actual size)",
				"zoom.reset": "Click to reset to 100%",
				"canvas.hint": "Drag empty space to pan · Wheel scrolls up/down · Zoom with −/+ at top left",
				"legend.action.dragNode": "drag onto a node",
				"legend.action.doubleClick": "Double-click",
				"legend.meaning.manual": "link",
				"legend.meaning.switchSession": "open",
				"legend.line.handoff": "handoff chain",
				"legend.line.branch": "branch",
				"legend.line.manual": "manual link",
				"legend.frame.awaitParent": "awaiting parent",
				"legend.frame.awaitChild": "awaiting child",
				"legend.frame.archived": "archived",
				"legend.tag.handoff": "handoff skill called or seeded opening",
				"detail.hint": "Wheel on the frame = previous/next turn · click a turn bar to jump · wheel inside scrolls the conversation",
				"detail.open": "Switch to this session",
				"detail.rangeHint": "created → last activity",
				"detail.forkInferred": "lineage inferred",
				"detail.forkSourceMissing": "source missing",
				"lineage.fromMissing": "parent {id} not in the current view",
				"link.disconnect": "✕",
				"link.disconnectTitle": "Remove this manual link",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "seeded opening",
				"handoff.hit": "turn {turn} · {time} · #{seq}",
				"handoff.timeUnknown": "time unknown",
				"turns.position": "Turn {turn} / {total}",
				"turns.jump": "Locate",
				"turns.jumpTitle": "Locate this turn in the conversation",
				"turns.suffixHandoff": " · handoff turn",
				"turns.suffixFirst": " · first turn",
				"turns.suffixLast": " · last turn",
				"turns.none": "No conversation turns",
				"turns.barTitle": "Turn {turn}",
				"turns.contentHint": "Scroll up/down to page through the conversation",
				"turns.roleUser": "User",
				"turns.roleAssistant": "Assistant",
				"turns.noUserText": "(no text)",
				"turns.noAssistantReply": "(no assistant reply this turn)",
				"turns.reasoningPrefix": "[reasoning] ",
				"turns.truncated": "… (truncated)",
				"markdown.copy": "Copy",
				"markdown.copied": "Copied",
				"markdown.codeBlock": "Code block",
				"markdown.wrap": "Wrap",
				"markdown.unwrap": "No wrap",
				"markdown.footnotes": "Footnotes"
			},
			ja: {
				"panel.title": "セッションタイムライン",
				"fmt.count": "（{count}）",
				"guide.description": "魚骨タイムライン：セッションを作成時刻順に主軸の上下へ交互に配置し、handoff／分岐の血縁線で接続。「すべてのワークスペース」でワークスペース別の複数タイムライン（共通スケール）に切替、ノードのドラッグで手動接続、ダブルクリックでセッション切替",
				"state.loading": "読み込み中…",
				"state.renderFailed": "セッションタイムラインの描画に失敗しました：{message}",
				"error.noSession": "現在のセッションを特定できず、ワークスペースを確定できません",
				"error.requestFailed": "リクエスト失敗（ネットワーク／サービス到達不可）。ポーリングで自動再試行します",
				"error.opFailed": "操作に失敗しました",
				"error.workspaceMissing": "ワークスペース {bucket} が存在しません（バケット読取不可）",
				"error.locateMissing": "session／workspace パラメータが不足しています",
				"error.sessionNotInBucket": "セッション {session} はどのワークスペースバケットにもありません",
				"error.crossWorkspace": "2 つのセッションは異なるワークスペースに属しているため、手動接続をワークスペース間で付けられません",
				"error.emptyFromTo": "from／to は空にできません",
				"error.linkSelf": "自分自身へは接続できません",
				"error.notTopLevel": "from／to はこのワークスペースのトップレベルセッションである必要があります",
				"error.nativeHandoff": "両セッション間には既にネイティブ血縁（handoff）があるため、手動接続は不要です",
				"error.nativeBranch": "両セッション間には既にネイティブ血縁（分岐）があるため、手動接続は不要です",
				"error.storageRead": "接続ストレージファイルの読取に失敗：{message}",
				"error.storageWrite": "接続ストレージファイルの書込に失敗：{message}",
				"error.sessionMissing": "セッション {session} は存在しません",
				"error.decodeFailed": "セッションログのデコードに失敗しました",
				"error.parseFailed": "解析に失敗：{message}",
				"error.unknownEndpoint": "不明なエンドポイント {method} {path}",
				"msg.linked": "手動接続を確立しました",
				"msg.linkDuplicate": "手動接続は既に存在します",
				"msg.unlinked": "手動接続を解除しました",
				"node.hint": "ダブルクリックでこのセッションへ切替。別ノードへドラッグで手動接続",
				"node.untitled": "（無題）",
				"node.tag.externalParent": "外部親",
				"header.workspaceTitle": "どのワークスペースのタイムラインを表示するか",
				"header.workspaceCurrent": "現在のセッションのワークスペース",
				"header.workspaceAll": "すべてのワークスペース",
				"header.orderTitle": "時間方向",
				"header.orderOldNew": "古い順",
				"header.orderNewOld": "新しい順",
				"header.sortTitle": "並び順",
				"header.sortCreated": "作成時刻",
				"header.sortLast": "最終活動",
				"header.archiveTitle": "アーカイブセッションの表示",
				"header.archiveShowAll": "すべてのセッションを表示",
				"header.archiveHide": "アーカイブを非表示",
				"header.laneFilter": "レーンフィルター",
				"header.laneAll": "すべて選択",
				"header.laneNone": "すべて選択解除",
				"header.laneOnlyCurrent": "現在のワークスペースのみ",
				"header.refresh": "更新",
				"stats.unreadable": "{count} 件のログが読取不可",
				"zoom.out": "縮小（10%）",
				"zoom.in": "拡大（10%）",
				"zoom.fit": "100%（等倍）",
				"zoom.reset": "クリックで 100% に戻す",
				"canvas.hint": "空白部ドラッグ = パン · ホイール = 上下スクロール · 拡大縮小は左上の −/+",
				"legend.action.dragNode": "ノードへドラッグ",
				"legend.action.doubleClick": "ダブルクリック",
				"legend.meaning.manual": "接続",
				"legend.meaning.switchSession": "開く",
				"legend.line.handoff": "handoff 連鎖",
				"legend.line.branch": "分岐",
				"legend.line.manual": "手動接続",
				"legend.frame.awaitParent": "親待ち",
				"legend.frame.awaitChild": "子待ち",
				"legend.frame.archived": "アーカイブ",
				"legend.tag.handoff": "handoff skill 呼び出しまたはシード開始",
				"detail.hint": "外枠ホイール = 前／次のターン · ターンバーをクリックで直接移動 · 内容枠内ホイールで会話を閲覧",
				"detail.open": "このセッションへ切替",
				"detail.rangeHint": "作成 → 最終活動",
				"detail.forkInferred": "血縁は推定",
				"detail.forkSourceMissing": "ソース不明",
				"lineage.fromMissing": "親セッション {id} は現在のビューにない",
				"link.disconnect": "✕",
				"link.disconnectTitle": "この手動接続を解除",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "シード開始",
				"handoff.hit": "第 {turn} ターン · {time} · #{seq}",
				"handoff.timeUnknown": "時刻不明",
				"turns.position": "第 {turn} ／ {total} ターン",
				"turns.jump": "移動",
				"turns.jumpTitle": "会話内のこのターンへ移動",
				"turns.suffixHandoff": "· handoff 呼び出しターン",
				"turns.suffixFirst": "· 最初のターン",
				"turns.suffixLast": "· 最後のターン",
				"turns.none": "会話ターンなし",
				"turns.barTitle": "第 {turn} ターン",
				"turns.contentHint": "ホイールの上下で会話内容を閲覧",
				"turns.roleUser": "ユーザー",
				"turns.roleAssistant": "アシスタント",
				"turns.noUserText": "（テキストなし）",
				"turns.noAssistantReply": "（このターンのアシスタント返信なし）",
				"turns.reasoningPrefix": "[推論] ",
				"turns.truncated": "…（切り捨て）",
				"markdown.copy": "コピー",
				"markdown.copied": "コピー済み",
				"markdown.codeBlock": "コードブロック",
				"markdown.wrap": "折り返し",
				"markdown.unwrap": "折り返さない",
				"markdown.footnotes": "脚注"
			},
			es: {
				"panel.title": "Línea temporal de sesiones",
				"fmt.count": " ({count})",
				"guide.description": "Línea temporal en espina de pescado: las sesiones se alternan sobre y bajo un eje central por fecha de creación, unidas por enlaces de linaje handoff/ramificación; cambia al lienzo de todos los espacios de trabajo (una línea temporal por espacio de trabajo con escala compartida), arrastra nodos para enlazar a mano y haz doble clic para abrir una sesión",
				"state.loading": "Cargando…",
				"state.renderFailed": "La línea temporal de sesiones no se pudo dibujar: {message}",
				"error.noSession": "No hay sesión actual localizada; no se puede determinar el espacio de trabajo",
				"error.requestFailed": "Solicitud fallida (red/servicio inaccesible); el sondeo reintenta automáticamente",
				"error.opFailed": "La operación falló",
				"error.workspaceMissing": "El espacio de trabajo {bucket} no existe (depósito ilegible)",
				"error.locateMissing": "Falta el parámetro session/workspace",
				"error.sessionNotInBucket": "La sesión {session} no está en ningún depósito de espacio de trabajo",
				"error.crossWorkspace": "Las dos sesiones pertenecen a espacios de trabajo distintos; el enlace manual no puede cruzar espacios de trabajo",
				"error.emptyFromTo": "from/to no pueden estar vacíos",
				"error.linkSelf": "No se puede enlazar una sesión consigo misma",
				"error.notTopLevel": "from/to deben ser sesiones de nivel superior de este espacio de trabajo",
				"error.nativeHandoff": "Estas dos sesiones ya tienen linaje nativo (handoff); no hace falta un enlace manual",
				"error.nativeBranch": "Estas dos sesiones ya tienen linaje nativo (ramificación); no hace falta un enlace manual",
				"error.storageRead": "Error al leer el archivo de enlaces: {message}",
				"error.storageWrite": "Error al escribir el archivo de enlaces: {message}",
				"error.sessionMissing": "La sesión {session} no existe",
				"error.decodeFailed": "Error al decodificar el registro de la sesión",
				"error.parseFailed": "Error de análisis: {message}",
				"error.unknownEndpoint": "Endpoint desconocido {method} {path}",
				"msg.linked": "Enlace manual creado",
				"msg.linkDuplicate": "El enlace manual ya existe",
				"msg.unlinked": "Enlace manual eliminado",
				"node.hint": "Doble clic para cambiar a esta sesión; arrastra a otro nodo para enlazar a mano",
				"node.untitled": "(sin título)",
				"node.tag.externalParent": "Padre externo",
				"header.workspaceTitle": "Qué línea temporal de espacio de trabajo ver",
				"header.workspaceCurrent": "Espacio de trabajo de la sesión actual",
				"header.workspaceAll": "Todos los espacios de trabajo",
				"header.orderTitle": "Dirección del tiempo",
				"header.orderOldNew": "Del más antiguo al más nuevo",
				"header.orderNewOld": "Del más nuevo al más antiguo",
				"header.sortTitle": "Ordenar por",
				"header.sortCreated": "Fecha de creación",
				"header.sortLast": "Última actividad",
				"header.archiveTitle": "Visualización de sesiones archivadas",
				"header.archiveShowAll": "Mostrar todas las sesiones",
				"header.archiveHide": "Ocultar sesiones archivadas",
				"header.laneFilter": "Filtro de líneas",
				"header.laneAll": "Todas",
				"header.laneNone": "Ninguna",
				"header.laneOnlyCurrent": "Solo el espacio de trabajo actual",
				"header.refresh": "Actualizar",
				"stats.unreadable": "{count} registros ilegibles",
				"zoom.out": "Reducir (10%)",
				"zoom.in": "Ampliar (10%)",
				"zoom.fit": "100% (tamaño real)",
				"zoom.reset": "Clic para volver al 100%",
				"canvas.hint": "Arrastra el espacio vacío para desplazar · La rueda hace scroll · Zoom con −/+ arriba a la izquierda",
				"legend.action.dragNode": "arrastra a un nodo",
				"legend.action.doubleClick": "Doble clic",
				"legend.meaning.manual": "enlazar",
				"legend.meaning.switchSession": "abrir",
				"legend.line.handoff": "cadena handoff",
				"legend.line.branch": "rama",
				"legend.line.manual": "enlace manual",
				"legend.frame.awaitParent": "esperando padre",
				"legend.frame.awaitChild": "esperando hijo",
				"legend.frame.archived": "archivada",
				"legend.tag.handoff": "skill handoff llamada o inicio con semilla",
				"detail.hint": "Rueda en el marco = turno anterior/siguiente · clic en una barra para saltar · rueda dentro para leer la conversación",
				"detail.open": "Cambiar a esta sesión",
				"detail.rangeHint": "creación → última actividad",
				"detail.forkInferred": "linaje inferido",
				"detail.forkSourceMissing": "origen ausente",
				"lineage.fromMissing": "la sesión padre {id} no está en la vista",
				"link.disconnect": "✕",
				"link.disconnectTitle": "Quitar este enlace manual",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "inicio con semilla",
				"handoff.hit": "turno {turn} · {time} · #{seq}",
				"handoff.timeUnknown": "hora desconocida",
				"turns.position": "Turno {turn} / {total}",
				"turns.jump": "Ir",
				"turns.jumpTitle": "Ir a este turno en la conversación",
				"turns.suffixHandoff": " · turno handoff",
				"turns.suffixFirst": " · primer turno",
				"turns.suffixLast": " · último turno",
				"turns.none": "Sin turnos de conversación",
				"turns.barTitle": "Turno {turn}",
				"turns.contentHint": "Rueda arriba/abajo para hojear la conversación",
				"turns.roleUser": "Usuario",
				"turns.roleAssistant": "Asistente",
				"turns.noUserText": "(sin texto)",
				"turns.noAssistantReply": "(sin respuesta del asistente en este turno)",
				"turns.reasoningPrefix": "[razonamiento] ",
				"turns.truncated": "… (recortado)",
				"markdown.copy": "Copiar",
				"markdown.copied": "Copiado",
				"markdown.codeBlock": "Bloque de código",
				"markdown.wrap": "Ajustar",
				"markdown.unwrap": "Sin ajuste",
				"markdown.footnotes": "Notas al pie"
			},
			fr: {
				"panel.title": "Chronologie des sessions",
				"fmt.count": " ({count})",
				"guide.description": "Chronologie en arête de poisson : les sessions se répartissent au-dessus et en dessous de l’axe central par date de création, reliées par les liens de filiation handoff/branche ; basculez vers la toile de tous les espaces de travail (une chronologie par espace de travail sur une échelle partagée), faites glisser les nœuds pour lier manuellement, double-cliquez pour ouvrir une session",
				"state.loading": "Chargement…",
				"state.renderFailed": "Échec du rendu de la chronologie des sessions : {message}",
				"error.noSession": "Aucune session courante localisée ; impossible de déterminer l’espace de travail",
				"error.requestFailed": "Requête échouée (réseau/service injoignable) ; la relance automatique continue",
				"error.opFailed": "L’opération a échoué",
				"error.workspaceMissing": "L’espace de travail {bucket} n’existe pas (conteneur illisible)",
				"error.locateMissing": "Paramètre session/workspace manquant",
				"error.sessionNotInBucket": "La session {session} n’est dans aucun conteneur d’espace de travail",
				"error.crossWorkspace": "Les deux sessions appartiennent à des espaces de travail différents ; un lien manuel ne peut pas traverser les espaces de travail",
				"error.emptyFromTo": "from/to ne doivent pas être vides",
				"error.linkSelf": "Impossible de lier une session à elle-même",
				"error.notTopLevel": "from/to doivent être des sessions de premier niveau de cet espace de travail",
				"error.nativeHandoff": "Ces deux sessions ont déjà un lien natif (handoff) ; aucun lien manuel nécessaire",
				"error.nativeBranch": "Ces deux sessions ont déjà un lien natif (branche) ; aucun lien manuel nécessaire",
				"error.storageRead": "Échec de lecture du fichier de liens : {message}",
				"error.storageWrite": "Échec d’écriture du fichier de liens : {message}",
				"error.sessionMissing": "La session {session} n’existe pas",
				"error.decodeFailed": "Échec du décodage du journal de session",
				"error.parseFailed": "Échec de l’analyse : {message}",
				"error.unknownEndpoint": "Point de terminaison inconnu {method} {path}",
				"msg.linked": "Lien manuel créé",
				"msg.linkDuplicate": "Le lien manuel existe déjà",
				"msg.unlinked": "Lien manuel supprimé",
				"node.hint": "Double-clic pour passer à cette session ; glissez vers un autre nœud pour lier manuellement",
				"node.untitled": "(sans titre)",
				"node.tag.externalParent": "Parent externe",
				"header.workspaceTitle": "Quelle chronologie d’espace de travail afficher",
				"header.workspaceCurrent": "Espace de travail de la session courante",
				"header.workspaceAll": "Tous les espaces de travail",
				"header.orderTitle": "Sens du temps",
				"header.orderOldNew": "Du plus ancien au plus récent",
				"header.orderNewOld": "Du plus récent au plus ancien",
				"header.sortTitle": "Trier par",
				"header.sortCreated": "Date de création",
				"header.sortLast": "Dernière activité",
				"header.archiveTitle": "Affichage des sessions archivées",
				"header.archiveShowAll": "Afficher toutes les sessions",
				"header.archiveHide": "Masquer les sessions archivées",
				"header.laneFilter": "Filtre de lignes",
				"header.laneAll": "Toutes",
				"header.laneNone": "Aucune",
				"header.laneOnlyCurrent": "Seulement l’espace de travail courant",
				"header.refresh": "Actualiser",
				"stats.unreadable": "{count} journaux illisibles",
				"zoom.out": "Réduire (10 %)",
				"zoom.in": "Agrandir (10 %)",
				"zoom.fit": "100 % (taille réelle)",
				"zoom.reset": "Cliquer pour revenir à 100 %",
				"canvas.hint": "Glisser le vide pour déplacer · Molette = défilement vertical · Zoom via −/+ en haut à gauche",
				"legend.action.dragNode": "glisser sur un nœud",
				"legend.action.doubleClick": "Double-clic",
				"legend.meaning.manual": "lier",
				"legend.meaning.switchSession": "ouvrir",
				"legend.line.handoff": "chaîne handoff",
				"legend.line.branch": "branche",
				"legend.line.manual": "lien manuel",
				"legend.frame.awaitParent": "parent attendu",
				"legend.frame.awaitChild": "enfant attendu",
				"legend.frame.archived": "archivée",
				"legend.tag.handoff": "skill handoff appelé ou départ par graine",
				"detail.hint": "Molette sur le cadre = tour précédent/suivant · cliquez une barre pour y aller · molette intérieure pour lire la conversation",
				"detail.open": "Passer à cette session",
				"detail.rangeHint": "création → dernière activité",
				"detail.forkInferred": "lignée déduite",
				"detail.forkSourceMissing": "source introuvable",
				"lineage.fromMissing": "la session parente {id} n’est pas dans la vue",
				"link.disconnect": "✕",
				"link.disconnectTitle": "Supprimer ce lien manuel",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "départ par graine",
				"handoff.hit": "tour {turn} · {time} · nº {seq}",
				"handoff.timeUnknown": "heure inconnue",
				"turns.position": "Tour {turn} / {total}",
				"turns.jump": "Aller",
				"turns.jumpTitle": "Aller à ce tour dans la conversation",
				"turns.suffixHandoff": " · tour handoff",
				"turns.suffixFirst": " · premier tour",
				"turns.suffixLast": " · dernier tour",
				"turns.none": "Aucun tour de conversation",
				"turns.barTitle": "Tour {turn}",
				"turns.contentHint": "Molette haut/bas pour feuilleter la conversation",
				"turns.roleUser": "Utilisateur",
				"turns.roleAssistant": "Assistant",
				"turns.noUserText": "(aucun texte)",
				"turns.noAssistantReply": "(pas de réponse de l’assistant à ce tour)",
				"turns.reasoningPrefix": "[raisonnement] ",
				"turns.truncated": "… (tronqué)",
				"markdown.copy": "Copier",
				"markdown.copied": "Copié",
				"markdown.codeBlock": "Bloc de code",
				"markdown.wrap": "Retour à la ligne",
				"markdown.unwrap": "Sans retour",
				"markdown.footnotes": "Notes de bas de page"
			},
			de: {
				"panel.title": "Sitzungs-Timeline",
				"fmt.count": " ({count})",
				"guide.description": "Grätendiagramm: Sitzungen liegen abwechselnd ober- und unterhalb der Mittelachse, geordnet nach Erstellungszeit, verbunden durch Handoff-/Branch-Herkunftslinien; zur Alle-Arbeitsbereiche-Leinwand wechseln (eine Timeline pro Arbeitsbereich auf gemeinsamer Skala), Knoten zum manuellen Verknüpfen ziehen, Doppelklick öffnet eine Sitzung",
				"state.loading": "Wird geladen…",
				"state.renderFailed": "Sitzungs-Timeline konnte nicht gerendert werden: {message}",
				"error.noSession": "Keine aktuelle Sitzung ermittelbar; Arbeitsbereich kann nicht bestimmt werden",
				"error.requestFailed": "Anfrage fehlgeschlagen (Netzwerk/Dienst nicht erreichbar); Abfrage wiederholt sich automatisch",
				"error.opFailed": "Vorgang fehlgeschlagen",
				"error.workspaceMissing": "Arbeitsbereich {bucket} existiert nicht (Bucket nicht lesbar)",
				"error.locateMissing": "Parameter session/workspace fehlt",
				"error.sessionNotInBucket": "Sitzung {session} liegt in keinem Arbeitsbereich-Bucket",
				"error.crossWorkspace": "Die beiden Sitzungen gehören zu verschiedenen Arbeitsbereichen; eine manuelle Verknüpfung kann Arbeitsbereiche nicht überschreiten",
				"error.emptyFromTo": "from/to dürfen nicht leer sein",
				"error.linkSelf": "Eine Sitzung kann nicht mit sich selbst verknüpft werden",
				"error.notTopLevel": "from/to müssen Sitzungen der obersten Ebene dieses Arbeitsbereichs sein",
				"error.nativeHandoff": "Diese beiden Sitzungen haben bereits native Herkunft (Handoff); keine manuelle Verknüpfung nötig",
				"error.nativeBranch": "Diese beiden Sitzungen haben bereits native Herkunft (Branch); keine manuelle Verknüpfung nötig",
				"error.storageRead": "Verknüpfungsdatei konnte nicht gelesen werden: {message}",
				"error.storageWrite": "Verknüpfungsdatei konnte nicht geschrieben werden: {message}",
				"error.sessionMissing": "Sitzung {session} existiert nicht",
				"error.decodeFailed": "Sitzungsprotokoll konnte nicht dekodiert werden",
				"error.parseFailed": "Auswertung fehlgeschlagen: {message}",
				"error.unknownEndpoint": "Unbekannter Endpunkt {method} {path}",
				"msg.linked": "Manuelle Verknüpfung erstellt",
				"msg.linkDuplicate": "Manuelle Verknüpfung existiert bereits",
				"msg.unlinked": "Manuelle Verknüpfung gelöst",
				"node.hint": "Doppelklick wechselt zu dieser Sitzung; auf einen anderen Knoten ziehen erstellt eine manuelle Verknüpfung",
				"node.untitled": "(ohne Titel)",
				"node.tag.externalParent": "Externes Elternteil",
				"header.workspaceTitle": "Welche Arbeitsbereich-Timeline angezeigt wird",
				"header.workspaceCurrent": "Arbeitsbereich der aktuellen Sitzung",
				"header.workspaceAll": "Alle Arbeitsbereiche",
				"header.orderTitle": "Zeitrichtung",
				"header.orderOldNew": "Älteste zuerst",
				"header.orderNewOld": "Neueste zuerst",
				"header.sortTitle": "Sortieren nach",
				"header.sortCreated": "Erstellungszeit",
				"header.sortLast": "Letzte Aktivität",
				"header.archiveTitle": "Anzeige archivierter Sitzungen",
				"header.archiveShowAll": "Alle Sitzungen anzeigen",
				"header.archiveHide": "Archivierte Sitzungen ausblenden",
				"header.laneFilter": "Spurfilter",
				"header.laneAll": "Alle",
				"header.laneNone": "Keine",
				"header.laneOnlyCurrent": "Nur aktueller Arbeitsbereich",
				"header.refresh": "Aktualisieren",
				"stats.unreadable": "{count} Protokolle nicht lesbar",
				"zoom.out": "Verkleinern (10 %)",
				"zoom.in": "Vergrößern (10 %)",
				"zoom.fit": "100 % (Originalgröße)",
				"zoom.reset": "Klicken setzt auf 100 % zurück",
				"canvas.hint": "Leere Stelle ziehen = verschieben · Rad = auf/ab scrollen · Zoom nur über −/+ oben links",
				"legend.action.dragNode": "auf einen Knoten ziehen",
				"legend.action.doubleClick": "Doppelklick",
				"legend.meaning.manual": "verknüpfen",
				"legend.meaning.switchSession": "öffnen",
				"legend.line.handoff": "Handoff-Kette",
				"legend.line.branch": "Zweig",
				"legend.line.manual": "manuelle Verknüpfung",
				"legend.frame.awaitParent": "wartet auf Eltern",
				"legend.frame.awaitChild": "wartet auf Nachfolger",
				"legend.frame.archived": "archiviert",
				"legend.tag.handoff": "Handoff-Skill aufgerufen oder Seed-Start",
				"detail.hint": "Rad am Rahmen = vorheriger/nächster Zug · Zugbalken anklicken zum Springen · Rad im Inhaltsrahmen blättert die Unterhaltung",
				"detail.open": "Zu dieser Sitzung wechseln",
				"detail.rangeHint": "Erstellung → letzte Aktivität",
				"detail.forkInferred": "Herkunft abgeleitet",
				"detail.forkSourceMissing": "Quelle fehlt",
				"lineage.fromMissing": "Elternsitzung {id} nicht in der Ansicht",
				"link.disconnect": "✕",
				"link.disconnectTitle": "Diese manuelle Verknüpfung lösen",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "Seed-Start",
				"handoff.hit": "Zug {turn} · {time} · Nr. {seq}",
				"handoff.timeUnknown": "Zeit unbekannt",
				"turns.position": "Zug {turn} / {total}",
				"turns.jump": "Springen",
				"turns.jumpTitle": "Zu diesem Turn im Gespräch springen",
				"turns.suffixHandoff": " · Handoff-Zug",
				"turns.suffixFirst": " · erster Zug",
				"turns.suffixLast": " · letzter Zug",
				"turns.none": "Keine Gesprächszüge",
				"turns.barTitle": "Zug {turn}",
				"turns.contentHint": "Mit dem Rad auf/ab durch die Unterhaltung blättern",
				"turns.roleUser": "Nutzer",
				"turns.roleAssistant": "Assistent",
				"turns.noUserText": "(kein Text)",
				"turns.noAssistantReply": "(keine Assistenten-Antwort in diesem Zug)",
				"turns.reasoningPrefix": "[Überlegung] ",
				"turns.truncated": "… (gekürzt)",
				"markdown.copy": "Kopieren",
				"markdown.copied": "Kopiert",
				"markdown.codeBlock": "Codeblock",
				"markdown.wrap": "Umbruch",
				"markdown.unwrap": "Kein Umbruch",
				"markdown.footnotes": "Fußnoten"
			},
			ru: {
				"panel.title": "Хронология сессий",
				"fmt.count": " ({count})",
				"guide.description": "Диаграмма «рыбья кость»: сессии чередуются выше и ниже центральной оси по времени создания, связаны линиями происхождения handoff/ветвления; переключайтесь на полотно всех рабочих пространств (по одной хронологии на рабочее пространство с общей шкалой), перетаскивайте узлы для ручной связи, двойной щелчок открывает сессию",
				"state.loading": "Загрузка…",
				"state.renderFailed": "Не удалось отрисовать хронологию сессий: {message}",
				"error.noSession": "Текущая сессия не определена; невозможно определить рабочее пространство",
				"error.requestFailed": "Запрос не удался (сеть/сервис недоступны); опрос повторится автоматически",
				"error.opFailed": "Операция не удалась",
				"error.workspaceMissing": "Рабочее пространство {bucket} не существует (контейнер не читается)",
				"error.locateMissing": "Отсутствует параметр session/workspace",
				"error.sessionNotInBucket": "Сессия {session} не найдена ни в одном контейнере рабочих пространств",
				"error.crossWorkspace": "Две сессии принадлежат разным рабочим пространствам; ручная связь не может пересекать рабочие пространства",
				"error.emptyFromTo": "from/to не могут быть пустыми",
				"error.linkSelf": "Нельзя связать сессию с самой собой",
				"error.notTopLevel": "from/to должны быть сессиями верхнего уровня этого рабочего пространства",
				"error.nativeHandoff": "Между этими сессиями уже есть встроенная связь (handoff); ручная связь не нужна",
				"error.nativeBranch": "Между этими сессиями уже есть встроенная связь (ветвление); ручная связь не нужна",
				"error.storageRead": "Не удалось прочитать файл связей: {message}",
				"error.storageWrite": "Не удалось записать файл связей: {message}",
				"error.sessionMissing": "Сессия {session} не существует",
				"error.decodeFailed": "Не удалось декодировать журнал сессии",
				"error.parseFailed": "Ошибка разбора: {message}",
				"error.unknownEndpoint": "Неизвестная конечная точка {method} {path}",
				"msg.linked": "Ручная связь создана",
				"msg.linkDuplicate": "Ручная связь уже существует",
				"msg.unlinked": "Ручная связь удалена",
				"node.hint": "Двойной щелчок — перейти к этой сессии; перетащите на другой узел, чтобы связать вручную",
				"node.untitled": "(без названия)",
				"node.tag.externalParent": "Внешний родитель",
				"header.workspaceTitle": "Какую хронологию рабочего пространства показывать",
				"header.workspaceCurrent": "Рабочее пространство текущей сессии",
				"header.workspaceAll": "Все рабочие пространства",
				"header.orderTitle": "Направление времени",
				"header.orderOldNew": "Сначала старые",
				"header.orderNewOld": "Сначала новые",
				"header.sortTitle": "Сортировка",
				"header.sortCreated": "Время создания",
				"header.sortLast": "Последняя активность",
				"header.archiveTitle": "Показ архивных сессий",
				"header.archiveShowAll": "Показать все сессии",
				"header.archiveHide": "Скрыть архивные сессии",
				"header.laneFilter": "Фильтр линий",
				"header.laneAll": "Все",
				"header.laneNone": "Ни одной",
				"header.laneOnlyCurrent": "Только текущее пространство",
				"header.refresh": "Обновить",
				"stats.unreadable": "{count} журналов не читаются",
				"zoom.out": "Уменьшить (10 %)",
				"zoom.in": "Увеличить (10 %)",
				"zoom.fit": "100 % (исходный масштаб)",
				"zoom.reset": "Щелчок сбрасывает на 100 %",
				"canvas.hint": "Перетащите пустое место = сдвиг · Колесо = прокрутка · Масштаб только через −/+ слева вверху",
				"legend.action.dragNode": "перетащить на узел",
				"legend.action.doubleClick": "Двойной щелчок",
				"legend.meaning.manual": "связать",
				"legend.meaning.switchSession": "открыть",
				"legend.line.handoff": "цепочка handoff",
				"legend.line.branch": "ветвление",
				"legend.line.manual": "ручная связь",
				"legend.frame.awaitParent": "ждёт родителя",
				"legend.frame.awaitChild": "ждёт потомка",
				"legend.frame.archived": "в архиве",
				"legend.tag.handoff": "вызывался skill handoff или старт с затравки",
				"detail.hint": "Колесо на рамке = предыдущий/следующий ход · щелчок по полосе хода — переход · колесо внутри листает диалог",
				"detail.open": "Перейти к этой сессии",
				"detail.rangeHint": "создание → последняя активность",
				"detail.forkInferred": "происхождение выведено",
				"detail.forkSourceMissing": "источник не найден",
				"lineage.fromMissing": "родительская сессия {id} не в текущем виде",
				"link.disconnect": "✕",
				"link.disconnectTitle": "Убрать эту ручную связь",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "старт с затравки",
				"handoff.hit": "ход {turn} · {time} · #{seq}",
				"handoff.timeUnknown": "время неизвестно",
				"turns.position": "Ход {turn} / {total}",
				"turns.jump": "Перейти",
				"turns.jumpTitle": "Перейти к этому ходу в диалоге",
				"turns.suffixHandoff": " · ход handoff",
				"turns.suffixFirst": " · первый ход",
				"turns.suffixLast": " · последний ход",
				"turns.none": "Нет ходов диалога",
				"turns.barTitle": "Ход {turn}",
				"turns.contentHint": "Колесо вверх/вниз листает содержимое диалога",
				"turns.roleUser": "Пользователь",
				"turns.roleAssistant": "Ассистент",
				"turns.noUserText": "(нет текста)",
				"turns.noAssistantReply": "(нет ответа ассистента в этом ходе)",
				"turns.reasoningPrefix": "[рассуждение] ",
				"turns.truncated": "… (обрезано)",
				"markdown.copy": "Копировать",
				"markdown.copied": "Скопировано",
				"markdown.codeBlock": "Блок кода",
				"markdown.wrap": "Перенос",
				"markdown.unwrap": "Без переноса",
				"markdown.footnotes": "Сноски"
			},
			pt: {
				"panel.title": "Linha do tempo de sessões",
				"fmt.count": " ({count})",
				"guide.description": "Linha do tempo em espinha de peixe: as sessões se alternam acima e abaixo do eixo central pela hora de criação, unidas por vínculos de linhagem handoff/ramificação; mude para a tela de todos os espaços de trabalho (uma linha temporal por espaço de trabalho numa escala partilhada), arraste nós para vincular manualmente, clique duas vezes para abrir uma sessão",
				"state.loading": "Carregando…",
				"state.renderFailed": "Falha ao renderizar a linha do tempo de sessões: {message}",
				"error.noSession": "Nenhuma sessão atual localizada; não é possível determinar o espaço de trabalho",
				"error.requestFailed": "Falha na solicitação (rede/serviço inacessível); a sondagem tenta de novo automaticamente",
				"error.opFailed": "A operação falhou",
				"error.workspaceMissing": "O espaço de trabalho {bucket} não existe (repositório ilegível)",
				"error.locateMissing": "Falta o parâmetro session/workspace",
				"error.sessionNotInBucket": "A sessão {session} não está em nenhum repositório de espaço de trabalho",
				"error.crossWorkspace": "As duas sessões pertencem a espaços de trabalho diferentes; o link manual não pode cruzar espaços de trabalho",
				"error.emptyFromTo": "from/to não podem ficar vazios",
				"error.linkSelf": "Não é possível vincular uma sessão a ela mesma",
				"error.notTopLevel": "from/to devem ser sessões de nível superior deste espaço de trabalho",
				"error.nativeHandoff": "Estas duas sessões já têm linhagem nativa (handoff); não é preciso vínculo manual",
				"error.nativeBranch": "Estas duas sessões já têm linhagem nativa (ramificação); não é preciso vínculo manual",
				"error.storageRead": "Falha ao ler o arquivo de vínculos: {message}",
				"error.storageWrite": "Falha ao gravar o arquivo de vínculos: {message}",
				"error.sessionMissing": "A sessão {session} não existe",
				"error.decodeFailed": "Falha ao decodificar o registro da sessão",
				"error.parseFailed": "Falha na análise: {message}",
				"error.unknownEndpoint": "Endpoint desconhecido {method} {path}",
				"msg.linked": "Vínculo manual criado",
				"msg.linkDuplicate": "O vínculo manual já existe",
				"msg.unlinked": "Vínculo manual removido",
				"node.hint": "Clique duas vezes para trocar para esta sessão; arraste até outro nó para vincular manualmente",
				"node.untitled": "(sem título)",
				"node.tag.externalParent": "Pai externo",
				"header.workspaceTitle": "Qual linha do tempo de espaço de trabalho ver",
				"header.workspaceCurrent": "Espaço de trabalho da sessão atual",
				"header.workspaceAll": "Todos os espaços de trabalho",
				"header.orderTitle": "Direção do tempo",
				"header.orderOldNew": "Do mais antigo ao mais novo",
				"header.orderNewOld": "Do mais novo ao mais antigo",
				"header.sortTitle": "Ordenar por",
				"header.sortCreated": "Hora de criação",
				"header.sortLast": "Última atividade",
				"header.archiveTitle": "Exibição de sessões arquivadas",
				"header.archiveShowAll": "Mostrar todas as sessões",
				"header.archiveHide": "Ocultar sessões arquivadas",
				"header.laneFilter": "Filtro de linhas",
				"header.laneAll": "Todas",
				"header.laneNone": "Nenhuma",
				"header.laneOnlyCurrent": "Somente o espaço de trabalho atual",
				"header.refresh": "Atualizar",
				"stats.unreadable": "{count} registros ilegíveis",
				"zoom.out": "Reduzir (10%)",
				"zoom.in": "Ampliar (10%)",
				"zoom.fit": "100% (tamanho real)",
				"zoom.reset": "Clique para voltar a 100%",
				"canvas.hint": "Arraste o espaço vazio para mover · Roda = rolagem vertical · Zoom com −/+ no canto superior esquerdo",
				"legend.action.dragNode": "arraste até um nó",
				"legend.action.doubleClick": "Clique duplo",
				"legend.meaning.manual": "vincular",
				"legend.meaning.switchSession": "abrir",
				"legend.line.handoff": "cadeia handoff",
				"legend.line.branch": "ramificação",
				"legend.line.manual": "vínculo manual",
				"legend.frame.awaitParent": "aguardando pai",
				"legend.frame.awaitChild": "aguardando filho",
				"legend.frame.archived": "arquivada",
				"legend.tag.handoff": "skill handoff chamada ou início com semente",
				"detail.hint": "Roda na moldura = turno anterior/próximo · clique numa barra para ir direto · roda dentro rola a conversa",
				"detail.open": "Trocar para esta sessão",
				"detail.rangeHint": "criação → última atividade",
				"detail.forkInferred": "linhagem inferida",
				"detail.forkSourceMissing": "origem ausente",
				"lineage.fromMissing": "a sessão pai {id} não está na visão",
				"link.disconnect": "✕",
				"link.disconnectTitle": "Remover este vínculo manual",
				"handoff.count": "handoff × {count}",
				"handoff.seeded": "início com semente",
				"handoff.hit": "turno {turn} · {time} · nº {seq}",
				"handoff.timeUnknown": "hora desconhecida",
				"turns.position": "Turno {turn} / {total}",
				"turns.jump": "Ir",
				"turns.jumpTitle": "Ir para este turno na conversa",
				"turns.suffixHandoff": " · turno handoff",
				"turns.suffixFirst": " · primeiro turno",
				"turns.suffixLast": " · último turno",
				"turns.none": "Sem turnos de conversa",
				"turns.barTitle": "Turno {turn}",
				"turns.contentHint": "Rode para cima/baixo para folhear a conversa",
				"turns.roleUser": "Usuário",
				"turns.roleAssistant": "Assistente",
				"turns.noUserText": "(sem texto)",
				"turns.noAssistantReply": "(sem resposta do assistente neste turno)",
				"turns.reasoningPrefix": "[raciocínio] ",
				"turns.truncated": "… (truncado)",
				"markdown.copy": "Copiar",
				"markdown.copied": "Copiado",
				"markdown.codeBlock": "Bloco de código",
				"markdown.wrap": "Quebrar",
				"markdown.unwrap": "Sem quebra",
				"markdown.footnotes": "Notas de rodapé"
			}
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* @columforge/session-timeline — client: right sidebar tab (session timeline).
		* Fishbone timeline: central horizontal axis (arrow at the newest end) with
		* date ticks (YY-MM-DD at date changes, text on the side opposite the
		* spurs); sessions alternate above/below the axis left→right by creation
		* time, spurs connect vertically. A lineage chain = native edges
		* (handoff/branch) ∪ manual links; chain semantics (degrees, branch
		* detection, ⑂N badge, link display kind) are computed on the merged chain
		* (pure functions in ../geometry/lineage). Native links draw as solid bent
		* polylines (parent near-axis edge → axis-side channel → horizontal to the
		* child column → into the child's left side; blue = chained, purple =
		* fan-out); manual links draw as orange dashed polylines (same-side left
		* entry; with fan-out a native edge also displays as branch purple).
		* The "handoff" tag = handoff skill invoked (handoffUsed) or opened from a
		* handoff seed (isSeeded) — never by "handoff" text in the first message.
		* First-window handoff with no predecessor → purple frame (awaiting
		* predecessor); any handoff invocation with no successor → gold frame
		* (awaiting successor); the detail pane lists each invocation's
		* turn/time/message seq.
		* Copy discipline (layout-first): the layout carries the explanation — colors,
		* frames, arrows and glyphs name the states, so visible text stays limited to
		* the bare color key, two non-obvious interaction hints and pure data; group
		* labels and secondary descriptions are avoided (statuses keep hover tooltips).
		* Live strip (P2): when the inspected node IS the session the conversation shows
		* (props.sessionId — the tab is session-scoped), the panel subscribes to the
		* official turnOutline projection and re-reads /turns on observed growth, so a
		* running session's bars/handoff gold keep up without re-selecting the node.
		* Bar numbering stays on /turns (outline turns are turn/start-based and can
		* disagree with user-message turns on seeded openings). Locate (P3, every
		* session): the detail button switches the conversation to the inspected
		* node's session, pages history back through the turn's seq (outline
		* turn/start for the current session, /turns user-message seq otherwise) with
		* the official loadThrough, then scrolls to the chat navigation anchor
		* (TurnNavigationItem.anchorKey) for that turn. The assistant dialog renders
		* through the conversation's own MarkdownText so the panel reads like the
		* chat (user prompts stay plain text, as in the chat). Every step degrades to
		* a no-op when a service/projection/DOM anchor is absent; off-session the
		* panel keeps its panel-only behavior.
		* Double-click a node = switch to that session. The workspace select carries a
		* third mode "all workspaces" (the __global__ sentinel): one canvas of
		* per-workspace fishbone lanes stacked vertically on a shared ordinal column
		* scale — the same column index maps to the same x in every lane, so the
		* vertical date gridlines align across lanes (consistent ticks). Each node
		* still tags its workspace name; lineage (native + manual) never crosses
		* workspaces — the host resolves each dragged pair back to its own bucket and
		* rejects cross-workspace pairs with a localized error. The "follow current
		* session" option shows the current workspace's name instead of a generic
		* label.
		* Archive display (header select, two modes over the host-stamped `archived`
		* flag): "show all" (default = current behavior) draws archived session boxes
		* with dashed borders plus an archived tag; "hide archived" filters archived
		* sessions out before layout — spurs/edges touching hidden nodes drop out via
		* the existing layout-presence checks. The mode is panel-ephemeral (like
		* sort/direction) and shared with the tab-title count via a module store.
		* Three interaction channels stay independent: wheel = native browser
		* scrolling (Ctrl+wheel = browser zoom, neither intercepted); left-drag on
		* empty canvas = pan (dragging from a node still creates a manual link);
		* canvas zoom only via the top-left −/+ controls (±10%, anchored to the
		* viewport center; click the percentage to reset to 100%).
		* Build: tsdown → lib/client.js (ModuleLoader registration).
		* All visible copy routes through the Client locale service (dictionaries in
		* ./locales, 8 languages) and follows the language configured in DSH; host
		* API errors surface as stable code+params and render localized too.
		* ⚠️ client must export const inject; slots.register requires a name field.
		*/
		const React = require("react");
		const h = React.createElement;
		const { useEffect, useMemo, useRef, useState } = React;
		const P = require("@deepseek-ai/dsh-client-ui-primitives");
		/** Labels builder for one locale revision (identity-stable per t; the renderer memoizes on it). */
		function markdownLabelsOf(t) {
			return {
				code: {
					copyLabel: t("markdown.copy"),
					copiedLabel: t("markdown.copied"),
					toolbarLabels: {
						codeLabel: t("markdown.codeBlock"),
						wrapLabel: t("markdown.wrap"),
						unwrapLabel: t("markdown.unwrap")
					}
				},
				footnotes: t("markdown.footnotes")
			};
		}
		const POLL_MS = 8e3;
		const FETCH_TIMEOUT_MS = 15e3;
		const TAB_ID = "@columforge/session-timeline";
		const TAB_KIND = "session-timeline";
		/** All-workspaces canvas sentinel — mirrors the host's GLOBAL_BUCKET (/list|/link|/unlink accept it). */
		const GLOBAL_WORKSPACE = "__global__";
		/** {name} placeholder interpolation (same semantics as LocaleRuntime.translate). */
		function interpolate(template, params) {
			if (params === void 0) return template;
			return template.replace(/\{(\w+)\}/g, (match, name) => name in params ? String(params[name]) : match);
		}
		/** Module-level translate fallback: renders zh when the locale service is absent (pre-i18n behavior). */
		let T = (key, params) => interpolate(zh[key] ?? key, params);
		/** Host API error → copy in the active language: error.<code> first, then the raw error text, then a generic failure. */
		function errorText(t, r) {
			if (typeof r.code === "string" && r.code !== "") {
				const key = "error." + r.code;
				const text = t(key, r.params);
				if (text !== key) return text;
			}
			return r.error !== void 0 && r.error !== "" ? r.error : t("error.opFailed");
		}
		/** Notify every subscriber of a panel store (snapshot: a listener may unsubscribe from inside). */
		function notifyAll(listeners) {
			for (const listener of [...listeners]) listener();
		}
		/** Subscribe to a panel store; returns the unsubscribe function. */
		function subscribeTo(listeners, listener) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		}
		/** The panel's selected workspace (null = follow the current session's bucket). The tab title counts from this,
		*  kept consistent with the panel body; reset on unmount. */
		const viewBucket = {
			value: null,
			listeners: /* @__PURE__ */ new Set()
		};
		function setViewBucket(value) {
			if (viewBucket.value === value) return;
			viewBucket.value = value;
			notifyAll(viewBucket.listeners);
		}
		function subscribeViewBucket(listener) {
			return subscribeTo(viewBucket.listeners, listener);
		}
		const archiveView = {
			value: "all",
			listeners: /* @__PURE__ */ new Set()
		};
		function setArchiveView(value) {
			if (archiveView.value === value) return;
			archiveView.value = value;
			notifyAll(archiveView.listeners);
		}
		function subscribeArchiveView(listener) {
			return subscribeTo(archiveView.listeners, listener);
		}
		/** CSS.escape without assuming the API (attribute selectors carry session ids). */
		function cssEscape(value) {
			const escape = globalThis.CSS?.escape;
			if (typeof escape === "function") return escape(value);
			return value.replace(/["\\]/g, "\\$&");
		}
		/** The rendered conversation row for one chat anchor key, scoped to this session's scrollport
		*  when the DOM carries the scope attribute; falls back to the page's only scrollport. */
		function findChatRow(sessionId, anchorKey) {
			const scopes = [];
			for (const el of Array.from(document.querySelectorAll("[data-conversation-session=\"" + cssEscape(sessionId) + "\"] [data-conversation-scroll]"))) scopes.push(el);
			if (scopes.length === 0) for (const el of Array.from(document.querySelectorAll("[data-conversation-scroll]"))) scopes.push(el);
			for (const scope of scopes) for (const el of Array.from(scope.querySelectorAll("[data-chat-node-key]"))) if (el.dataset.chatNodeKey === anchorKey) return el;
			return null;
		}
		/** Scroll the conversation so `row` sits 12px below the scrollport top (jump landing). */
		function scrollRowIntoView(row) {
			const scrollport = row.closest("[data-conversation-scroll]");
			if (scrollport === null) {
				row.scrollIntoView({ block: "center" });
				return;
			}
			const spRect = scrollport.getBoundingClientRect();
			const rowRect = row.getBoundingClientRect();
			scrollport.scrollTop = scrollport.scrollTop + (rowRect.top - spRect.top) - 12;
		}
		const laneView = {
			value: {
				collapsed: /* @__PURE__ */ new Set(),
				hidden: /* @__PURE__ */ new Set()
			},
			listeners: /* @__PURE__ */ new Set()
		};
		function notifyLaneView() {
			notifyAll(laneView.listeners);
		}
		function subscribeLaneView(listener) {
			return subscribeTo(laneView.listeners, listener);
		}
		function toggleLaneSet(kind, laneId) {
			const next = new Set(laneView.value[kind]);
			if (next.has(laneId)) next.delete(laneId);
			else next.add(laneId);
			laneView.value = {
				...laneView.value,
				[kind]: next
			};
			notifyLaneView();
		}
		function setLanesHidden(ids) {
			laneView.value = {
				...laneView.value,
				hidden: ids
			};
			notifyLaneView();
		}
		/** UI-side panel height cap; geometry constants/pure functions live in ../geometry (unit-tested). */
		const TIMELINE_MAX_H = 420;
		const inject = [
			"slots",
			"sidebarRightTabs",
			"uiWorkspace",
			"locale"
		];
		const DIM = "var(--dsw-alias-text-secondary, rgba(128,128,128,0.85))";
		const ACCENT = "var(--dsw-alias-accent-primary, #3b82f6)";
		const BRANCH = "#8b5cf6";
		const MANUAL = "rgba(217,119,6,0.95)";
		const FIRST_NUDGE = "#8b5cf6";
		const LAST_NUDGE = "#e0a11a";
		const AXIS = "var(--dsw-alias-text-primary, rgba(200,200,200,0.9))";
		const MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
		function pad(n) {
			return n < 10 ? "0" + String(n) : String(n);
		}
		/** YYYY-MM-DD HH:MM */
		function fmt(ms) {
			const d = new Date(ms);
			return String(d.getFullYear()) + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes());
		}
		function fmtDate(ms) {
			const d = new Date(ms);
			return String(d.getFullYear()) + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());
		}
		function listUrl(workspace, sessionId) {
			const q = new URLSearchParams();
			if (workspace !== void 0) q.set("workspace", workspace);
			else if (sessionId !== void 0) q.set("session", sessionId);
			const s = q.toString();
			return "/session-timeline/api/list" + (s === "" ? "" : "?" + s);
		}
		function post(action, payload) {
			return fetch("/session-timeline/api/" + action, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload)
			}).then((r) => r.json()).catch(() => null);
		}
		function fetchWorkspaces() {
			const ctrl = new AbortController();
			const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
			return fetch("/session-timeline/api/workspaces", { signal: ctrl.signal }).then((r) => r.json()).then((d) => d?.ok === true ? d.workspaces ?? [] : null).catch(() => null).finally(() => clearTimeout(tid));
		}
		/** Polls the host API; pauses while the page is hidden. workspace first, else locate by the current session. */
		function useSnapshot(t, workspace, sessionId) {
			const [snap, setSnap] = useState(void 0);
			const timer = useRef(null);
			const fetchOnce = () => {
				if (workspace === void 0 && sessionId === void 0) {
					setSnap({
						ok: false,
						code: "noSession"
					});
					return;
				}
				const ctrl = new AbortController();
				const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
				fetch(listUrl(workspace, sessionId), { signal: ctrl.signal }).then((r) => r.json()).then((data) => setSnap(data)).catch(() => {}).finally(() => clearTimeout(tid));
			};
			useEffect(() => {
				fetchOnce();
				timer.current = setInterval(() => {
					if (!document.hidden) fetchOnce();
				}, POLL_MS);
				const onVis = () => {
					if (!document.hidden) fetchOnce();
				};
				document.addEventListener("visibilitychange", onVis);
				return () => {
					if (timer.current !== null) clearInterval(timer.current);
					document.removeEventListener("visibilitychange", onVis);
				};
			}, [
				t,
				workspace,
				sessionId
			]);
			return [snap, fetchOnce];
		}
		function shortId(id) {
			return id.startsWith("session-") ? id.slice(8, 16) + "…" : id.slice(0, 8) + "…";
		}
		const legendLine = (color, dashed, label) => h("span", {
			key: label,
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6
			}
		}, h("span", { style: {
			display: "inline-block",
			width: 22,
			height: 0,
			borderTop: "2px " + (dashed ? "dashed " : "solid ") + color
		} }), h("span", null, label));
		const legendFrame = (color, label, dashed = false) => h("span", {
			key: label,
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6
			}
		}, h("span", { style: {
			display: "inline-block",
			width: 11,
			height: 11,
			borderRadius: 3,
			border: "2px " + (dashed ? "dashed " : "solid ") + color,
			boxSizing: "border-box"
		} }), h("span", null, label));
		const legendTag = (label) => h("span", {
			key: label,
			style: {
				display: "inline-flex",
				alignItems: "center",
				gap: 6
			}
		}, h(P.Tag, { tone: "info" }, "handoff"), h("span", null, label));
		/** One hint item: action → result. The arrow carries the relation; no group labels, no "=". */
		const legendItem = (action, meaning) => h("span", {
			key: action,
			style: {
				display: "inline-flex",
				alignItems: "baseline",
				gap: 4
			}
		}, h("span", { style: { color: AXIS } }, action), h("span", { style: { color: DIM } }, "→"), h("span", null, meaning));
		/** Render error boundary: shows the error text instead of a blank panel. */
		var PanelBoundary = class extends React.Component {
			constructor(props) {
				super(props);
				this.state = { error: null };
			}
			static getDerivedStateFromError(error) {
				return { error };
			}
			render() {
				if (this.state.error !== null) return h("div", { style: {
					color: "var(--dsw-alias-state-error-primary)",
					fontSize: 12.5,
					padding: 12
				} }, T("state.renderFailed", { message: String(this.state.error.message ?? this.state.error) }));
				return this.props.children;
			}
		};
		function PanelBody(props) {
			const { sessionId, openSession, ctx } = props;
			const t = props.t ?? T;
			const mdLabels = useMemo(() => markdownLabelsOf(t), [t]);
			const [workspaces, setWorkspaces] = useState(null);
			const [workspace, setWorkspace] = useState(void 0);
			const [snap, refresh] = useSnapshot(t, workspace, sessionId);
			const [selected, setSelected] = useState(null);
			const [msg, setMsg] = useState(null);
			const [busy, setBusy] = useState(false);
			const innerRef = useRef(null);
			const [drag, setDrag] = useState(null);
			const dragRef = useRef(drag);
			dragRef.current = drag;
			useEffect(() => {
				fetchWorkspaces().then((ws) => {
					if (ws !== null) setWorkspaces(ws);
				});
			}, []);
			useEffect(() => {
				setViewBucket(workspace ?? null);
				return () => setViewBucket(null);
			}, [workspace]);
			const sessionBucketRef = useRef(void 0);
			useEffect(() => {
				if (workspace === void 0 && snap?.bucket !== void 0) sessionBucketRef.current = snap.bucket;
			}, [workspace, snap]);
			const [archiveMode, setArchiveModeState] = useState(archiveView.value);
			const setArchiveMode = (mode) => {
				setArchiveModeState(mode);
				setArchiveView(mode);
			};
			const [laneV, setLaneVState] = useState(laneView.value);
			useEffect(() => subscribeLaneView(() => setLaneVState(laneView.value)), []);
			const [pickerOpen, setPickerOpen] = useState(false);
			const [sortBy, setSortBy] = useState("createdAt");
			const [newestFirst, setNewestFirst] = useState(true);
			const sortedNodes = useMemo(() => {
				const all = snap?.sessions ?? [];
				const list = archiveMode === "hide" ? all.filter((n) => !n.archived) : [...all];
				list.sort((a, b) => (sortBy === "createdAt" ? a.createdAt - b.createdAt : a.lastAt - b.lastAt) || (a.id < b.id ? -1 : 1));
				if (newestFirst) list.reverse();
				return list;
			}, [
				snap,
				sortBy,
				newestFirst,
				archiveMode
			]);
			const isGlobal = workspace === GLOBAL_WORKSPACE;
			const layout = useMemo(() => computeLayout(sortedNodes, snap?.edges ?? [], snap?.manualLinks ?? []), [sortedNodes, snap]);
			const { nodes } = layout;
			const edges = snap?.edges ?? [];
			const manualLinks = snap?.manualLinks ?? [];
			const displayAt = (n) => sortBy === "createdAt" ? n.createdAt : n.lastAt;
			const visibleNodes = useMemo(() => isGlobal ? sortedNodes.filter((n) => !laneV.hidden.has(n.bucket)) : sortedNodes, [
				isGlobal,
				sortedNodes,
				laneV
			]);
			const lanesLayout = useMemo(() => isGlobal ? computeLanesLayout(visibleNodes, edges, manualLinks, (n) => n.bucket, laneV.collapsed) : null, [
				isGlobal,
				visibleNodes,
				edges,
				manualLinks,
				laneV
			]);
			const renderNodes = lanesLayout !== null ? lanesLayout.nodes : nodes;
			const viewportRef = useRef(null);
			const [zoom, setZoom] = useState(1);
			const clampZoom = (z) => Math.max(.1, Math.min(3, z));
			const applyZoom = (next, cx, cy) => {
				const vp = viewportRef.current;
				const prev = zoom;
				const z = clampZoom(next);
				if (vp !== void 0 && vp !== null && cx !== void 0 && cy !== void 0) {
					const k = z / prev;
					vp.scrollLeft = (vp.scrollLeft + cx) * k - cx;
					vp.scrollTop = (vp.scrollTop + cy) * k - cy;
				}
				setZoom(z);
			};
			const zoomAtCenter = (next) => {
				const vp = viewportRef.current;
				if (vp === null) {
					setZoom(clampZoom(next));
					return;
				}
				applyZoom(next, vp.clientWidth / 2, vp.clientHeight / 2);
			};
			const panStartRef = useRef(null);
			const [panning, setPanning] = useState(false);
			const onViewportPointerDown = (ev) => {
				if (ev.pointerType !== "mouse" || ev.button !== 0) return;
				const target = ev.target;
				if (target !== null && typeof target.closest === "function" && target.closest("[data-node-id]") !== null) return;
				const vp = viewportRef.current;
				if (vp === null) return;
				ev.preventDefault();
				try {
					vp.setPointerCapture(ev.pointerId);
				} catch {}
				panStartRef.current = {
					x: ev.clientX,
					y: ev.clientY,
					sl: vp.scrollLeft,
					st: vp.scrollTop
				};
				setPanning(true);
			};
			useEffect(() => {
				if (!panning) return;
				const move = (ev) => {
					const p = panStartRef.current;
					const vp = viewportRef.current;
					if (p === null || vp === null) return;
					vp.scrollLeft = p.sl - (ev.clientX - p.x);
					vp.scrollTop = p.st - (ev.clientY - p.y);
				};
				const finish = () => {
					panStartRef.current = null;
					setPanning(false);
				};
				window.addEventListener("pointermove", move, { passive: true });
				window.addEventListener("pointerup", finish);
				window.addEventListener("pointercancel", finish);
				return () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", finish);
					window.removeEventListener("pointercancel", finish);
				};
			}, [panning]);
			const byId = useMemo(() => new Map(sortedNodes.map((n) => [n.id, n])), [sortedNodes]);
			const dateMarks = useMemo(() => {
				const marks = [];
				let last = "";
				for (const n of nodes) {
					const d = fmtDate(displayAt(n));
					const i = layout.colOf.get(n.id) ?? 0;
					const below = layout.sideOf.get(n.id) !== "down";
					if (d !== last || i === 0) {
						marks.push({
							x: i * 140 + 140 / 2,
							date: d,
							below
						});
						last = d;
					}
				}
				return marks;
			}, [nodes, layout]);
			const laneMarks = useMemo(() => {
				if (lanesLayout === null) return [];
				const marks = [];
				let last = "";
				lanesLayout.nodes.forEach((n, i) => {
					const d = fmtDate(displayAt(n));
					if (d !== last || i === 0) {
						marks.push({
							x: (lanesLayout.colOf.get(n.id) ?? i) * 140 + 140 / 2,
							date: d
						});
						last = d;
					}
				});
				return marks;
			}, [lanesLayout, sortBy]);
			const wheelPageAt = useRef(0);
			const [selTurn, setSelTurn] = useState(1);
			const [turnsData, setTurnsData] = useState(null);
			const [fetchedTurns, setFetchedTurns] = useState(/* @__PURE__ */ new Map());
			/** Selection/workspace change resets the dialog cache and the page cursor. */
			useEffect(() => {
				setTurnsData(null);
				setFetchedTurns(/* @__PURE__ */ new Map());
				setSelTurn(1);
			}, [selected, workspace]);
			/** Fetch (and on outline growth, re-fetch) the selected session's turn scan. Two effects keep the
			*  live refresh flash-free: an epoch bump re-reads /turns without clearing the bars first. */
			const [turnsEpoch, setTurnsEpoch] = useState(0);
			useEffect(() => {
				if (selected === null) return;
				const q = new URLSearchParams({ session: selected });
				if (workspace !== void 0) q.set("workspace", workspace);
				const ctrl = new AbortController();
				const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
				fetch("/session-timeline/api/turns?" + q.toString(), { signal: ctrl.signal }).then((r) => r.json()).then((d) => {
					if (d?.ok === true) setTurnsData({
						turns: d.turns ?? 0,
						first: d.first,
						last: d.last,
						handoffTurns: d.handoffTurns ?? []
					});
				}).catch(() => {}).finally(() => clearTimeout(tid));
				return () => {
					ctrl.abort();
				};
			}, [
				selected,
				workspace,
				turnsEpoch
			]);
			const isCurrentSession = selected !== null && sessionId !== void 0 && selected === sessionId;
			const [outline, setOutline] = useState(null);
			useEffect(() => {
				setOutline(null);
				if (!isCurrentSession || sessionId === void 0 || ctx?.get === void 0) return;
				let face;
				try {
					face = ctx.get("sessions")?.binding?.(sessionId)?.session.projections.faceOf("turnOutline");
				} catch {
					face = void 0;
				}
				if (face === void 0) return;
				const read = () => {
					const value = face.getSnapshot();
					setOutline(Array.isArray(value) ? value : null);
				};
				read();
				return face.subscribe(read);
			}, [
				isCurrentSession,
				sessionId,
				ctx
			]);
			/** One /turns refresh per observed turn growth; bounded by the outline's change feed (per turn). */
			useEffect(() => {
				if (!isCurrentSession || outline === null) return;
				const known = turnsData?.turns ?? 0;
				if (outline.length > known) setTurnsEpoch((epoch) => epoch + 1);
			}, [
				outline,
				isCurrentSession,
				turnsData?.turns
			]);
			const [jumping, setJumping] = useState(false);
			const conversationOf = (target) => {
				try {
					return (ctx?.get?.("uiConversation"))?.binding?.(target);
				} catch {
					return;
				}
			};
			const sessionFaceOf = (target) => {
				try {
					return (ctx?.get?.("sessions"))?.binding?.(target);
				} catch {
					return;
				}
			};
			/** Jump anchor for one turn: outline turn/start seq first, /turns user-message seq otherwise. */
			const locateSeqFor = (turn) => {
				const outlineSeq = isCurrentSession ? outline?.find((item) => item.turn === turn)?.seq : void 0;
				if (outlineSeq !== void 0) return outlineSeq;
				const turnSeq = turnContent(turn)?.seq;
				return typeof turnSeq === "number" && turnSeq >= 0 ? turnSeq : void 0;
			};
			const jumpToTurn = (turn) => {
				if (jumping || selected === null) return;
				const target = selected;
				const seq = locateSeqFor(turn);
				if (seq === void 0) return;
				setJumping(true);
				try {
					openSession(target);
				} catch {}
				const scrollPoll = (left) => {
					const anchor = (conversationOf(target)?.target?.("chat")?.getSnapshot()?.navigation?.items?.() ?? []).find((item) => item.turn === turn)?.anchorKey;
					if (anchor !== void 0) {
						const row = findChatRow(target, anchor);
						if (row !== null) {
							scrollRowIntoView(row);
							setJumping(false);
							return;
						}
					}
					if (left <= 0) {
						setJumping(false);
						return;
					}
					requestAnimationFrame(() => scrollPoll(left - 1));
				};
				const facePoll = (left) => {
					const face = sessionFaceOf(target);
					if (face !== void 0) {
						try {
							conversationOf(target)?.activate?.("chat");
						} catch {}
						face.session.loadThrough(seq).then(() => scrollPoll(60)).catch(() => setJumping(false));
						return;
					}
					if (left <= 0) {
						setJumping(false);
						return;
					}
					requestAnimationFrame(() => facePoll(left - 1));
				};
				facePoll(40);
			};
			/** Turn T's dialog: first/last/handoff turns ship with /turns; the rest come from the on-demand cache. */
			const turnContent = (turn) => {
				if (turnsData === null || turn < 1 || turn > turnsData.turns) return void 0;
				if (turn === 1) return turnsData.first;
				if (turn === turnsData.turns) return turnsData.last;
				const ht = (turnsData.handoffTurns ?? []).find((x) => x.turn === turn);
				if (ht !== void 0) return ht;
				return fetchedTurns.get(turn);
			};
			const fetchTurn = (turn) => {
				if (selected === null || fetchedTurns.has(turn)) return;
				const q = new URLSearchParams({
					session: selected,
					turn: String(turn)
				});
				if (workspace !== void 0) q.set("workspace", workspace);
				const ctrl = new AbortController();
				const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
				fetch("/session-timeline/api/turns?" + q.toString(), { signal: ctrl.signal }).then((r) => r.json()).then((d) => {
					if (d?.ok === true && d.data !== void 0) setFetchedTurns((prev) => {
						const next = new Map(prev);
						next.set(turn, d.data);
						return next;
					});
				}).catch(() => {}).finally(() => clearTimeout(tid));
			};
			const selectTurn = (turn) => {
				setSelTurn(turn);
				if (turnContent(turn) === void 0) fetchTurn(turn);
			};
			const degree = useMemo(() => lineageDegrees(edges, manualLinks), [edges, manualLinks]);
			const obstacles = useMemo(() => nodes.map((n) => ({
				x: (layout.colOf.get(n.id) ?? 0) * 140 + 8 / 2 - 2,
				y: nodeTop(layout, n.id) - 2,
				w: 136,
				h: 100
			})), [nodes, layout]);
			const laneObstacles = useMemo(() => {
				const m = /* @__PURE__ */ new Map();
				if (lanesLayout === null) return m;
				for (const lane of lanesLayout.lanes) m.set(lane.id, lane.nodes.map((n) => ({
					x: (lane.colOf.get(n.id) ?? 0) * 140 + 8 / 2 - 2,
					y: nodeTop(lane, n.id) - 2,
					w: 136,
					h: 100
				})));
				return m;
			}, [lanesLayout]);
			const occupiedRef = useRef(/* @__PURE__ */ new Map());
			useEffect(() => {
				occupiedRef.current = /* @__PURE__ */ new Map();
			}, [snap]);
			const routeEdge = (from, to, step) => {
				if (!byId.has(from) || !byId.has(to)) return "";
				if (lanesLayout !== null) {
					const laneId = lanesLayout.laneOf.get(from);
					const lane = laneId !== void 0 ? lanesLayout.laneById.get(laneId) : void 0;
					if (lane === void 0) return "";
					return routeEdgePath({
						layout: lane,
						obstacles: laneObstacles.get(lane.id) ?? [],
						occupied: occupiedRef.current,
						from,
						to,
						step
					});
				}
				return routeEdgePath({
					layout,
					obstacles,
					occupied: occupiedRef.current,
					from,
					to,
					step
				});
			};
			const bucketTail = (bucket) => {
				const w = (workspaces ?? []).find((x) => x.bucket === bucket);
				if (w !== void 0 && w.cwd !== null && w.cwd !== "") return w.cwd.split("/").filter(Boolean).pop() ?? w.cwd;
				return bucket.replaceAll("-", "/").split("/").filter(Boolean).pop() ?? bucket;
			};
			const act = async (action, from, to) => {
				setBusy(true);
				setMsg(null);
				const payload = {
					from,
					to
				};
				if (workspace !== void 0) payload.workspace = workspace;
				else if (sessionId !== void 0) payload.session = sessionId;
				const r = await post(action, payload);
				setBusy(false);
				if (r === null) {
					setMsg(t("error.requestFailed"));
					return;
				}
				if (r.ok !== true) {
					setMsg(errorText(t, r));
					return;
				}
				if (action === "link") setMsg(r.duplicate === true ? t("msg.linkDuplicate") : t("msg.linked"));
				else setMsg(t("msg.unlinked"));
				refresh();
			};
			useEffect(() => {
				if (drag === null) return;
				const move = (ev) => {
					const rect = innerRef.current?.getBoundingClientRect();
					const nx = rect !== void 0 ? (ev.clientX - rect.left) / zoom : 0;
					const ny = rect !== void 0 ? (ev.clientY - rect.top) / zoom : 0;
					setDrag((d) => d === null ? d : {
						...d,
						x: nx,
						y: ny,
						moved: d.moved || Math.hypot(ev.clientX - d.sx, ev.clientY - d.sy) > 5
					});
				};
				const finish = (ev) => {
					const cur = dragRef.current;
					setDrag(null);
					if (cur === null) return;
					if (!cur.moved) {
						setSelected((s) => s === cur.from ? null : cur.from);
						return;
					}
					const target = (document.elementFromPoint(ev.clientX, ev.clientY)?.closest?.("[data-node-id]"))?.getAttribute("data-node-id") ?? null;
					if (target !== null && target !== cur.from) act("link", cur.from, target);
				};
				window.addEventListener("pointermove", move, { passive: true });
				window.addEventListener("pointerup", finish);
				window.addEventListener("pointercancel", finish);
				return () => {
					window.removeEventListener("pointermove", move);
					window.removeEventListener("pointerup", finish);
					window.removeEventListener("pointercancel", finish);
				};
			}, [
				drag === null ? null : drag.from,
				workspace,
				sessionId,
				zoom
			]);
			if (snap === void 0) return h("div", { style: {
				color: DIM,
				fontSize: 12.5,
				padding: 12
			} }, t("state.loading"));
			if (snap.ok !== true) return h("div", { style: {
				color: DIM,
				fontSize: 12.5,
				padding: 12
			} }, errorText(t, snap));
			const sel = selected !== null ? byId.get(selected) : void 0;
			const selManualIn = sel !== void 0 ? manualLinks.filter((l) => l.to === sel.id) : [];
			const selManualOut = sel !== void 0 ? manualLinks.filter((l) => l.from === sel.id) : [];
			const selOut = sel !== void 0 ? [...edges.filter((e) => e.from === sel.id).map((e) => ({
				id: e.to,
				branch: displayKind(e, degree) === "branch",
				manual: false,
				unlink: null
			})), ...selManualOut.map((l) => ({
				id: l.to,
				branch: false,
				manual: true,
				unlink: {
					from: l.from,
					to: l.to
				}
			}))] : [];
			const titleOf = (id) => byId.get(id)?.title ?? shortId(id);
			const wsLabel = (w) => {
				return (w.cwd !== null && w.cwd !== "" ? w.cwd.split("/").filter(Boolean).pop() ?? w.cwd : w.bucket) + t("fmt.count", { count: w.sessions });
			};
			const nodeCard = (n) => {
				const i = lanesLayout !== null ? lanesLayout.colOf.get(n.id) ?? 0 : layout.colOf.get(n.id) ?? 0;
				const top = lanesLayout !== null ? laneNodeTop(lanesLayout, n.id) : nodeTop(layout, n.id);
				const isDragSrc = drag !== null && drag.moved && drag.from === n.id;
				const isSel = selected === n.id;
				const deg = degree.get(n.id);
				const nudgeFirst = n.handoffFirst && (deg?.in ?? 0) === 0;
				const nudgeLast = n.handoffUsed && (deg?.out ?? 0) === 0;
				let border = "var(--dsw-alias-border-primary, rgba(128,128,128,0.35))";
				let shadow = "none";
				if (nudgeFirst) border = FIRST_NUDGE;
				else if (nudgeLast) border = LAST_NUDGE;
				if (nudgeFirst && nudgeLast) shadow = "inset 0 0 0 2px #e0a11a";
				if (isSel) shadow = (shadow === "none" ? "" : shadow + ", ") + "0 0 0 2px var(--dsw-alias-accent-primary, #3b82f6)";
				else if (isDragSrc) shadow = "0 0 0 2px rgba(217,119,6,0.95)";
				const kids = deg?.out ?? 0;
				return h("div", {
					key: n.id,
					"data-node-id": n.id,
					title: (n.title ?? n.id) + "\n" + t("node.hint"),
					style: {
						position: "absolute",
						left: i * 140 + 8 / 2,
						top,
						width: 132,
						height: 96,
						boxSizing: "border-box",
						borderRadius: 8,
						border: nudgeFirst || nudgeLast ? "2px " + (n.archived ? "dashed " : "solid ") + border : "1px " + (n.archived ? "dashed " : "solid ") + border,
						boxShadow: shadow,
						opacity: isDragSrc ? .55 : 1,
						padding: nudgeFirst || nudgeLast ? "5px 7px" : "6px 8px",
						display: "flex",
						flexDirection: "column",
						gap: 3,
						overflow: "hidden",
						cursor: "grab",
						userSelect: "none",
						WebkitUserSelect: "none",
						background: "var(--dsw-alias-surface-raised, rgba(128,128,128,0.06))",
						touchAction: "none"
					},
					onPointerDown: (ev) => {
						if (ev.button !== 0) return;
						ev.preventDefault();
						setDrag({
							from: n.id,
							x: i * 140 + 140 / 2,
							y: top + 96,
							sx: ev.clientX,
							sy: ev.clientY,
							moved: false
						});
					},
					onDoubleClick: () => {
						setSelected(n.id);
						openSession(n.id);
					}
				}, h("div", { style: {
					color: DIM,
					fontSize: 10.5,
					fontFamily: MONO,
					fontVariantNumeric: "tabular-nums"
				} }, fmt(displayAt(n))), h("div", { style: {
					fontSize: 12,
					lineHeight: 1.3,
					overflow: "hidden",
					display: "-webkit-box",
					WebkitLineClamp: 2,
					WebkitBoxOrient: "vertical",
					minHeight: 31
				} }, n.title ?? t("node.untitled")), h("div", { style: {
					display: "flex",
					gap: 4,
					marginTop: "auto",
					flexWrap: "wrap"
				} }, n.seeded || n.handoffUsed ? h(P.Tag, { tone: "info" }, "handoff") : null, kids >= 2 ? h(P.Tag, { tone: "info" }, "⑂" + String(kids)) : null, n.parent !== null && !byId.has(n.parent) ? h(P.Tag, { tone: "quiet" }, t("node.tag.externalParent")) : null, isGlobal ? h(P.Tag, { tone: "quiet" }, bucketTail(n.bucket)) : null));
			};
			const axisY = layout.axisY;
			const canvasW = lanesLayout !== null ? lanesLayout.innerW : layout.innerW;
			const canvasH = lanesLayout !== null ? lanesLayout.innerH : layout.innerH;
			const spurLines = (laneNodes, topOf, colMap, sideMap, depthMap, axisYv, keyPrefix) => {
				const groups = /* @__PURE__ */ new Map();
				for (const n of laneNodes) {
					const up = (sideMap.get(n.id) ?? "up") !== "down";
					const depth = depthMap.get(n.id) ?? 0;
					const top = topOf(n.id);
					const key = String(colMap.get(n.id) ?? 0) + "|" + (up ? "up" : "down");
					const list = groups.get(key) ?? [];
					list.push({
						top,
						near: up ? top + 96 : top,
						far: up ? top : top + 96,
						depth
					});
					groups.set(key, list);
				}
				const lines = [];
				let fi = 0;
				for (const [key, list] of groups) {
					const cx = Number(key.split("|")[0]) * 140 + 140 / 2;
					list.sort((a, b) => a.depth - b.depth);
					let prevY = axisYv;
					for (const b of list) {
						if (Math.abs(prevY - b.near) > 2) lines.push(h("line", {
							key: keyPrefix + "f" + String(fi++),
							x1: cx,
							y1: prevY,
							x2: cx,
							y2: b.near,
							stroke: AXIS,
							strokeWidth: 1.2,
							opacity: .45
						}));
						prevY = b.far;
					}
				}
				return lines;
			};
			const singleSvgChildren = () => [
				h("line", {
					x1: newestFirst ? layout.innerW - 8 : 8,
					y1: axisY,
					x2: newestFirst ? 14 : layout.innerW - 14,
					y2: axisY,
					stroke: AXIS,
					strokeWidth: 1.4,
					opacity: .7,
					markerEnd: "url(#st-arrow-axis)"
				}),
				...dateMarks.map((m, i) => h("g", { key: "d" + String(i) }, h("line", {
					x1: m.x,
					y1: m.below ? axisY - 4 : axisY,
					x2: m.x,
					y2: m.below ? axisY : axisY + 4,
					stroke: AXIS,
					strokeWidth: 1.2,
					opacity: .8
				}), h("text", {
					x: m.x,
					y: m.below ? axisY + 14 : axisY - 6,
					textAnchor: "middle",
					fontSize: 10.5,
					fontFamily: MONO,
					fill: AXIS,
					opacity: .85
				}, m.date))),
				...spurLines(nodes, (id) => nodeTop(layout, id), layout.colOf, layout.sideOf, layout.depthOf, axisY, "s"),
				...edges.map((e, i) => {
					if (!layout.colOf.has(e.from) || !layout.colOf.has(e.to)) return null;
					const kind = displayKind(e, degree);
					const color = kind === "branch" ? BRANCH : ACCENT;
					return h("path", {
						key: "n" + String(i),
						d: routeEdge(e.from, e.to, i),
						fill: "none",
						stroke: color,
						strokeWidth: 1.6,
						markerEnd: kind === "branch" ? "url(#st-arrow-branch)" : "url(#st-arrow-handoff)",
						opacity: .85
					});
				}),
				...manualLinks.map((l, i) => {
					if (!layout.colOf.has(l.from) || !layout.colOf.has(l.to)) return null;
					return h("path", {
						key: "m" + String(i),
						d: routeEdge(l.from, l.to, i + 2),
						fill: "none",
						stroke: MANUAL,
						strokeWidth: 1.6,
						strokeDasharray: "6 4",
						markerEnd: "url(#st-arrow-manual)",
						opacity: .9
					});
				}),
				drag !== null && drag.moved ? h("line", {
					x1: colX(layout, drag.from),
					y1: nodeTop(layout, drag.from) + 96 / 2,
					x2: drag.x,
					y2: drag.y,
					stroke: MANUAL,
					strokeWidth: 1.6,
					strokeDasharray: "4 4"
				}) : null
			];
			const lanesSvgChildren = () => {
				const L = lanesLayout;
				if (L === null) return [];
				return [
					...laneMarks.map((m, i) => h("g", { key: "gd" + String(i) }, h("line", {
						x1: m.x,
						y1: 0,
						x2: m.x,
						y2: canvasH,
						stroke: AXIS,
						strokeWidth: 1,
						opacity: .13
					}), h("text", {
						x: m.x,
						y: 16,
						textAnchor: "middle",
						fontSize: 10.5,
						fontFamily: MONO,
						fill: AXIS,
						opacity: .85
					}, m.date))),
					...L.lanes.map((lane) => {
						const labelCount = lane.collapsed ? (workspaces ?? []).find((w) => w.bucket === lane.id)?.sessions ?? 0 : lane.nodes.length;
						const label = h("text", {
							key: "lb",
							x: 8,
							y: lane.top + 13,
							fontSize: 10.5,
							fontFamily: MONO,
							fontWeight: 600,
							fill: lane.collapsed ? DIM : AXIS,
							style: {
								cursor: "pointer",
								pointerEvents: "auto",
								userSelect: "none",
								WebkitUserSelect: "none"
							},
							onClick: () => toggleLaneSet("collapsed", lane.id)
						}, (lane.collapsed ? "▸ " : "▾ ") + bucketTail(lane.id) + t("fmt.count", { count: labelCount }));
						if (lane.collapsed) return h("g", { key: "lane-" + lane.id }, [label]);
						return h("g", { key: "lane-" + lane.id }, [
							label,
							h("line", {
								x1: newestFirst ? canvasW - 8 : 8,
								y1: lane.axisY,
								x2: newestFirst ? 14 : canvasW - 14,
								y2: lane.axisY,
								stroke: AXIS,
								strokeWidth: 1.4,
								opacity: .7,
								markerEnd: "url(#st-arrow-axis)"
							}),
							...spurLines(lane.nodes, (id) => nodeTop(lane, id), lane.colOf, lane.sideOf, lane.depthOf, lane.axisY, lane.id + "|")
						]);
					}),
					...edges.map((e, i) => {
						if (!L.colOf.has(e.from) || !L.colOf.has(e.to)) return null;
						if (L.laneOf.get(e.from) !== L.laneOf.get(e.to)) return null;
						const kind = displayKind(e, degree);
						const color = kind === "branch" ? BRANCH : ACCENT;
						return h("path", {
							key: "n" + String(i),
							d: routeEdge(e.from, e.to, i),
							fill: "none",
							stroke: color,
							strokeWidth: 1.6,
							markerEnd: kind === "branch" ? "url(#st-arrow-branch)" : "url(#st-arrow-handoff)",
							opacity: .85
						});
					}),
					...manualLinks.map((l, i) => {
						if (!L.colOf.has(l.from) || !L.colOf.has(l.to)) return null;
						if (L.laneOf.get(l.from) !== L.laneOf.get(l.to)) return null;
						return h("path", {
							key: "m" + String(i),
							d: routeEdge(l.from, l.to, i + 2),
							fill: "none",
							stroke: MANUAL,
							strokeWidth: 1.6,
							strokeDasharray: "6 4",
							markerEnd: "url(#st-arrow-manual)",
							opacity: .9
						});
					}),
					drag !== null && drag.moved ? h("line", {
						x1: (L.colOf.get(drag.from) ?? 0) * 140 + 140 / 2,
						y1: laneNodeTop(L, drag.from) + 96 / 2,
						x2: drag.x,
						y2: drag.y,
						stroke: MANUAL,
						strokeWidth: 1.6,
						strokeDasharray: "4 4"
					}) : null
				];
			};
			return h("div", { style: {
				height: "100%",
				overflow: "hidden",
				boxSizing: "border-box",
				padding: "8px 12px 12px",
				display: "flex",
				flexDirection: "column",
				gap: 8
			} }, h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 6,
				fontSize: 12,
				color: DIM,
				flexWrap: "wrap"
			} }, h("select", {
				value: workspace ?? "",
				title: t("header.workspaceTitle"),
				style: {
					fontSize: 12,
					maxWidth: 150,
					padding: "2px 4px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))",
					background: "var(--dsw-alias-surface-raised, transparent)",
					color: "inherit"
				},
				onChange: (ev) => {
					setSelected(null);
					setWorkspace(ev.target.value === "" ? void 0 : ev.target.value);
				}
			}, h("option", { value: "" }, sessionBucketRef.current !== void 0 ? bucketTail(sessionBucketRef.current) : t("header.workspaceCurrent")), h("option", { value: GLOBAL_WORKSPACE }, t("header.workspaceAll")), ...(workspaces ?? []).filter((w) => w.bucket !== sessionBucketRef.current && w.bucket !== GLOBAL_WORKSPACE).map((w) => h("option", {
				key: w.bucket,
				value: w.bucket,
				title: w.cwd ?? w.bucket
			}, wsLabel(w)))), h("select", {
				value: newestFirst ? "newOld" : "oldNew",
				title: t("header.orderTitle"),
				style: {
					fontSize: 12,
					padding: "2px 4px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))",
					background: "var(--dsw-alias-surface-raised, transparent)",
					color: "inherit"
				},
				onChange: (ev) => {
					setSelected(null);
					setNewestFirst(ev.target.value === "newOld");
				}
			}, h("option", { value: "oldNew" }, t("header.orderOldNew")), h("option", { value: "newOld" }, t("header.orderNewOld"))), h("select", {
				value: sortBy,
				title: t("header.sortTitle"),
				style: {
					fontSize: 12,
					padding: "2px 4px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))",
					background: "var(--dsw-alias-surface-raised, transparent)",
					color: "inherit"
				},
				onChange: (ev) => {
					setSelected(null);
					setSortBy(ev.target.value === "lastAt" ? "lastAt" : "createdAt");
				}
			}, h("option", { value: "createdAt" }, t("header.sortCreated")), h("option", { value: "lastAt" }, t("header.sortLast"))), h("select", {
				value: archiveMode,
				title: t("header.archiveTitle"),
				style: {
					fontSize: 12,
					padding: "2px 4px",
					borderRadius: 6,
					border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))",
					background: "var(--dsw-alias-surface-raised, transparent)",
					color: "inherit"
				},
				onChange: (ev) => {
					setSelected(null);
					setArchiveMode(ev.target.value === "hide" ? "hide" : "all");
				}
			}, h("option", { value: "all" }, t("header.archiveShowAll")), h("option", { value: "hide" }, t("header.archiveHide"))), lanesLayout !== null ? h("span", { style: { position: "relative" } }, h(P.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => setPickerOpen((o) => !o)
			}, t("header.laneFilter") + (laneV.hidden.size > 0 ? " " + String(lanesLayout.lanes.length) + "/" + String(lanesLayout.lanes.length + laneV.hidden.size) : "")), pickerOpen ? h("div", { style: {
				position: "absolute",
				top: "100%",
				left: 0,
				zIndex: 80,
				minWidth: 230,
				maxHeight: 280,
				overflowY: "auto",
				background: "var(--dsw-alias-surface-overlay, var(--dsw-alias-surface-primary, #1a1c20))",
				border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.35))",
				borderRadius: 8,
				padding: "6px 8px",
				boxShadow: "0 4px 16px rgba(0,0,0,0.35)"
			} }, (() => {
				const rowIds = [];
				const seenRow = /* @__PURE__ */ new Set();
				for (const w of workspaces ?? []) if (!seenRow.has(w.bucket)) {
					seenRow.add(w.bucket);
					rowIds.push(w.bucket);
				}
				for (const id of laneV.hidden) if (!seenRow.has(id)) {
					seenRow.add(id);
					rowIds.push(id);
				}
				return rowIds.map((id) => {
					const w = (workspaces ?? []).find((x) => x.bucket === id);
					return h("label", {
						key: id,
						style: {
							display: "flex",
							alignItems: "center",
							gap: 6,
							padding: "3px 4px",
							cursor: "pointer",
							fontSize: 12
						}
					}, h("input", {
						type: "checkbox",
						checked: !laneV.hidden.has(id),
						onChange: () => toggleLaneSet("hidden", id)
					}), h("span", null, bucketTail(id)), w !== void 0 ? h("span", { style: {
						color: DIM,
						fontFamily: MONO,
						marginLeft: "auto"
					} }, String(w.sessions)) : null);
				});
			})(), h("div", { style: {
				display: "flex",
				gap: 4,
				borderTop: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))",
				paddingTop: 6,
				marginTop: 4
			} }, h(P.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => setLanesHidden(/* @__PURE__ */ new Set())
			}, t("header.laneAll")), h(P.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => setLanesHidden(new Set((workspaces ?? []).map((w) => w.bucket)))
			}, t("header.laneNone")), h(P.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => setLanesHidden(new Set((workspaces ?? []).filter((w) => w.bucket !== sessionBucketRef.current).map((w) => w.bucket)))
			}, t("header.laneOnlyCurrent")))) : null) : null, (snap.unreadable ?? 0) > 0 ? h("span", { style: {
				color: MANUAL,
				fontSize: 11.5
			} }, t("stats.unreadable", { count: snap.unreadable ?? 0 })) : null, msg !== null ? h("span", { style: {
				color: MANUAL,
				fontSize: 11.5
			} }, msg) : null, h("span", { style: { marginLeft: "auto" } }, h(P.Button, {
				variant: "ghost",
				size: "sm",
				disabled: busy,
				onClick: () => {
					refresh();
					fetchWorkspaces().then((ws) => {
						if (ws !== null) setWorkspaces(ws);
					});
				}
			}, t("header.refresh")))), h("div", { style: {
				position: "relative",
				flex: "0 0 auto"
			} }, h("div", { style: {
				position: "absolute",
				left: 8,
				top: 8,
				zIndex: 50,
				display: "flex",
				alignItems: "center",
				gap: 2,
				padding: "2px 6px",
				borderRadius: 6,
				boxShadow: "0 1px 4px rgba(0,0,0,0.35)",
				background: "var(--dsw-alias-surface-overlay, var(--dsw-alias-surface-primary, #1a1c20))",
				border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.3))",
				fontSize: 11.5,
				fontFamily: MONO,
				userSelect: "none"
			} }, h("span", {
				title: t("zoom.out"),
				style: {
					cursor: "pointer",
					padding: "0 5px",
					color: zoom > .100000001 ? "inherit" : DIM
				},
				onClick: () => zoomAtCenter(zoom - .1)
			}, "−"), h("span", {
				title: zoom === 1 ? t("zoom.fit") : t("zoom.reset"),
				style: {
					minWidth: 40,
					textAlign: "center",
					cursor: zoom === 1 ? "default" : "pointer"
				},
				onClick: () => {
					if (zoom !== 1) zoomAtCenter(1);
				}
			}, String(Math.round(zoom * 100)) + "%"), h("span", {
				title: t("zoom.in"),
				style: {
					cursor: "pointer",
					padding: "0 5px",
					color: zoom < 2.999999999 ? "inherit" : DIM
				},
				onClick: () => zoomAtCenter(zoom + .1)
			}, "+")), h("div", {
				ref: viewportRef,
				title: t("canvas.hint"),
				onPointerDown: onViewportPointerDown,
				style: {
					overflowX: "auto",
					overflowY: "auto",
					height: TIMELINE_MAX_H,
					border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))",
					borderRadius: 8,
					cursor: panning ? "grabbing" : "grab"
				}
			}, h("div", { style: {
				width: canvasW * zoom,
				height: canvasH * zoom,
				overflow: "hidden"
			} }, h("div", {
				ref: innerRef,
				style: {
					position: "relative",
					width: canvasW,
					height: canvasH,
					userSelect: "none",
					WebkitUserSelect: "none",
					transform: "scale(" + String(zoom) + ")",
					transformOrigin: "0 0"
				}
			}, h("svg", {
				width: canvasW,
				height: canvasH,
				style: {
					position: "absolute",
					inset: 0,
					pointerEvents: "none"
				}
			}, h("defs", null, h("marker", {
				id: "st-arrow-handoff",
				markerWidth: 7,
				markerHeight: 7,
				refX: 6,
				refY: 3.5,
				orient: "auto"
			}, h("path", {
				d: "M0,0 L7,3.5 L0,7 z",
				fill: ACCENT
			})), h("marker", {
				id: "st-arrow-branch",
				markerWidth: 7,
				markerHeight: 7,
				refX: 6,
				refY: 3.5,
				orient: "auto"
			}, h("path", {
				d: "M0,0 L7,3.5 L0,7 z",
				fill: BRANCH
			})), h("marker", {
				id: "st-arrow-manual",
				markerWidth: 7,
				markerHeight: 7,
				refX: 6,
				refY: 3.5,
				orient: "auto"
			}, h("path", {
				d: "M0,0 L7,3.5 L0,7 z",
				fill: MANUAL
			})), h("marker", {
				id: "st-arrow-axis",
				markerWidth: 10,
				markerHeight: 8,
				refX: 8,
				refY: 4,
				orient: "auto"
			}, h("path", {
				d: "M0,0 L9,4 L0,8 z",
				fill: AXIS
			}))), ...lanesLayout !== null ? lanesSvgChildren() : singleSvgChildren()), ...renderNodes.map((n) => nodeCard(n)))))), sel === void 0 ? h("div", { style: {
				color: DIM,
				fontSize: 12,
				display: "flex",
				flexDirection: "column",
				gap: 7
			} }, h("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "baseline",
				gap: "3px 16px"
			} }, legendItem(t("legend.action.dragNode"), t("legend.meaning.manual")), legendItem(t("legend.action.doubleClick"), t("legend.meaning.switchSession"))), h("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: "4px 16px"
			} }, legendLine(ACCENT, false, t("legend.line.handoff")), legendLine(BRANCH, false, t("legend.line.branch")), legendLine(MANUAL, true, t("legend.line.manual")), legendFrame(FIRST_NUDGE, t("legend.frame.awaitParent")), legendFrame(LAST_NUDGE, t("legend.frame.awaitChild")), legendFrame("var(--dsw-alias-border-primary, rgba(128,128,128,0.35))", t("legend.frame.archived"), true), legendTag(t("legend.tag.handoff")))) : h("div", {
				title: t("detail.hint"),
				onWheel: (ev) => {
					if (turnsData === null || turnsData.turns === 0) return;
					const now = Date.now();
					if (now - wheelPageAt.current < 300) return;
					wheelPageAt.current = now;
					const next = ev.deltaY > 0 ? Math.min(turnsData.turns, selTurn + 1) : Math.max(1, selTurn - 1);
					if (next !== selTurn) selectTurn(next);
				},
				style: {
					flex: "1 1 auto",
					overflowY: "auto",
					display: "flex",
					flexDirection: "column",
					gap: 6,
					border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.25))",
					borderRadius: 8,
					padding: "8px 10px",
					minHeight: 0
				}
			}, h("div", { style: {
				display: "flex",
				alignItems: "center",
				gap: 8
			} }, h("div", { style: {
				fontSize: 13,
				fontWeight: 600,
				flex: 1,
				minWidth: 0,
				overflow: "hidden",
				textOverflow: "ellipsis",
				whiteSpace: "nowrap"
			} }, sel.title ?? t("node.untitled")), h(P.Button, {
				variant: "ghost",
				size: "sm",
				onClick: () => openSession(sel.id)
			}, t("detail.open"))), h("div", {
				title: t("detail.rangeHint"),
				style: {
					color: DIM,
					fontSize: 11.5,
					fontFamily: MONO,
					fontVariantNumeric: "tabular-nums",
					display: "flex",
					alignItems: "baseline",
					gap: 5,
					flexWrap: "wrap"
				}
			}, h("span", null, fmt(sel.createdAt)), h("span", { style: { opacity: .55 } }, "→"), h("span", null, fmt(sel.lastAt))), (() => {
				const inItems = [];
				if (sel.parent !== null) if (byId.has(sel.parent)) inItems.push(h("span", {
					key: "nat",
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4
					}
				}, h("span", { style: { color: DIM } }, "←"), h("span", null, titleOf(sel.parent)), (degree.get(sel.parent)?.out ?? 0) >= 2 ? h("span", { style: { color: BRANCH } }, "⑂") : null));
				else inItems.push(h("span", {
					key: "natmiss",
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4,
						color: DIM
					}
				}, h("span", null, "←"), h("span", null, t("lineage.fromMissing", { id: shortId(sel.parent) }))));
				for (const l of selManualIn) inItems.push(h("span", {
					key: "mi-" + l.from + l.to,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4
					}
				}, h("span", { style: { color: DIM } }, "←"), h("span", { style: { color: MANUAL } }, titleOf(l.from)), h(P.Button, {
					variant: "ghost",
					size: "sm",
					disabled: busy,
					title: t("link.disconnectTitle"),
					onClick: () => {
						act("unlink", l.from, l.to);
					}
				}, t("link.disconnect"))));
				if (sel.parentSource === "inferred") inItems.push(h("span", {
					key: "forkinf",
					style: { color: DIM }
				}, t("detail.forkInferred")));
				if (sel.forkMarkerSeq !== null && sel.parent === null) inItems.push(h("span", {
					key: "forkmiss",
					style: { color: DIM }
				}, t("detail.forkSourceMissing")));
				const outItems = selOut.map((o, i) => h("span", {
					key: "out-" + String(i),
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4
					}
				}, h("span", { style: { color: DIM } }, "→"), h("span", { style: o.manual ? { color: MANUAL } : void 0 }, titleOf(o.id)), o.branch ? h("span", { style: { color: BRANCH } }, "⑂") : null, o.unlink !== null ? h(P.Button, {
					variant: "ghost",
					size: "sm",
					disabled: busy,
					title: t("link.disconnectTitle"),
					onClick: () => {
						act("unlink", o.unlink.from, o.unlink.to);
					}
				}, t("link.disconnect")) : null));
				const row = (list) => list.length > 0 ? h("div", { style: {
					fontSize: 12,
					display: "flex",
					flexWrap: "wrap",
					alignItems: "center",
					gap: "2px 12px"
				} }, list) : null;
				const inRow = row(inItems);
				const outRow = row(outItems);
				if (inRow === null && outRow === null) return null;
				return h("div", { style: {
					display: "flex",
					flexDirection: "column",
					gap: 3
				} }, [inRow, outRow]);
			})(), sel.handoffHits.length > 0 || sel.seeded ? h("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: 3
			} }, h("div", { style: {
				fontSize: 12,
				display: "flex",
				flexWrap: "wrap",
				alignItems: "baseline",
				gap: 8
			} }, sel.handoffHits.length > 0 ? h("span", null, t("handoff.count", { count: sel.handoffHits.length })) : null, sel.seeded ? h("span", { style: { color: DIM } }, t("handoff.seeded")) : null), ...sel.handoffHits.map((hit) => h("div", {
				key: "handoff-hit-" + String(hit.seq) + "-" + String(hit.at),
				style: {
					color: DIM,
					fontSize: 11.5,
					fontFamily: MONO,
					fontVariantNumeric: "tabular-nums"
				}
			}, t("handoff.hit", {
				turn: hit.turn,
				time: hit.at > 0 ? fmt(hit.at) : t("handoff.timeUnknown"),
				seq: hit.seq
			})))) : null, h("div", { style: {
				display: "flex",
				alignItems: "flex-end",
				gap: 3,
				flexWrap: "wrap"
			} }, ...turnsData === null ? [] : Array.from({ length: turnsData.turns }, (_, i) => i + 1).map((tn) => {
				const isHandoff = (turnsData.handoffTurns ?? []).some((x) => x.turn === tn);
				const big = tn === 1 || tn === turnsData.turns;
				const active = tn === selTurn;
				return h("div", {
					key: "turn-bar-" + String(tn),
					title: t("turns.barTitle", { turn: tn }) + (tn === 1 ? t("turns.suffixFirst") : "") + (tn === turnsData.turns ? t("turns.suffixLast") : "") + (isHandoff ? t("turns.suffixHandoff") : ""),
					onClick: () => selectTurn(tn),
					style: {
						width: big ? 24 : 14,
						height: big ? 16 : 9,
						borderRadius: 3,
						cursor: "pointer",
						boxSizing: "border-box",
						background: active ? ACCENT : isHandoff ? LAST_NUDGE : "var(--dsw-alias-surface-raised, rgba(128,128,128,0.28))",
						border: isHandoff ? "1px solid #e0a11a" : "1px solid transparent",
						opacity: active ? 1 : isHandoff ? .8 : .7
					}
				});
			}), turnsData !== null && turnsData.turns > 0 ? h("span", { style: {
				color: DIM,
				fontSize: 11,
				marginLeft: 6,
				fontVariantNumeric: "tabular-nums"
			} }, t("turns.position", {
				turn: selTurn,
				total: turnsData.turns
			})) : turnsData !== null ? h("span", { style: {
				color: DIM,
				fontSize: 11
			} }, t("turns.none")) : null, turnsData !== null && turnsData.turns > 0 ? h(P.Button, {
				variant: "ghost",
				size: "sm",
				disabled: jumping || locateSeqFor(selTurn) === void 0,
				title: t("turns.jumpTitle"),
				onClick: () => jumpToTurn(selTurn)
			}, t("turns.jump")) : null), h("div", {
				title: t("turns.contentHint"),
				onWheel: (ev) => {
					ev.stopPropagation();
				},
				style: {
					maxHeight: 180,
					overflowY: "auto",
					fontSize: 12,
					lineHeight: 1.45,
					whiteSpace: "pre-wrap",
					wordBreak: "break-word",
					padding: "6px 8px",
					borderRadius: 6,
					background: "var(--dsw-alias-surface-raised, rgba(128,128,128,0.06))"
				}
			}, turnsData === null ? h("span", { style: { color: DIM } }, t("state.loading")) : (() => {
				const tv = turnContent(selTurn);
				if (tv === void 0) return h("span", { style: { color: DIM } }, t("state.loading"));
				const userText = tv.user === "" ? h("span", { style: { color: DIM } }, t("turns.noUserText")) : tv.user + (tv.userClipped === true ? t("turns.truncated") : "");
				return [h("div", {
					key: "u",
					title: t("turns.roleUser"),
					style: {
						marginBottom: 6,
						borderLeft: "2px solid rgba(128,128,128,0.55)",
						paddingLeft: 8
					}
				}, userText), h("div", {
					key: "a",
					title: t("turns.roleAssistant"),
					style: {
						borderLeft: "2px solid var(--dsw-alias-text-primary, rgba(200,200,200,0.9))",
						paddingLeft: 8
					}
				}, tv.assistantReasoning === true ? h("div", { style: {
					color: DIM,
					fontSize: 11,
					marginBottom: 2
				} }, t("turns.reasoningPrefix")) : null, tv.assistant === "" ? h("span", { style: { color: DIM } }, t("turns.noAssistantReply")) : h(P.MarkdownText, {
					text: tv.assistant,
					streaming: false,
					labels: mdLabels
				}), tv.assistantClipped === true ? h("span", { style: { color: DIM } }, t("turns.truncated")) : null)];
			})())));
		}
		/** Tab title: text + top-level session count of the current panel view (light polling).
		*  View = the panel's selected workspace; when unselected it follows the current session's bucket —
		*  switching workspaces applies immediately. */
		function TabTitle(props) {
			const { sessionId } = props;
			const t = props.t ?? T;
			const [count, setCount] = useState(0);
			const [bucket, setBucket] = useState(viewBucket.value);
			useEffect(() => subscribeViewBucket(() => setBucket(viewBucket.value)), []);
			const [archMode, setArchMode] = useState(archiveView.value);
			useEffect(() => subscribeArchiveView(() => setArchMode(archiveView.value)), []);
			const [laneV, setLaneVState] = useState(laneView.value);
			useEffect(() => subscribeLaneView(() => setLaneVState(laneView.value)), []);
			useEffect(() => {
				const workspace = bucket ?? void 0;
				if (workspace === void 0 && sessionId === void 0) return;
				const tick = () => {
					const ctrl = new AbortController();
					const tid = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
					fetch(listUrl(workspace, sessionId), { signal: ctrl.signal }).then((r) => r.json()).then((data) => setCount(data?.ok === true ? (data.sessions ?? []).filter((n) => !(archMode === "hide" && n.archived === true) && !(bucket === "__global__" && laneV.hidden.has(n.bucket))).length : 0)).catch(() => {}).finally(() => clearTimeout(tid));
				};
				tick();
				const iv = setInterval(tick, 12e3);
				return () => clearInterval(iv);
			}, [
				bucket,
				sessionId,
				archMode,
				laneV
			]);
			return h("span", null, t("panel.title") + (count > 0 ? t("fmt.count", { count }) : ""));
		}
		function apply(ctx) {
			const localeSrv = ctx.locale;
			if (localeSrv !== void 0) {
				ctx.effect(() => localeSrv.register(NS, dictionaries), "session-timeline: dictionaries");
				T = localeSrv.bind(NS);
			}
			const t = T;
			const seat = localeSrv !== void 0 ? { locale: NS } : {};
			const openSession = (id) => {
				try {
					ctx.uiWorkspace?.openSession(id);
				} catch {}
			};
			const Panel = (props) => h(PanelBoundary, null, h(PanelBody, {
				sessionId: props.sessionId,
				openSession,
				ctx,
				t: props.t ?? T
			}));
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: TAB_KIND,
				priority: "extension",
				title: () => t("panel.title"),
				guide: [{
					id: "session-timeline",
					order: 91,
					title: () => t("panel.title"),
					description: () => t("guide.description"),
					icon: P.IconBranchOutlineRegular
				}]
			}), "session-timeline: tab type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				...seat
			}, Panel)), "session-timeline: tab body");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab.title", () => ctx.slots.register({
				name: "sidebar.right.pane.tab.title",
				key: TAB_ID,
				...seat
			}, TabTitle)), "session-timeline: tab title");
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map