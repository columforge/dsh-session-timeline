window.__ModuleLoader__.load({
	id: "@dsh-external/session-timeline",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		function computeLayout(nodesIn, edges, manualLinks) {
			const nodes = nodesIn;
			const colOf = /* @__PURE__ */ new Map();
			const sideOf = /* @__PURE__ */ new Map();
			const depthOf = /* @__PURE__ */ new Map();
			const nativeParent = /* @__PURE__ */ new Map();
			for (const e of edges) nativeParent.set(e.to, e.from);
			const manualParent = /* @__PURE__ */ new Map();
			for (const l of manualLinks) manualParent.set(l.to, l.from);
			const byCreation = [...nodesIn].sort((a, b) => a.createdAt - b.createdAt || (a.id < b.id ? -1 : 1));
			let flip = 0;
			let upMax = 0;
			let downMax = 0;
			const pending = byCreation;
			let progressed = true;
			while (pending.length > 0 && progressed) {
				progressed = false;
				for (let pi = pending.length - 1; pi >= 0; pi--) {
					const n = pending[pi];
					const np = nativeParent.get(n.id);
					const mp = manualParent.get(n.id);
					const dep = np ?? mp;
					if (dep !== void 0 && !sideOf.has(dep)) continue;
					let side;
					let depth;
					if (dep !== void 0) {
						side = sideOf.get(dep) ?? "up";
						depth = (depthOf.get(dep) ?? 0) + 1;
					} else {
						side = flip % 2 === 0 ? "up" : "down";
						depth = 0;
						flip += 1;
					}
					sideOf.set(n.id, side);
					depthOf.set(n.id, depth);
					if (side === "up" && depth > upMax) upMax = depth;
					if (side === "down" && depth > downMax) downMax = depth;
					pending.splice(pi, 1);
					progressed = true;
				}
			}
			for (const n of pending) {
				const side = flip % 2 === 0 ? "up" : "down";
				sideOf.set(n.id, side);
				depthOf.set(n.id, 0);
				flip += 1;
			}
			nodesIn.forEach((n, i) => {
				colOf.set(n.id, i);
			});
			const upBlock = (upMax + 1) * 96 + upMax * 16;
			const downBlock = (downMax + 1) * 96 + downMax * 16;
			const axisY = 16 + upBlock + 26;
			const rowTop = (side, depth) => side === "up" ? axisY - 26 - 96 - depth * 112 : axisY + 26 + depth * 112;
			let upOuter = Infinity;
			let downOuter = -Infinity;
			for (const n of nodes) {
				const t = rowTop(sideOf.get(n.id) ?? "up", depthOf.get(n.id) ?? 0);
				if ((sideOf.get(n.id) ?? "up") === "up") upOuter = Math.min(upOuter, t);
				else downOuter = Math.max(downOuter, t + 96);
			}
			const corridorUp = (upOuter === Infinity ? 16 : upOuter) - 12;
			const corridorDown = (downOuter === -Infinity ? axisY + 26 + 96 : downOuter) + 12;
			return {
				nodes,
				colOf,
				sideOf,
				depthOf,
				axisY,
				innerW: Math.max(nodes.length * 140 + 24, 320),
				innerH: axisY + 26 + downBlock + 16,
				maxDepth: Math.max(upMax, downMax),
				corridorUp,
				corridorDown
			};
		}
		function colX(layout, id) {
			return (layout.colOf.get(id) ?? 0) * 140 + 140 / 2;
		}
		function nodeTop(layout, id) {
			const side = layout.sideOf.get(id) ?? "up";
			const depth = layout.depthOf.get(id) ?? 0;
			if (side === "up") return layout.axisY - 26 - 96 - depth * 112;
			return layout.axisY + 26 + depth * 112;
		}
		/** Does the orthogonal segment (x1,y1)-(x2,y2) cross any obstacle (open interval; edge-touching allowed)? */
		function segHitsObstacle(x1, y1, x2, y2, obs) {
			for (const o of obs) {
				const l = o.x;
				const r = o.x + o.w;
				const t = o.y;
				const b = o.y + o.h;
				if (x1 === x2) {
					if (x1 > l && x1 < r) {
						if (Math.max(y1, y2) > t && Math.min(y1, y2) < b) return true;
					}
				} else if (y1 === y2) {
					if (y1 > t && y1 < b) {
						if (Math.max(x1, x2) > l && Math.min(x1, x2) < r) return true;
					}
				}
			}
			return false;
		}
		function routeOrthogonal(obstacles, sx, sy, tx, ty, occupied, corridorYs = []) {
			const xsRaw = [sx, tx];
			const ysRaw = [sy, ty];
			for (const o of obstacles) {
				xsRaw.push(o.x - 8, o.x + o.w + 8);
				ysRaw.push(o.y - 8, o.y + o.h + 8);
			}
			const merge = (arr) => {
				const a = [...arr].sort((p, q) => p - q);
				const out = [];
				for (const v of a) if (out.length === 0 || v - out[out.length - 1] > 6) out.push(v);
				return out;
			};
			const xs = merge(xsRaw);
			const ys = merge(ysRaw);
			const xIdx = new Map(xs.map((v, i) => [v, i]));
			const yIdx = new Map(ys.map((v, i) => [v, i]));
			const near = (arr, v) => {
				let best = arr[0];
				for (const c of arr) if (Math.abs(c - v) < Math.abs(best - v)) best = c;
				return best;
			};
			const s = {
				x: xIdx.get(near(xs, sx)) ?? 0,
				y: yIdx.get(near(ys, sy)) ?? 0
			};
			const t = {
				x: xIdx.get(near(xs, tx)) ?? 0,
				y: yIdx.get(near(ys, ty)) ?? 0
			};
			const crowd = (x1, y1, x2, y2) => {
				const key = x1 === x2 ? "v" + String(x1) : "h" + String(y1);
				return (occupied.get(key) ?? 0) * 30;
			};
			const mark = (x1, y1, x2, y2) => {
				const key = x1 === x2 ? "v" + String(x1) : "h" + String(y1);
				occupied.set(key, (occupied.get(key) ?? 0) + 1);
			};
			const keyOf = (x, y) => String(x) + "," + String(y);
			const open = [{
				x: s.x,
				y: s.y,
				g: 0,
				f: 0,
				dir: "",
				parent: null
			}];
			const bestG = new Map([[keyOf(s.x, s.y), 0]]);
			const parentMap = /* @__PURE__ */ new Map();
			const h = (x, y) => Math.abs(x - xs[t.x]) + Math.abs(y - ys[t.y]);
			let expanded = 0;
			while (open.length > 0 && expanded < 6e4) {
				open.sort((a, b) => a.f - b.f);
				const cur = open.shift();
				if (cur === void 0) break;
				expanded += 1;
				const ck = keyOf(cur.x, cur.y);
				if ((bestG.get(ck) ?? Infinity) < cur.g) continue;
				if (cur.x === t.x && cur.y === t.y) break;
				const neighbors = [
					[
						cur.x + 1,
						cur.y,
						"h"
					],
					[
						cur.x - 1,
						cur.y,
						"h"
					],
					[
						cur.x,
						cur.y + 1,
						"v"
					],
					[
						cur.x,
						cur.y - 1,
						"v"
					]
				];
				for (const [nx, ny, ndir] of neighbors) {
					if (nx < 0 || ny < 0 || nx >= xs.length || ny >= ys.length) continue;
					const ax = xs[cur.x];
					const ay = ys[cur.y];
					const bx = xs[nx];
					const by = ys[ny];
					if (segHitsObstacle(ax, ay, bx, by, obstacles)) continue;
					const turn = cur.dir !== "" && cur.dir !== ndir ? 10 : 0;
					const g = cur.g + (Math.abs(bx - ax) + Math.abs(by - ay)) + turn + crowd(ax, ay, bx, by);
					const nk = keyOf(nx, ny);
					if (g < (bestG.get(nk) ?? Infinity)) {
						bestG.set(nk, g);
						parentMap.set(nk, ck);
						open.push({
							x: nx,
							y: ny,
							g,
							f: g + h(xs[nx], ys[ny]),
							dir: ndir,
							parent: ck
						});
					}
				}
			}
			if (!parentMap.has(keyOf(t.x, t.y))) {
				const bad = (path) => {
					const nums = path.match(/-?\d+(\.\d+)?/g) ?? [];
					const pts = [];
					for (let i = 0; i < nums.length; i += 2) pts.push([Number(nums[i]), Number(nums[i + 1])]);
					let n = 0;
					for (let i = 0; i + 1 < pts.length; i++) for (const o of obstacles) {
						const l = o.x;
						const r = o.x + o.w;
						const tp = o.y;
						const bt = o.y + o.h;
						if (pts[i][0] === pts[i + 1][0]) {
							if (pts[i][0] > l && pts[i][0] < r && Math.max(pts[i][1], pts[i + 1][1]) > tp && Math.min(pts[i][1], pts[i + 1][1]) < bt) n += 1;
						} else if (pts[i][1] > tp && pts[i][1] < bt && Math.max(pts[i][0], pts[i + 1][0]) > l && Math.min(pts[i][0], pts[i + 1][0]) < r) n += 1;
					}
					return n;
				};
				const candidates = [];
				for (const cy of corridorYs) candidates.push("M " + String(sx) + " " + String(sy) + " L " + String(sx) + " " + String(cy) + " L " + String(tx) + " " + String(cy) + " L " + String(tx) + " " + String(ty));
				candidates.push("M " + String(sx) + " " + String(sy) + " L " + String(sx) + " " + String(ty) + " L " + String(tx) + " " + String(ty));
				candidates.push("M " + String(sx) + " " + String(sy) + " L " + String(tx) + " " + String(sy) + " L " + String(tx) + " " + String(ty));
				let best = null;
				let bestBad = Infinity;
				for (const c of candidates) {
					const b = bad(c);
					if (b === 0) return c;
					if (b < bestBad) {
						bestBad = b;
						best = c;
					}
				}
				return best ?? candidates[0];
			}
			const pts = [];
			let ck = keyOf(t.x, t.y);
			const seen = /* @__PURE__ */ new Set();
			for (;;) {
				pts.unshift([xs[Number(ck.split(",")[0])], ys[Number(ck.split(",")[1])]]);
				seen.add(ck);
				const par = parentMap.get(ck);
				if (par === void 0 || seen.has(par)) break;
				ck = par;
			}
			pts.unshift([sx, sy]);
			pts.push([tx, ty]);
			const outPts = [];
			for (const pt of pts) {
				const n = outPts.length;
				if (n >= 2 && outPts[n - 1][0] === pt[0] === (outPts[n - 2][0] === outPts[n - 1][0])) outPts[outPts.length - 1] = pt;
				else if (n === 0 || outPts[n - 1][0] !== pt[0] || outPts[n - 1][1] !== pt[1]) outPts.push(pt);
			}
			for (let i = 0; i + 1 < outPts.length; i++) mark(outPts[i][0], outPts[i][1], outPts[i + 1][0], outPts[i + 1][1]);
			return "M " + outPts.map((p) => String(p[0]) + " " + String(p[1])).join(" L ");
		}
		function routeEdgePath(opts) {
			const { layout, obstacles, occupied, from, to, step } = opts;
			const fUp = (layout.sideOf.get(from) ?? "up") === "up";
			const tUp = (layout.sideOf.get(to) ?? "up") === "up";
			const fTop = nodeTop(layout, from);
			const tTop = nodeTop(layout, to);
			const fx = colX(layout, from);
			const tx = colX(layout, to);
			const j = step % 3 - 1;
			const childOnRight = tx > fx;
			const exitSideX = childOnRight ? fx + 132 / 2 + 3 : fx - 132 / 2 - 3;
			const entrySideX = childOnRight ? tx - 132 / 2 - 3 : tx + 132 / 2 + 3;
			const exitCandidates = [{
				x: fx + j * 10,
				y: fUp ? fTop - 3 : fTop + 96 + 3
			}, {
				x: exitSideX,
				y: fTop + 96 / 2 + j * 6
			}];
			const entryCandidates = [{
				x: entrySideX,
				y: tTop + 96 / 2 + j * 6
			}, {
				x: tx + j * 10,
				y: tUp ? tTop - 3 : tTop + 96 + 3
			}];
			let fallback = null;
			for (const ec of exitCandidates) for (const en of entryCandidates) {
				const d = routeOrthogonal(obstacles, ec.x, ec.y, en.x, en.y, occupied);
				if (d === "") continue;
				if ((d.match(/L/g) || []).length >= 1) return d;
				if (fallback === null) fallback = d;
			}
			return fallback ?? "";
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
		function computeLanesLayout(nodesIn, edges, manualLinks, laneOfNode, collapsed) {
			const colOf = /* @__PURE__ */ new Map();
			let ci = 0;
			for (const n of nodesIn) {
				if (collapsed !== void 0 && collapsed.has(laneOfNode(n))) continue;
				colOf.set(n.id, ci);
				ci += 1;
			}
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
			const laneOf = /* @__PURE__ */ new Map();
			const laneById = /* @__PURE__ */ new Map();
			const lanes = [];
			let y = 26;
			for (const laneId of laneIds) {
				if (collapsed !== void 0 && collapsed.has(laneId)) {
					const lane = {
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
					laneById.set(laneId, lane);
					lanes.push(lane);
					y += 54;
					continue;
				}
				const laneNodes = byLane.get(laneId) ?? [];
				const member = new Set(laneNodes.map((n) => n.id));
				const base = computeLayout(laneNodes, edges.filter((e) => member.has(e.from) && member.has(e.to)), manualLinks.filter((l) => member.has(l.from) && member.has(l.to)));
				const laneColOf = /* @__PURE__ */ new Map();
				for (const n of laneNodes) laneColOf.set(n.id, colOf.get(n.id) ?? 0);
				const lane = {
					...base,
					id: laneId,
					top: y,
					collapsed: false,
					colOf: laneColOf,
					axisY: base.axisY + y,
					corridorUp: base.corridorUp + y,
					corridorDown: base.corridorDown + y
				};
				for (const n of laneNodes) laneOf.set(n.id, laneId);
				laneById.set(laneId, lane);
				lanes.push(lane);
				y += base.innerH + 26;
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
			"fmt.listSep": "；",
			"fmt.enumSep": "、",
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
			"node.tag.awaitParent": "待接前驱",
			"node.tag.awaitChild": "待接后继",
			"node.tag.externalParent": "外部父",
			"node.tag.archived": "归档",
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
			"stats.summary": "{sessions} 会话 · 衔接 {handoff} · 分支 {branch} · 手工 {manual}",
			"stats.unreadable": "· {count} 个不可读",
			"stats.archived": "归档 {count}",
			"zoom.out": "缩小（10%）",
			"zoom.in": "放大（10%）",
			"zoom.fit": "100%（原始比例）",
			"zoom.reset": "点击复位 100%",
			"canvas.hint": "空白处按住拖拽 = 平移 · 滚轮 = 上下滚动 · 画布缩放用左上角 −/+",
			"legend.groupActions": "操作",
			"legend.groupCanvas": "画布",
			"legend.groupLineage": "血缘链",
			"legend.action.dragNode": "拖动节点到另一节点",
			"legend.action.doubleClick": "双击",
			"legend.action.click": "单击",
			"legend.action.dragEmpty": "空白处拖拽",
			"legend.action.wheel": "滚轮",
			"legend.action.zoom": "缩放",
			"legend.meaning.manual": "手工衔接",
			"legend.meaning.switchSession": "切换会话",
			"legend.meaning.details": "会话详情",
			"legend.meaning.pan": "平移",
			"legend.meaning.scroll": "滚动画布",
			"legend.meaning.zoomControls": "只走左上角 −/+",
			"legend.action.laneToggle": "单击泳道名",
			"legend.meaning.laneToggle": "折叠/展开该泳道",
			"legend.lineageDefinition": "原生边 ∪ 手工衔接",
			"legend.action.mergedCriteria": "⑂N 徽章 / 分支判定 / 金紫框 / 详情血缘叙述",
			"legend.meaning.mergedChain": "均按合并链计算",
			"legend.line.handoff": "链式 handoff（父单子）",
			"legend.line.branch": "分支/扇出（父后继 ≥ 2，手工后继计入）",
			"legend.line.manual": "手工衔接（host 按创建时间定向）",
			"legend.frame.awaitParent": "待接前驱：首对话调用过 handoff 且无前驱",
			"legend.frame.awaitChild": "待接后继：出现过 handoff 调用且无后继",
			"legend.frame.archived": "归档会话：虚线框（「隐藏归档会话」下不显示）",
			"legend.tag.handoff": "调用过 handoff skill 或以 handoff 种子开场",
			"legend.footer": "选中会话可在详情区查看 handoff 调用的轮次与时间。",
			"detail.hint": "外框滚轮 = 上一轮/下一轮 · 点轮次条直达 · 内容框内滚轮翻看对话",
			"detail.open": "切换到该会话",
			"detail.lastActive": "活动至 {time}",
			"detail.created": "（创建 {time}）",
			"detail.logCreated": "日志创建 {time}",
			"detail.seeded": "handoff 种子开场",
			"detail.forkInferred": "原生 fork（血缘按继承前缀推断）",
			"detail.forkSourceMissing": "fork：来源缺失（已删或不在本工作区）",
			"detail.archived": "已归档",
			"lineage.prefix": "血缘：",
			"lineage.root": "无父会话（根会话）",
			"lineage.from": "衔接自「{title}」",
			"lineage.fromMissing": "父会话 {id} 不在当前视图（跨区 handoff 或已删除）",
			"edge.kind.branch": "（分支）",
			"edge.kind.manual": "（手工）",
			"lineage.outPrefix": "衔接到：",
			"lineage.outItem": "「{title}」{mark}",
			"link.disconnect": "断开",
			"link.disconnectTitle": "断开该手工衔接",
			"handoff.summary": "handoff skill：共 {count} 次调用",
			"handoff.mark.awaitParent": "（待接前驱·紫）",
			"handoff.mark.awaitChild": "（待接后继·金）",
			"handoff.hit": "· 第 {turn} 轮 · {time} · 消息 #{seq}",
			"handoff.timeUnknown": "时间未知",
			"turns.position": "第 {turn} / {total} 轮",
			"turns.suffixHandoff": "· handoff 调用轮",
			"turns.suffixFirst": "· 首轮",
			"turns.suffixLast": "· 末轮",
			"turns.none": "无对话轮",
			"turns.barTitle": "第 {turn} 轮",
			"turns.contentHint": "滚轮上下滑动翻看对话内容",
			"turns.roleUser": "用户：",
			"turns.roleAssistant": "助手：",
			"turns.noUserText": "（无文本）",
			"turns.noAssistantReply": "（本轮暂无助手回复）",
			"turns.reasoningPrefix": "[推理] ",
			"turns.truncated": "…（已截断）"
		};
		/** 语种 → 词典（client 注册用；zh 键位为基准）。 */
		const dictionaries = {
			zh,
			en: {
				"panel.title": "Session Timeline",
				"fmt.listSep": "; ",
				"fmt.enumSep": ", ",
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
				"node.tag.awaitParent": "Awaiting parent",
				"node.tag.awaitChild": "Awaiting child",
				"node.tag.externalParent": "External parent",
				"node.tag.archived": "Archived",
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
				"stats.summary": "{sessions} sessions · linked {handoff} · branch {branch} · manual {manual}",
				"stats.unreadable": "· {count} unreadable",
				"stats.archived": "{count} archived",
				"zoom.out": "Zoom out (10%)",
				"zoom.in": "Zoom in (10%)",
				"zoom.fit": "100% (actual size)",
				"zoom.reset": "Click to reset to 100%",
				"canvas.hint": "Drag empty space to pan · Wheel scrolls up/down · Zoom with −/+ at top left",
				"legend.groupActions": "Actions",
				"legend.groupCanvas": "Canvas",
				"legend.groupLineage": "Lineage",
				"legend.action.dragNode": "Drag a node onto another",
				"legend.action.doubleClick": "Double-click",
				"legend.action.click": "Click",
				"legend.action.dragEmpty": "Drag empty space",
				"legend.action.wheel": "Wheel",
				"legend.action.zoom": "Zoom",
				"legend.meaning.manual": "manual link",
				"legend.meaning.switchSession": "switch session",
				"legend.meaning.details": "session details",
				"legend.meaning.pan": "pan",
				"legend.meaning.scroll": "scroll the canvas",
				"legend.meaning.zoomControls": "−/+ at top left only",
				"legend.action.laneToggle": "Click a lane name",
				"legend.meaning.laneToggle": "collapse/expand that lane",
				"legend.lineageDefinition": "native edges ∪ manual links",
				"legend.action.mergedCriteria": "⑂N badge / branch verdict / gold-purple frames / lineage narration",
				"legend.meaning.mergedChain": "computed on the merged chain",
				"legend.line.handoff": "Chained handoff (single child)",
				"legend.line.branch": "Branch/fan-out (parent has ≥ 2 children, manual links count)",
				"legend.line.manual": "Manual link (oriented by creation time)",
				"legend.frame.awaitParent": "Awaiting parent: called the handoff skill in the first turn and has no parent",
				"legend.frame.awaitChild": "Awaiting child: a handoff call appeared and there is no successor",
				"legend.frame.archived": "Archived session (dashed frame; hidden in hide mode)",
				"legend.tag.handoff": "Called the handoff skill or seeded from a handoff",
				"legend.footer": "Select a session to inspect its handoff call turns and times in the details area.",
				"detail.hint": "Wheel on the frame = previous/next turn · click a turn bar to jump · wheel inside scrolls the conversation",
				"detail.open": "Switch to this session",
				"detail.lastActive": "active until {time}",
				"detail.created": "(created {time})",
				"detail.logCreated": "log created {time}",
				"detail.seeded": "handoff-seeded opening",
				"detail.forkInferred": "native fork (lineage inferred from the inherited prefix)",
				"detail.forkSourceMissing": "fork: source missing (deleted or outside this workspace)",
				"detail.archived": "archived",
				"lineage.prefix": "Lineage: ",
				"lineage.root": "no parent session (root session)",
				"lineage.from": "linked from “{title}”",
				"lineage.fromMissing": "parent session {id} is not in the current view (cross-workspace handoff or deleted)",
				"edge.kind.branch": "(branch)",
				"edge.kind.manual": "(manual)",
				"lineage.outPrefix": "Links to: ",
				"lineage.outItem": "“{title}”{mark}",
				"link.disconnect": "Unlink",
				"link.disconnectTitle": "Remove this manual link",
				"handoff.summary": "handoff skill: {count} call(s)",
				"handoff.mark.awaitParent": "(awaiting parent · purple)",
				"handoff.mark.awaitChild": "(awaiting child · gold)",
				"handoff.hit": "· turn {turn} · {time} · message #{seq}",
				"handoff.timeUnknown": "time unknown",
				"turns.position": "Turn {turn} / {total}",
				"turns.suffixHandoff": " · handoff turn",
				"turns.suffixFirst": " · first turn",
				"turns.suffixLast": " · last turn",
				"turns.none": "No conversation turns",
				"turns.barTitle": "Turn {turn}",
				"turns.contentHint": "Scroll up/down to page through the conversation",
				"turns.roleUser": "User: ",
				"turns.roleAssistant": "Assistant: ",
				"turns.noUserText": "(no text)",
				"turns.noAssistantReply": "(no assistant reply this turn)",
				"turns.reasoningPrefix": "[reasoning] ",
				"turns.truncated": "… (truncated)"
			},
			ja: {
				"panel.title": "セッションタイムライン",
				"fmt.listSep": "；",
				"fmt.enumSep": "、",
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
				"node.tag.awaitParent": "親待ち",
				"node.tag.awaitChild": "子待ち",
				"node.tag.externalParent": "外部親",
				"node.tag.archived": "アーカイブ",
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
				"stats.summary": "{sessions} セッション · 接続 {handoff} · 分岐 {branch} · 手動 {manual}",
				"stats.unreadable": "· {count} 件読取不可",
				"stats.archived": "アーカイブ {count}",
				"zoom.out": "縮小（10%）",
				"zoom.in": "拡大（10%）",
				"zoom.fit": "100%（等倍）",
				"zoom.reset": "クリックで 100% に戻す",
				"canvas.hint": "空白部ドラッグ = パン · ホイール = 上下スクロール · 拡大縮小は左上の −/+",
				"legend.groupActions": "操作",
				"legend.groupCanvas": "キャンバス",
				"legend.groupLineage": "血縁チェーン",
				"legend.action.dragNode": "ノードを別ノードへドラッグ",
				"legend.action.doubleClick": "ダブルクリック",
				"legend.action.click": "クリック",
				"legend.action.dragEmpty": "空白部をドラッグ",
				"legend.action.wheel": "ホイール",
				"legend.action.zoom": "ズーム",
				"legend.meaning.manual": "手動接続",
				"legend.meaning.switchSession": "セッション切替",
				"legend.meaning.details": "セッション詳細",
				"legend.meaning.pan": "パン",
				"legend.meaning.scroll": "キャンバスをスクロール",
				"legend.meaning.zoomControls": "左上の −/+ のみ",
				"legend.action.laneToggle": "レーン名をクリック",
				"legend.meaning.laneToggle": "レーンを折りたたみ／展開",
				"legend.lineageDefinition": "ネイティブ辺 ∪ 手動接続",
				"legend.action.mergedCriteria": "⑂N バッジ／分岐判定／金紫枠／詳細の血縁説明",
				"legend.meaning.mergedChain": "すべて統合チェーンで計算",
				"legend.line.handoff": "連鎖 handoff（単一の子）",
				"legend.line.branch": "分岐／ファンアウト（子 ≥ 2、手動接続も算入）",
				"legend.line.manual": "手動接続（作成時刻で方向決定）",
				"legend.frame.awaitParent": "親待ち：最初のターンで handoff skill を呼び出し、親がいない",
				"legend.frame.awaitChild": "子待ち：handoff 呼び出しがあり、後継がいない",
				"legend.frame.archived": "アーカイブ済みセッション（破線枠、非表示モードでは表示されない）",
				"legend.tag.handoff": "handoff skill を呼び出した、または handoff シードで開始",
				"legend.footer": "セッションを選択すると、詳細エリアで handoff 呼び出しのターンと時刻を確認できます。",
				"detail.hint": "外枠ホイール = 前／次のターン · ターンバーをクリックで直接移動 · 内容枠内ホイールで会話を閲覧",
				"detail.open": "このセッションへ切替",
				"detail.lastActive": "最終活動 {time}",
				"detail.created": "（作成 {time}）",
				"detail.logCreated": "ログ作成 {time}",
				"detail.seeded": "handoff シード開始",
				"detail.forkInferred": "ネイティブ fork（血縁は継承プレフィックスから推定）",
				"detail.forkSourceMissing": "fork：ソース不明（削除またはこのワークスペース外）",
				"detail.archived": "アーカイブ済み",
				"lineage.prefix": "血縁：",
				"lineage.root": "親セッションなし（ルートセッション）",
				"lineage.from": "「{title}」から接続",
				"lineage.fromMissing": "親セッション {id} は現在のビューにありません（ワークスペース跨ぎ handoff または削除済み）",
				"edge.kind.branch": "（分岐）",
				"edge.kind.manual": "（手動）",
				"lineage.outPrefix": "接続先：",
				"lineage.outItem": "「{title}」{mark}",
				"link.disconnect": "解除",
				"link.disconnectTitle": "この手動接続を解除",
				"handoff.summary": "handoff skill：{count} 回の呼び出し",
				"handoff.mark.awaitParent": "（親待ち・紫）",
				"handoff.mark.awaitChild": "（子待ち・金）",
				"handoff.hit": "· 第 {turn} ターン · {time} · メッセージ #{seq}",
				"handoff.timeUnknown": "時刻不明",
				"turns.position": "第 {turn} ／ {total} ターン",
				"turns.suffixHandoff": "· handoff 呼び出しターン",
				"turns.suffixFirst": "· 最初のターン",
				"turns.suffixLast": "· 最後のターン",
				"turns.none": "会話ターンなし",
				"turns.barTitle": "第 {turn} ターン",
				"turns.contentHint": "ホイールの上下で会話内容を閲覧",
				"turns.roleUser": "ユーザー：",
				"turns.roleAssistant": "アシスタント：",
				"turns.noUserText": "（テキストなし）",
				"turns.noAssistantReply": "（このターンのアシスタント返信なし）",
				"turns.reasoningPrefix": "[推論] ",
				"turns.truncated": "…（切り捨て）"
			},
			es: {
				"panel.title": "Línea temporal de sesiones",
				"fmt.listSep": "; ",
				"fmt.enumSep": ", ",
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
				"node.tag.awaitParent": "Esperando padre",
				"node.tag.awaitChild": "Esperando hijo",
				"node.tag.externalParent": "Padre externo",
				"node.tag.archived": "Archivada",
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
				"stats.summary": "{sessions} sesiones · enlaces {handoff} · ramas {branch} · manuales {manual}",
				"stats.unreadable": "· {count} ilegibles",
				"stats.archived": "{count} archivadas",
				"zoom.out": "Reducir (10%)",
				"zoom.in": "Ampliar (10%)",
				"zoom.fit": "100% (tamaño real)",
				"zoom.reset": "Clic para volver al 100%",
				"canvas.hint": "Arrastra el espacio vacío para desplazar · La rueda hace scroll · Zoom con −/+ arriba a la izquierda",
				"legend.groupActions": "Acciones",
				"legend.groupCanvas": "Lienzo",
				"legend.groupLineage": "Linaje",
				"legend.action.dragNode": "Arrastra un nodo sobre otro",
				"legend.action.doubleClick": "Doble clic",
				"legend.action.click": "Clic",
				"legend.action.dragEmpty": "Arrastrar en espacio vacío",
				"legend.action.wheel": "Rueda",
				"legend.action.zoom": "Zoom",
				"legend.meaning.manual": "enlace manual",
				"legend.meaning.switchSession": "cambiar de sesión",
				"legend.meaning.details": "detalles de la sesión",
				"legend.meaning.pan": "desplazar",
				"legend.meaning.scroll": "desplazar el lienzo",
				"legend.meaning.zoomControls": "solo −/+ arriba a la izquierda",
				"legend.action.laneToggle": "Clic en el nombre de una línea",
				"legend.meaning.laneToggle": "plegar/desplegar esa línea",
				"legend.lineageDefinition": "aristas nativas ∪ enlaces manuales",
				"legend.action.mergedCriteria": "insignia ⑂N / veredicto de rama / marcos oro-púrpura / relato de linaje",
				"legend.meaning.mergedChain": "calculado sobre la cadena combinada",
				"legend.line.handoff": "Handoff en cadena (un solo hijo)",
				"legend.line.branch": "Rama/abanico (padre con ≥ 2 hijos, los manuales cuentan)",
				"legend.line.manual": "Enlace manual (orientado por fecha de creación)",
				"legend.frame.awaitParent": "Esperando padre: llamó al skill handoff en el primer turno y no tiene padre",
				"legend.frame.awaitChild": "Esperando hijo: hubo una llamada handoff y no tiene sucesor",
				"legend.frame.archived": "Sesión archivada (borde discontinuo; oculta en modo ocultar)",
				"legend.tag.handoff": "Llamó al skill handoff o empezó desde una semilla handoff",
				"legend.footer": "Selecciona una sesión para ver los turnos y horas de sus llamadas handoff en el área de detalles.",
				"detail.hint": "Rueda en el marco = turno anterior/siguiente · clic en una barra para saltar · rueda dentro para leer la conversación",
				"detail.open": "Cambiar a esta sesión",
				"detail.lastActive": "activo hasta {time}",
				"detail.created": "(creada {time})",
				"detail.logCreated": "registro creado {time}",
				"detail.seeded": "inicio con semilla handoff",
				"detail.forkInferred": "fork nativo (linaje inferido del prefijo heredado)",
				"detail.forkSourceMissing": "fork: origen desconocido (eliminado o fuera de este espacio)",
				"detail.archived": "archivada",
				"lineage.prefix": "Linaje: ",
				"lineage.root": "sin sesión padre (sesión raíz)",
				"lineage.from": "enlazada desde «{title}»",
				"lineage.fromMissing": "la sesión padre {id} no está en la vista actual (handoff entre espacios o eliminada)",
				"edge.kind.branch": "(rama)",
				"edge.kind.manual": "(manual)",
				"lineage.outPrefix": "Enlaza a: ",
				"lineage.outItem": "«{title}»{mark}",
				"link.disconnect": "Desenlazar",
				"link.disconnectTitle": "Quitar este enlace manual",
				"handoff.summary": "skill handoff: {count} llamada(s)",
				"handoff.mark.awaitParent": "(esperando padre · púrpura)",
				"handoff.mark.awaitChild": "(esperando hijo · oro)",
				"handoff.hit": "· turno {turn} · {time} · mensaje #{seq}",
				"handoff.timeUnknown": "hora desconocida",
				"turns.position": "Turno {turn} / {total}",
				"turns.suffixHandoff": " · turno handoff",
				"turns.suffixFirst": " · primer turno",
				"turns.suffixLast": " · último turno",
				"turns.none": "Sin turnos de conversación",
				"turns.barTitle": "Turno {turn}",
				"turns.contentHint": "Rueda arriba/abajo para hojear la conversación",
				"turns.roleUser": "Usuario: ",
				"turns.roleAssistant": "Asistente: ",
				"turns.noUserText": "(sin texto)",
				"turns.noAssistantReply": "(sin respuesta del asistente en este turno)",
				"turns.reasoningPrefix": "[razonamiento] ",
				"turns.truncated": "… (recortado)"
			},
			fr: {
				"panel.title": "Chronologie des sessions",
				"fmt.listSep": " ; ",
				"fmt.enumSep": ", ",
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
				"node.tag.awaitParent": "Parent attendu",
				"node.tag.awaitChild": "Enfant attendu",
				"node.tag.externalParent": "Parent externe",
				"node.tag.archived": "Archivée",
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
				"stats.summary": "{sessions} sessions · liens {handoff} · branches {branch} · manuels {manual}",
				"stats.unreadable": "· {count} illisibles",
				"stats.archived": "{count} archivées",
				"zoom.out": "Réduire (10 %)",
				"zoom.in": "Agrandir (10 %)",
				"zoom.fit": "100 % (taille réelle)",
				"zoom.reset": "Cliquer pour revenir à 100 %",
				"canvas.hint": "Glisser le vide pour déplacer · Molette = défilement vertical · Zoom via −/+ en haut à gauche",
				"legend.groupActions": "Actions",
				"legend.groupCanvas": "Canevas",
				"legend.groupLineage": "Filiation",
				"legend.action.dragNode": "Glisser un nœud sur un autre",
				"legend.action.doubleClick": "Double-clic",
				"legend.action.click": "Clic",
				"legend.action.dragEmpty": "Glisser dans le vide",
				"legend.action.wheel": "Molette",
				"legend.action.zoom": "Zoom",
				"legend.meaning.manual": "lien manuel",
				"legend.meaning.switchSession": "changer de session",
				"legend.meaning.details": "détails de la session",
				"legend.meaning.pan": "déplacer",
				"legend.meaning.scroll": "faire défiler le canevas",
				"legend.meaning.zoomControls": "uniquement −/+ en haut à gauche",
				"legend.action.laneToggle": "Cliquer le nom d’une ligne",
				"legend.meaning.laneToggle": "plier/déplier cette ligne",
				"legend.lineageDefinition": "arêtes natives ∪ liens manuels",
				"legend.action.mergedCriteria": "badge ⑂N / verdict de branche / cadres or-violet / récit de filiation",
				"legend.meaning.mergedChain": "calculés sur la chaîne fusionnée",
				"legend.line.handoff": "Handoff en chaîne (enfant unique)",
				"legend.line.branch": "Branche/éventail (parent à ≥ 2 enfants, liens manuels compris)",
				"legend.line.manual": "Lien manuel (orienté par date de création)",
				"legend.frame.awaitParent": "Parent attendu : a appelé le skill handoff au premier tour et n’a pas de parent",
				"legend.frame.awaitChild": "Enfant attendu : un appel handoff est apparu et il n’a pas de successeur",
				"legend.frame.archived": "Session archivée (bordure pointillée ; masquée en mode masquer)",
				"legend.tag.handoff": "A appelé le skill handoff ou a démarré d’une graine handoff",
				"legend.footer": "Sélectionnez une session pour voir les tours et horaires de ses appels handoff dans la zone de détails.",
				"detail.hint": "Molette sur le cadre = tour précédent/suivant · cliquez une barre pour y aller · molette intérieure pour lire la conversation",
				"detail.open": "Passer à cette session",
				"detail.lastActive": "active jusqu’à {time}",
				"detail.created": "(créée {time})",
				"detail.logCreated": "journal créé {time}",
				"detail.seeded": "départ par graine handoff",
				"detail.forkInferred": "fork natif (lignée déduite du préfixe hérité)",
				"detail.forkSourceMissing": "fork : source introuvable (supprimée ou hors de cet espace)",
				"detail.archived": "archivée",
				"lineage.prefix": "Filiation : ",
				"lineage.root": "aucune session parente (session racine)",
				"lineage.from": "liée depuis « {title} »",
				"lineage.fromMissing": "la session parente {id} n’est pas dans la vue actuelle (handoff inter-espaces ou supprimée)",
				"edge.kind.branch": "(branche)",
				"edge.kind.manual": "(manuel)",
				"lineage.outPrefix": "Liée vers : ",
				"lineage.outItem": "« {title} »{mark}",
				"link.disconnect": "Délier",
				"link.disconnectTitle": "Supprimer ce lien manuel",
				"handoff.summary": "skill handoff : {count} appel(s)",
				"handoff.mark.awaitParent": "(parent attendu · violet)",
				"handoff.mark.awaitChild": "(enfant attendu · or)",
				"handoff.hit": "· tour {turn} · {time} · message nº {seq}",
				"handoff.timeUnknown": "heure inconnue",
				"turns.position": "Tour {turn} / {total}",
				"turns.suffixHandoff": " · tour handoff",
				"turns.suffixFirst": " · premier tour",
				"turns.suffixLast": " · dernier tour",
				"turns.none": "Aucun tour de conversation",
				"turns.barTitle": "Tour {turn}",
				"turns.contentHint": "Molette haut/bas pour feuilleter la conversation",
				"turns.roleUser": "Utilisateur : ",
				"turns.roleAssistant": "Assistant : ",
				"turns.noUserText": "(aucun texte)",
				"turns.noAssistantReply": "(pas de réponse de l’assistant à ce tour)",
				"turns.reasoningPrefix": "[raisonnement] ",
				"turns.truncated": "… (tronqué)"
			},
			de: {
				"panel.title": "Sitzungs-Timeline",
				"fmt.listSep": "; ",
				"fmt.enumSep": ", ",
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
				"node.tag.awaitParent": "Wartet auf Eltern",
				"node.tag.awaitChild": "Wartet auf Nachfolger",
				"node.tag.externalParent": "Externes Elternteil",
				"node.tag.archived": "Archiviert",
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
				"stats.summary": "{sessions} Sitzungen · verknüpft {handoff} · Zweige {branch} · manuell {manual}",
				"stats.unreadable": "· {count} nicht lesbar",
				"stats.archived": "{count} archiviert",
				"zoom.out": "Verkleinern (10 %)",
				"zoom.in": "Vergrößern (10 %)",
				"zoom.fit": "100 % (Originalgröße)",
				"zoom.reset": "Klicken setzt auf 100 % zurück",
				"canvas.hint": "Leere Stelle ziehen = verschieben · Rad = auf/ab scrollen · Zoom nur über −/+ oben links",
				"legend.groupActions": "Aktionen",
				"legend.groupCanvas": "Leinwand",
				"legend.groupLineage": "Herkunft",
				"legend.action.dragNode": "Knoten auf einen anderen ziehen",
				"legend.action.doubleClick": "Doppelklick",
				"legend.action.click": "Klick",
				"legend.action.dragEmpty": "Leere Stelle ziehen",
				"legend.action.wheel": "Rad",
				"legend.action.zoom": "Zoom",
				"legend.meaning.manual": "manuelle Verknüpfung",
				"legend.meaning.switchSession": "Sitzung wechseln",
				"legend.meaning.details": "Sitzungsdetails",
				"legend.meaning.pan": "verschieben",
				"legend.meaning.scroll": "Leinwand scrollen",
				"legend.meaning.zoomControls": "nur −/+ oben links",
				"legend.action.laneToggle": "Spurnamen anklicken",
				"legend.meaning.laneToggle": "Spur ein-/ausklappen",
				"legend.lineageDefinition": "native Kanten ∪ manuelle Verknüpfungen",
				"legend.action.mergedCriteria": "⑂N-Badge / Zweig-Entscheidung / Gold-Violett-Rahmen / Herkunftsbericht",
				"legend.meaning.mergedChain": "alle über die zusammengeführte Kette berechnet",
				"legend.line.handoff": "Verketteter Handoff (einzelnes Kind)",
				"legend.line.branch": "Zweig/Fächer (Eltern mit ≥ 2 Kindern, manuelle zählen mit)",
				"legend.line.manual": "Manuelle Verknüpfung (nach Erstellungszeit gerichtet)",
				"legend.frame.awaitParent": "Wartet auf Eltern: hat den Handoff-Skill im ersten Zug aufgerufen und hat keinen Elternknoten",
				"legend.frame.awaitChild": "Wartet auf Nachfolger: ein Handoff-Aufruf ist aufgetreten und es gibt keinen Nachfolger",
				"legend.frame.archived": "Archivierte Sitzung (gestrichelter Rahmen; im Ausblend-Modus nicht sichtbar)",
				"legend.tag.handoff": "Hat den Handoff-Skill aufgerufen oder aus einem Handoff-Seed gestartet",
				"legend.footer": "Sitzung auswählen, um im Detailbereich die Züge und Zeiten der Handoff-Aufrufe zu sehen.",
				"detail.hint": "Rad am Rahmen = vorheriger/nächster Zug · Zugbalken anklicken zum Springen · Rad im Inhaltsrahmen blättert die Unterhaltung",
				"detail.open": "Zu dieser Sitzung wechseln",
				"detail.lastActive": "aktiv bis {time}",
				"detail.created": "(erstellt {time})",
				"detail.logCreated": "Protokoll erstellt {time}",
				"detail.seeded": "Handoff-Seed-Start",
				"detail.forkInferred": "native fork (Herkunft aus dem geerbten Präfix abgeleitet)",
				"detail.forkSourceMissing": "fork: Quelle fehlt (gelöscht oder außerhalb dieses Workspace)",
				"detail.archived": "archiviert",
				"lineage.prefix": "Herkunft: ",
				"lineage.root": "keine übergeordnete Sitzung (Wurzelsitzung)",
				"lineage.from": "verknüpft von „{title}“",
				"lineage.fromMissing": "übergeordnete Sitzung {id} ist nicht in der aktuellen Ansicht (arbeitsbereichübergreifender Handoff oder gelöscht)",
				"edge.kind.branch": "(Zweig)",
				"edge.kind.manual": "(manuell)",
				"lineage.outPrefix": "Verknüpft zu: ",
				"lineage.outItem": "„{title}“{mark}",
				"link.disconnect": "Lösen",
				"link.disconnectTitle": "Diese manuelle Verknüpfung lösen",
				"handoff.summary": "Handoff-Skill: {count} Aufruf(e)",
				"handoff.mark.awaitParent": "(wartet auf Eltern · violett)",
				"handoff.mark.awaitChild": "(wartet auf Nachfolger · gold)",
				"handoff.hit": "· Zug {turn} · {time} · Nachricht Nr. {seq}",
				"handoff.timeUnknown": "Zeit unbekannt",
				"turns.position": "Zug {turn} / {total}",
				"turns.suffixHandoff": " · Handoff-Zug",
				"turns.suffixFirst": " · erster Zug",
				"turns.suffixLast": " · letzter Zug",
				"turns.none": "Keine Gesprächszüge",
				"turns.barTitle": "Zug {turn}",
				"turns.contentHint": "Mit dem Rad auf/ab durch die Unterhaltung blättern",
				"turns.roleUser": "Nutzer: ",
				"turns.roleAssistant": "Assistent: ",
				"turns.noUserText": "(kein Text)",
				"turns.noAssistantReply": "(keine Assistenten-Antwort in diesem Zug)",
				"turns.reasoningPrefix": "[Überlegung] ",
				"turns.truncated": "… (gekürzt)"
			},
			ru: {
				"panel.title": "Хронология сессий",
				"fmt.listSep": "; ",
				"fmt.enumSep": ", ",
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
				"node.tag.awaitParent": "Ждёт родителя",
				"node.tag.awaitChild": "Ждёт потомка",
				"node.tag.externalParent": "Внешний родитель",
				"node.tag.archived": "В архиве",
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
				"stats.summary": "{sessions} сессий · связей {handoff} · ветвлений {branch} · вручную {manual}",
				"stats.unreadable": "· {count} нечитаемых",
				"stats.archived": "архив: {count}",
				"zoom.out": "Уменьшить (10 %)",
				"zoom.in": "Увеличить (10 %)",
				"zoom.fit": "100 % (исходный масштаб)",
				"zoom.reset": "Щелчок сбрасывает на 100 %",
				"canvas.hint": "Перетащите пустое место = сдвиг · Колесо = прокрутка · Масштаб только через −/+ слева вверху",
				"legend.groupActions": "Действия",
				"legend.groupCanvas": "Полотно",
				"legend.groupLineage": "Происхождение",
				"legend.action.dragNode": "Перетащить узел на другой",
				"legend.action.doubleClick": "Двойной щелчок",
				"legend.action.click": "Щелчок",
				"legend.action.dragEmpty": "Перетащить пустое место",
				"legend.action.wheel": "Колесо",
				"legend.action.zoom": "Масштаб",
				"legend.meaning.manual": "ручная связь",
				"legend.meaning.switchSession": "перейти к сессии",
				"legend.meaning.details": "детали сессии",
				"legend.meaning.pan": "сдвиг",
				"legend.meaning.scroll": "прокрутка полотна",
				"legend.meaning.zoomControls": "только −/+ слева вверху",
				"legend.action.laneToggle": "Щелчок по имени линии",
				"legend.meaning.laneToggle": "свернуть/развернуть линию",
				"legend.lineageDefinition": "встроенные рёбра ∪ ручные связи",
				"legend.action.mergedCriteria": "значок ⑂N / признак ветвления / золото-пурпурные рамки / описание происхождения",
				"legend.meaning.mergedChain": "все считаются по объединённой цепочке",
				"legend.line.handoff": "Цепной handoff (один потомок)",
				"legend.line.branch": "Ветвление/веер (у родителя ≥ 2 потомков, ручные тоже считаются)",
				"legend.line.manual": "Ручная связь (направлена по времени создания)",
				"legend.frame.awaitParent": "Ждёт родителя: вызывал skill handoff в первом ходе и не имеет родителя",
				"legend.frame.awaitChild": "Ждёт потомка: был вызов handoff и нет преемника",
				"legend.frame.archived": "Архивная сессия (пунктирная рамка; скрыта в режиме скрытия)",
				"legend.tag.handoff": "Вызывал skill handoff или начал с handoff-затравки",
				"legend.footer": "Выберите сессию, чтобы в области деталей увидеть ходы и время вызовов handoff.",
				"detail.hint": "Колесо на рамке = предыдущий/следующий ход · щелчок по полосе хода — переход · колесо внутри листает диалог",
				"detail.open": "Перейти к этой сессии",
				"detail.lastActive": "активна до {time}",
				"detail.created": "(создана {time})",
				"detail.logCreated": "журнал создан {time}",
				"detail.seeded": "начало с handoff-затравки",
				"detail.forkInferred": "нативный fork (происхождение выведено из унаследованного префикса)",
				"detail.forkSourceMissing": "fork: источник не найден (удалён или вне этого рабочего пространства)",
				"detail.archived": "в архиве",
				"lineage.prefix": "Происхождение: ",
				"lineage.root": "нет родительской сессии (корневая сессия)",
				"lineage.from": "связана с «{title}»",
				"lineage.fromMissing": "родительская сессия {id} не в текущем виде (межпространственный handoff или удалена)",
				"edge.kind.branch": "(ветвление)",
				"edge.kind.manual": "(вручную)",
				"lineage.outPrefix": "Связана с: ",
				"lineage.outItem": "«{title}»{mark}",
				"link.disconnect": "Отвязать",
				"link.disconnectTitle": "Убрать эту ручную связь",
				"handoff.summary": "skill handoff: вызовов — {count}",
				"handoff.mark.awaitParent": "(ждёт родителя · пурпурный)",
				"handoff.mark.awaitChild": "(ждёт потомка · золотой)",
				"handoff.hit": "· ход {turn} · {time} · сообщение #{seq}",
				"handoff.timeUnknown": "время неизвестно",
				"turns.position": "Ход {turn} / {total}",
				"turns.suffixHandoff": " · ход handoff",
				"turns.suffixFirst": " · первый ход",
				"turns.suffixLast": " · последний ход",
				"turns.none": "Нет ходов диалога",
				"turns.barTitle": "Ход {turn}",
				"turns.contentHint": "Колесо вверх/вниз листает содержимое диалога",
				"turns.roleUser": "Пользователь: ",
				"turns.roleAssistant": "Ассистент: ",
				"turns.noUserText": "(нет текста)",
				"turns.noAssistantReply": "(нет ответа ассистента в этом ходе)",
				"turns.reasoningPrefix": "[рассуждение] ",
				"turns.truncated": "… (обрезано)"
			},
			pt: {
				"panel.title": "Linha do tempo de sessões",
				"fmt.listSep": "; ",
				"fmt.enumSep": ", ",
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
				"node.tag.awaitParent": "Aguardando pai",
				"node.tag.awaitChild": "Aguardando filho",
				"node.tag.externalParent": "Pai externo",
				"node.tag.archived": "Arquivada",
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
				"stats.summary": "{sessions} sessões · vínculos {handoff} · ramificações {branch} · manuais {manual}",
				"stats.unreadable": "· {count} ilegíveis",
				"stats.archived": "{count} arquivadas",
				"zoom.out": "Reduzir (10%)",
				"zoom.in": "Ampliar (10%)",
				"zoom.fit": "100% (tamanho real)",
				"zoom.reset": "Clique para voltar a 100%",
				"canvas.hint": "Arraste o espaço vazio para mover · Roda = rolagem vertical · Zoom com −/+ no canto superior esquerdo",
				"legend.groupActions": "Ações",
				"legend.groupCanvas": "Tela",
				"legend.groupLineage": "Linhagem",
				"legend.action.dragNode": "Arraste um nó sobre outro",
				"legend.action.doubleClick": "Clique duplo",
				"legend.action.click": "Clique",
				"legend.action.dragEmpty": "Arrastar no espaço vazio",
				"legend.action.wheel": "Roda",
				"legend.action.zoom": "Zoom",
				"legend.meaning.manual": "vínculo manual",
				"legend.meaning.switchSession": "trocar de sessão",
				"legend.meaning.details": "detalhes da sessão",
				"legend.meaning.pan": "mover",
				"legend.meaning.scroll": "rolar a tela",
				"legend.meaning.zoomControls": "somente −/+ no canto superior esquerdo",
				"legend.action.laneToggle": "Clique no nome da linha",
				"legend.meaning.laneToggle": "recolher/expandir essa linha",
				"legend.lineageDefinition": "arestas nativas ∪ vínculos manuais",
				"legend.action.mergedCriteria": "distintivo ⑂N / veredito de ramificação / molduras ouro-roxo / narrativa de linhagem",
				"legend.meaning.mergedChain": "todos calculados na cadeia combinada",
				"legend.line.handoff": "Handoff em cadeia (filho único)",
				"legend.line.branch": "Ramificação/leque (pai com ≥ 2 filhos, manuais contam)",
				"legend.line.manual": "Vínculo manual (orientado pela hora de criação)",
				"legend.frame.awaitParent": "Aguardando pai: chamou a skill handoff no primeiro turno e não tem pai",
				"legend.frame.awaitChild": "Aguardando filho: houve chamada handoff e não há sucessor",
				"legend.frame.archived": "Sessão arquivada (borda tracejada; oculta no modo ocultar)",
				"legend.tag.handoff": "Chamou a skill handoff ou começou a partir de uma semente handoff",
				"legend.footer": "Selecione uma sessão para ver os turnos e horários das chamadas handoff na área de detalhes.",
				"detail.hint": "Roda na moldura = turno anterior/próximo · clique numa barra para ir direto · roda dentro rola a conversa",
				"detail.open": "Trocar para esta sessão",
				"detail.lastActive": "ativa até {time}",
				"detail.created": "(criada {time})",
				"detail.logCreated": "registro criado {time}",
				"detail.seeded": "início com semente handoff",
				"detail.forkInferred": "fork nativo (linhagem inferida do prefixo herdado)",
				"detail.forkSourceMissing": "fork: origem ausente (removida ou fora deste workspace)",
				"detail.archived": "arquivada",
				"lineage.prefix": "Linhagem: ",
				"lineage.root": "sem sessão pai (sessão raiz)",
				"lineage.from": "vinculada desde “{title}”",
				"lineage.fromMissing": "a sessão pai {id} não está na visão atual (handoff entre espaços ou excluída)",
				"edge.kind.branch": "(ramificação)",
				"edge.kind.manual": "(manual)",
				"lineage.outPrefix": "Vinculada a: ",
				"lineage.outItem": "“{title}”{mark}",
				"link.disconnect": "Desvincular",
				"link.disconnectTitle": "Remover este vínculo manual",
				"handoff.summary": "skill handoff: {count} chamada(s)",
				"handoff.mark.awaitParent": "(aguardando pai · roxo)",
				"handoff.mark.awaitChild": "(aguardando filho · ouro)",
				"handoff.hit": "· turno {turn} · {time} · mensagem nº {seq}",
				"handoff.timeUnknown": "hora desconhecida",
				"turns.position": "Turno {turn} / {total}",
				"turns.suffixHandoff": " · turno handoff",
				"turns.suffixFirst": " · primeiro turno",
				"turns.suffixLast": " · último turno",
				"turns.none": "Sem turnos de conversa",
				"turns.barTitle": "Turno {turn}",
				"turns.contentHint": "Rode para cima/baixo para folhear a conversa",
				"turns.roleUser": "Usuário: ",
				"turns.roleAssistant": "Assistente: ",
				"turns.noUserText": "(sem texto)",
				"turns.noAssistantReply": "(sem resposta do assistente neste turno)",
				"turns.reasoningPrefix": "[raciocínio] ",
				"turns.truncated": "… (truncado)"
			}
		};
		//#endregion
		//#region src/client/index.ts
		/**
		* @dsh-external/session-timeline — client: right sidebar tab (session timeline).
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
		const POLL_MS = 8e3;
		const FETCH_TIMEOUT_MS = 15e3;
		const TAB_ID = "@dsh-external/session-timeline";
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
		/** The panel's selected workspace (null = follow the current session's bucket). The tab title counts from this,
		*  kept consistent with the panel body; reset on unmount. */
		const viewBucket = {
			value: null,
			listeners: /* @__PURE__ */ new Set()
		};
		function setViewBucket(value) {
			if (viewBucket.value === value) return;
			viewBucket.value = value;
			for (const listener of [...viewBucket.listeners]) listener();
		}
		function subscribeViewBucket(listener) {
			viewBucket.listeners.add(listener);
			return () => {
				viewBucket.listeners.delete(listener);
			};
		}
		const archiveView = {
			value: "all",
			listeners: /* @__PURE__ */ new Set()
		};
		function setArchiveView(value) {
			if (archiveView.value === value) return;
			archiveView.value = value;
			for (const listener of [...archiveView.listeners]) listener();
		}
		function subscribeArchiveView(listener) {
			archiveView.listeners.add(listener);
			return () => {
				archiveView.listeners.delete(listener);
			};
		}
		const laneView = {
			value: {
				collapsed: /* @__PURE__ */ new Set(),
				hidden: /* @__PURE__ */ new Set()
			},
			listeners: /* @__PURE__ */ new Set()
		};
		function notifyLaneView() {
			for (const listener of [...laneView.listeners]) listener();
		}
		function subscribeLaneView(listener) {
			laneView.listeners.add(listener);
			return () => {
				laneView.listeners.delete(listener);
			};
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
		function fmtFull(ms) {
			const d = new Date(ms);
			return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + ":" + pad(d.getMinutes()) + ":" + pad(d.getSeconds());
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
		const legendRow = (label, items) => h("div", {
			key: label,
			style: {
				display: "flex",
				alignItems: "flex-start",
				gap: 8
			}
		}, h("span", { style: {
			flexShrink: 0,
			fontSize: 10.5,
			lineHeight: "18px",
			padding: "0 6px",
			borderRadius: 4,
			border: "1px solid var(--dsw-alias-border-primary, rgba(128,128,128,0.3))",
			color: DIM,
			whiteSpace: "nowrap"
		} }, label), h("span", { style: {
			display: "flex",
			flexWrap: "wrap",
			alignItems: "baseline",
			gap: "2px 12px",
			minWidth: 0
		} }, items));
		/** One item: action word (accent foreground) = meaning (secondary color). */
		const legendItem = (action, meaning) => h("span", {
			key: action,
			style: {
				display: "inline-flex",
				alignItems: "baseline",
				gap: 4
			}
		}, h("span", { style: { color: AXIS } }, action), h("span", { style: { color: DIM } }, "="), h("span", null, meaning));
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
			const { sessionId, openSession } = props;
			const t = props.t ?? T;
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
			useEffect(() => {
				setTurnsData(null);
				setFetchedTurns(/* @__PURE__ */ new Map());
				setSelTurn(1);
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
			}, [selected, workspace]);
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
				mark: displayKind(e, degree) === "branch" ? t("edge.kind.branch") : "",
				unlink: null
			})), ...selManualOut.map((l) => ({
				id: l.to,
				mark: t("edge.kind.manual"),
				unlink: {
					from: l.from,
					to: l.to
				}
			}))] : [];
			const titleOf = (id) => byId.get(id)?.title ?? shortId(id);
			const wsLabel = (w) => {
				return (w.cwd !== null && w.cwd !== "" ? w.cwd.split("/").filter(Boolean).pop() ?? w.cwd : w.bucket) + t("fmt.count", { count: w.sessions });
			};
			const onCanvas = (id) => lanesLayout === null || lanesLayout.colOf.has(id);
			const handoffCount = edges.filter((e) => displayKind(e, degree) === "handoff" && onCanvas(e.from) && onCanvas(e.to)).length;
			const branchCount = edges.filter((e) => displayKind(e, degree) === "branch" && onCanvas(e.from) && onCanvas(e.to)).length;
			const manualCount = manualLinks.filter((l) => onCanvas(l.from) && onCanvas(l.to)).length;
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
					fontFamily: MONO
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
				} }, n.seeded || n.handoffUsed ? h(P.Tag, { tone: "info" }, "handoff") : null, kids >= 2 ? h(P.Tag, { tone: "info" }, "⑂" + String(kids)) : null, nudgeFirst ? h(P.Tag, { tone: "info" }, t("node.tag.awaitParent")) : null, nudgeLast ? h(P.Tag, { tone: "warning" }, t("node.tag.awaitChild")) : null, n.parent !== null && !byId.has(n.parent) ? h(P.Tag, { tone: "quiet" }, t("node.tag.externalParent")) : null, n.archived === true ? h(P.Tag, { tone: "quiet" }, t("node.tag.archived")) : null, isGlobal ? h(P.Tag, { tone: "quiet" }, bucketTail(n.bucket)) : null));
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
			}, t("header.laneOnlyCurrent")))) : null) : null, h("span", null, t("stats.summary", {
				sessions: renderNodes.length,
				handoff: handoffCount,
				branch: branchCount,
				manual: manualCount
			}) + ((snap.sessions ?? []).some((n) => n.archived === true) ? " · " + t("stats.archived", { count: (snap.sessions ?? []).filter((n) => n.archived === true).length }) : "") + ((snap.unreadable ?? 0) > 0 ? " " + t("stats.unreadable", { count: snap.unreadable ?? 0 }) : "")), msg !== null ? h("span", { style: {
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
				gap: 5
			} }, legendRow(t("legend.groupActions"), [
				legendItem(t("legend.action.dragNode"), t("legend.meaning.manual")),
				legendItem(t("legend.action.doubleClick"), t("legend.meaning.switchSession")),
				legendItem(t("legend.action.click"), t("legend.meaning.details")),
				legendItem(t("legend.action.dragEmpty"), t("legend.meaning.pan"))
			]), legendRow(t("legend.groupCanvas"), [
				legendItem(t("legend.action.wheel"), t("legend.meaning.scroll")),
				legendItem(t("legend.action.zoom"), t("legend.meaning.zoomControls")),
				legendItem(t("legend.action.laneToggle"), t("legend.meaning.laneToggle"))
			]), legendRow(t("legend.groupLineage"), [h("span", { key: "def" }, t("legend.lineageDefinition")), legendItem(t("legend.action.mergedCriteria"), t("legend.meaning.mergedChain"))]), h("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: "3px 18px"
			} }, legendLine(ACCENT, false, t("legend.line.handoff")), legendLine(BRANCH, false, t("legend.line.branch")), legendLine(MANUAL, true, t("legend.line.manual"))), h("div", { style: {
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: "3px 18px"
			} }, legendFrame(FIRST_NUDGE, t("legend.frame.awaitParent")), legendFrame(LAST_NUDGE, t("legend.frame.awaitChild")), legendFrame("var(--dsw-alias-border-primary, rgba(128,128,128,0.35))", t("legend.frame.archived"), true), legendTag(t("legend.tag.handoff"))), h("div", null, t("legend.footer"))) : h("div", {
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
			}, t("detail.open"))), h("div", { style: {
				color: DIM,
				fontSize: 11.5,
				fontFamily: MONO
			} }, [
				shortId(sel.id),
				t("detail.lastActive", { time: fmtFull(sel.lastAt) }),
				t("detail.created", { time: fmt(sel.createdAt) }),
				...sel.logCreatedAt > 0 && sel.logCreatedAt !== sel.createdAt ? [t("detail.logCreated", { time: fmt(sel.logCreatedAt) })] : [],
				bucketTail(sel.bucket),
				...sel.seeded ? [t("detail.seeded")] : [],
				...sel.parentSource === "inferred" ? [t("detail.forkInferred")] : [],
				...sel.forkMarkerSeq !== null && sel.parent === null ? [t("detail.forkSourceMissing")] : [],
				...sel.archived === true ? [t("detail.archived")] : []
			].join(" · ")), (() => {
				const parts = [];
				let nativeNote = null;
				let nativeMissing = false;
				if (sel.parent !== null) if (byId.has(sel.parent)) nativeNote = t("lineage.from", { title: titleOf(sel.parent) }) + ((degree.get(sel.parent)?.out ?? 0) >= 2 ? t("edge.kind.branch") : "");
				else {
					nativeNote = t("lineage.fromMissing", { id: shortId(sel.parent) });
					nativeMissing = true;
				}
				if (nativeNote !== null) parts.push(h("span", { key: "nat" }, nativeNote));
				for (const l of selManualIn) parts.push(h("span", {
					key: "mi-" + l.from + l.to,
					style: {
						display: "inline-flex",
						alignItems: "center",
						gap: 4
					}
				}, h("span", null, t("lineage.from", { title: titleOf(l.from) }) + t("edge.kind.manual")), h(P.Button, {
					variant: "ghost",
					size: "sm",
					disabled: busy,
					title: t("link.disconnectTitle"),
					onClick: () => {
						act("unlink", l.from, l.to);
					}
				}, t("link.disconnect"))));
				return h("div", { style: {
					fontSize: 12,
					color: parts.length === 0 || nativeMissing && selManualIn.length === 0 ? DIM : void 0,
					display: "flex",
					flexWrap: "wrap",
					alignItems: "center",
					gap: "2px 6px"
				} }, h("span", null, t("lineage.prefix")), parts.length > 0 ? parts.flatMap((p, i) => i < parts.length - 1 ? [p, h("span", { key: "sep-" + String(i) }, t("fmt.listSep"))] : [p]) : h("span", null, t("lineage.root")));
			})(), sel.handoffHits.length > 0 ? h("div", { style: {
				display: "flex",
				flexDirection: "column",
				gap: 3
			} }, h("div", { style: { fontSize: 12 } }, t("handoff.summary", { count: sel.handoffHits.length }), sel.handoffFirst && (degree.get(sel.id)?.in ?? 0) === 0 ? h("span", { style: { color: FIRST_NUDGE } }, t("handoff.mark.awaitParent")) : null, sel.handoffUsed && (degree.get(sel.id)?.out ?? 0) === 0 ? h("span", { style: { color: LAST_NUDGE } }, t("handoff.mark.awaitChild")) : null), ...sel.handoffHits.map((hit) => h("div", {
				key: "handoff-hit-" + String(hit.seq) + "-" + String(hit.at),
				style: {
					color: DIM,
					fontSize: 11.5,
					fontFamily: MONO
				}
			}, t("handoff.hit", {
				turn: hit.turn,
				time: hit.at > 0 ? fmtFull(hit.at) : t("handoff.timeUnknown"),
				seq: hit.seq
			})))) : null, selOut.length > 0 ? h("div", { style: {
				fontSize: 12,
				display: "flex",
				flexWrap: "wrap",
				alignItems: "center",
				gap: "2px 6px"
			} }, h("span", null, t("lineage.outPrefix")), ...selOut.flatMap((o, i) => {
				const frags = [h("span", { key: "out-" + String(i) }, t("lineage.outItem", {
					title: titleOf(o.id),
					mark: o.mark
				}))];
				const u = o.unlink;
				if (u !== null) frags.push(h(P.Button, {
					key: "outb-" + String(i),
					variant: "ghost",
					size: "sm",
					disabled: busy,
					title: t("link.disconnectTitle"),
					onClick: () => {
						act("unlink", u.from, u.to);
					}
				}, t("link.disconnect")));
				if (i < selOut.length - 1) frags.push(h("span", { key: "outs-" + String(i) }, t("fmt.enumSep")));
				return frags;
			})) : null, h("div", { style: {
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
				marginLeft: 6
			} }, t("turns.position", {
				turn: selTurn,
				total: turnsData.turns
			}) + ((turnsData.handoffTurns ?? []).some((x) => x.turn === selTurn) ? t("turns.suffixHandoff") : "") + (selTurn === 1 ? t("turns.suffixFirst") : "") + (selTurn === turnsData.turns ? t("turns.suffixLast") : "")) : turnsData !== null ? h("span", { style: {
				color: DIM,
				fontSize: 11
			} }, t("turns.none")) : null), h("div", {
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
				const assistantText = tv.assistant === "" ? h("span", { style: { color: DIM } }, t("turns.noAssistantReply")) : (tv.assistantReasoning === true ? t("turns.reasoningPrefix") : "") + tv.assistant + (tv.assistantClipped === true ? t("turns.truncated") : "");
				return [h("div", {
					key: "u",
					style: { marginBottom: 6 }
				}, h("span", { style: {
					color: ACCENT,
					fontWeight: 600
				} }, t("turns.roleUser")), userText), h("div", { key: "a" }, h("span", { style: {
					color: BRANCH,
					fontWeight: 600
				} }, t("turns.roleAssistant")), assistantText)];
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