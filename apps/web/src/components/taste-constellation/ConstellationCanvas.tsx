import { useEffect, useId, useRef, useState } from "react";
import { RiAddLine, RiSubtractLine, RiFocus3Line } from "@remixicon/react";
import { Button } from "#ui/components/base/buttons/button";
import type { Graph } from "./graph";
import { labelName, type Track } from "./data";

type Camera = { x: number; y: number; zoom: number };
type Props = {
	graph: Graph;
	visibleGraph: Graph;
	tracks: Map<string, Track>;
	selected: string | null;
	onSelect: (id: string | null) => void;
};

export function ConstellationCanvas({
	graph,
	visibleGraph,
	tracks,
	selected,
	onSelect,
}: Props) {
	const presentation = useRef({ visibleGraph, tracks });
	presentation.current = { visibleGraph, tracks };
	const clearHover = useRef(() => {});
	const canvas = useRef<HTMLCanvasElement>(null);
	const frame = useRef<HTMLDivElement>(null);
	const camera = useRef<Camera>({ x: 0, y: 0, zoom: 1 });
	const controls = useRef<{
		zoom: (factor: number) => void;
		reset: () => void;
	}>({ zoom: () => {}, reset: () => {} });
	const [hover, setHover] = useState<string | null>(null);
	const [edges, setEdges] = useState(false);
	const showEdges = useRef(false);
	const redraw = useRef<() => void>(() => {});
	const [zoom, setZoom] = useState(100);
	const instructions = useId();
	const select = useRef(onSelect);
	select.current = onSelect;
	const currentSelection = useRef(selected);
	currentSelection.current = selected;
	const focusNode = useRef<(id: string | null) => void>(() => {});

	useEffect(() => {
		const element = canvas.current!,
			container = frame.current!;
		const ctx = element.getContext("2d");
		if (!ctx) return;
		const media = matchMedia("(prefers-reduced-motion: reduce)");
		const byId = new Map(graph.nodes.map((n) => [n.id, n]));
		let width = 1,
			height = 1,
			baseScale = 1,
			raf = 0,
			animation = 0;
		let hovered: string | null = null,
			keyboardIndex = -1;
		let pointer: {
			id: number;
			x: number;
			y: number;
			cx: number;
			cy: number;
			moved: boolean;
		} | null = null;
		const colors = { keep: "", remove: "", unlabeled: "", ink: "", edge: "" };
		const refreshColors = () => {
			const style = getComputedStyle(container);
			colors.keep = style.getPropertyValue("--tc-keep").trim();
			colors.remove = style.getPropertyValue("--tc-remove").trim();
			colors.unlabeled = style.getPropertyValue("--tc-unlabeled").trim();
			colors.ink = style.getPropertyValue("--color-text-primary").trim();
			colors.edge = style.getPropertyValue("--tc-unlabeled").trim();
		};
		const point = (node: { x: number; y: number }) => ({
			x:
				width / 2 +
				(node.x - camera.current.x) * baseScale * camera.current.zoom,
			y:
				height / 2 -
				(node.y - camera.current.y) * baseScale * camera.current.zoom,
		});
		const draw = () => {
			raf = 0;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, width, height);
			const shown = presentation.current;
			const active = shown.visibleGraph.nodes.find(
				(n) => n.id === currentSelection.current,
			);
			const related = new Set(
				active ? [active.id, ...active.neighbors.map((n) => n.id)] : [],
			);
			const links = active
				? active.neighbors.map((n): [string, string] => [active.id, n.id])
				: showEdges.current
					? shown.visibleGraph.edges
					: [];
			ctx.lineWidth = active ? 1.25 : 0.6;
			ctx.strokeStyle = active ? colors.keep : colors.edge;
			ctx.globalAlpha = active ? 0.55 : 0.14;
			ctx.beginPath();
			for (const [a, b] of links) {
				const start = point(byId.get(a)!),
					end = point(byId.get(b)!);
				ctx.moveTo(start.x, start.y);
				ctx.lineTo(end.x, end.y);
			}
			ctx.stroke();
			for (const node of shown.visibleGraph.nodes) {
				const p = point(node);
				if (p.x < -15 || p.x > width + 15 || p.y < -15 || p.y > height + 15)
					continue;
				const highlighted = related.has(node.id),
					isHovered = node.id === hovered;
				const focused = node.id === active?.id || isHovered;
				const label = shown.tracks.get(node.id)?.label ?? "unlabeled";
				const radius =
					node.id === active?.id
						? 7
						: highlighted || isHovered
							? 4.5
							: label === "unlabeled"
								? 2.1
								: 3.1;
				if (focused) {
					ctx.globalAlpha = 0.12;
					ctx.fillStyle = colors[label];
					ctx.beginPath();
					ctx.arc(p.x, p.y, radius + 12, 0, Math.PI * 2);
					ctx.fill();
				}
				ctx.globalAlpha =
					active && !highlighted && !isHovered
						? 0.13
						: label === "unlabeled" && !highlighted
							? 0.78
							: 0.95;
				ctx.fillStyle = colors[label];
				if (highlighted || isHovered) {
					ctx.shadowColor = colors[label];
					ctx.shadowBlur = focused ? 20 : 14;
				}
				ctx.beginPath();
				if (label === "remove") {
					ctx.moveTo(p.x, p.y - radius);
					ctx.lineTo(p.x + radius, p.y);
					ctx.lineTo(p.x, p.y + radius);
					ctx.lineTo(p.x - radius, p.y);
					ctx.closePath();
				} else ctx.arc(p.x, p.y, radius, 0, 2 * Math.PI);
				ctx.fill();
				ctx.shadowBlur = 0;
				if (focused) {
					ctx.globalAlpha = 0.8;
					ctx.strokeStyle = colors.ink;
					ctx.lineWidth = 1;
					ctx.beginPath();
					ctx.arc(p.x, p.y, radius + 5, 0, Math.PI * 2);
					ctx.stroke();
				}
			}
			ctx.globalAlpha = 1;
		};
		const schedule = () => {
			if (!raf) raf = requestAnimationFrame(draw);
		};
		redraw.current = schedule;
		const fitCamera = () => {
			const xs = graph.nodes.map((n) => n.x),
				ys = graph.nodes.map((n) => n.y);
			const minX = Math.min(...xs),
				maxX = Math.max(...xs),
				minY = Math.min(...ys),
				maxY = Math.max(...ys);
			baseScale = Math.min(
				(width - 64) / Math.max(1, maxX - minX),
				(height - 96) / Math.max(1, maxY - minY),
			);
			return {
				x: graph.nodes.length ? (minX + maxX) / 2 : 0,
				y: graph.nodes.length ? (minY + maxY) / 2 : 0,
				zoom: 1,
			};
		};
		const moveTo = (target: Camera) => {
			cancelAnimationFrame(animation);
			const from = { ...camera.current },
				start = performance.now();
			const tick = () => {
				const t = media.matches
					? 1
					: Math.min(1, (performance.now() - start) / 280);
				const ease = 1 - (1 - t) ** 3;
				camera.current = {
					x: from.x + (target.x - from.x) * ease,
					y: from.y + (target.y - from.y) * ease,
					zoom: from.zoom + (target.zoom - from.zoom) * ease,
				};
				schedule();
				if (t < 1) animation = requestAnimationFrame(tick);
				else setZoom(Math.round(target.zoom * 100));
			};
			tick();
		};
		focusNode.current = (id) => {
			const node = byId.get(id ?? "");
			if (node)
				moveTo({
					x: node.x,
					y: node.y,
					zoom: Math.max(camera.current.zoom, 1.8),
				});
			else schedule();
		};
		controls.current = {
			zoom: (factor) =>
				moveTo({
					...camera.current,
					zoom: Math.max(0.6, Math.min(12, camera.current.zoom * factor)),
				}),
			reset: () => {
				select.current(null);
				moveTo(fitCamera());
			},
		};
		const resize = () => {
			width = container.clientWidth;
			height = container.clientHeight;
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			element.width = Math.round(width * dpr);
			element.height = Math.round(height * dpr);
			fitCamera();
			refreshColors();
			schedule();
		};
		resize();
		camera.current = fitCamera();
		setZoom(100);
		if (currentSelection.current) focusNode.current(currentSelection.current);
		const observer = new ResizeObserver(resize);
		observer.observe(container);
		const themeObserver = new MutationObserver(() => {
			refreshColors();
			schedule();
		});
		themeObserver.observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["class", "style"],
		});
		const pick = (x: number, y: number) => {
			let nearest: string | null = null,
				distance = 100;
			for (const node of presentation.current.visibleGraph.nodes) {
				const p = point(node),
					d = (p.x - x) ** 2 + (p.y - y) ** 2;
				if (d < distance) {
					distance = d;
					nearest = node.id;
				}
			}
			return nearest;
		};
		const coordinates = (event: PointerEvent | WheelEvent) => {
			const rect = element.getBoundingClientRect();
			return { x: event.clientX - rect.left, y: event.clientY - rect.top };
		};
		const down = (event: PointerEvent) => {
			if (event.button !== 0) return;
			cancelAnimationFrame(animation);
			const p = coordinates(event);
			pointer = {
				id: event.pointerId,
				...p,
				cx: camera.current.x,
				cy: camera.current.y,
				moved: false,
			};
			element.setPointerCapture(event.pointerId);
			element.focus({ preventScroll: true });
		};
		const move = (event: PointerEvent) => {
			const p = coordinates(event);
			if (pointer && pointer.id === event.pointerId) {
				const dx = p.x - pointer.x,
					dy = p.y - pointer.y;
				if (Math.hypot(dx, dy) > 4) pointer.moved = true;
				if (pointer.moved) {
					camera.current.x =
						pointer.cx - dx / (baseScale * camera.current.zoom);
					camera.current.y =
						pointer.cy + dy / (baseScale * camera.current.zoom);
					schedule();
				}
			} else {
				const id = pick(p.x, p.y);
				if (id !== hovered) {
					hovered = id;
					setHover(id);
					element.style.cursor = id ? "pointer" : "grab";
					schedule();
				}
			}
		};
		const up = (event: PointerEvent) => {
			if (!pointer || pointer.id !== event.pointerId) return;
			if (!pointer.moved) {
				const p = coordinates(event);
				select.current(pick(p.x, p.y));
			}
			pointer = null;
		};
		const leave = () => {
			hovered = null;
			setHover(null);
			schedule();
		};
		clearHover.current = () => {
			keyboardIndex = -1;
			leave();
		};
		const cancel = () => {
			pointer = null;
		};
		const wheel = (event: WheelEvent) => {
			event.preventDefault();
			cancelAnimationFrame(animation);
			const p = coordinates(event),
				before = camera.current.zoom;
			const next = Math.max(
				0.6,
				Math.min(
					12,
					before *
						Math.exp(-Math.max(-100, Math.min(100, event.deltaY)) * 0.003),
				),
			);
			camera.current.x +=
				((p.x - width / 2) / baseScale) * (1 / before - 1 / next);
			camera.current.y -=
				((p.y - height / 2) / baseScale) * (1 / before - 1 / next);
			camera.current.zoom = next;
			setZoom(Math.round(next * 100));
			schedule();
		};
		const key = (event: KeyboardEvent) => {
			if (
				["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)
			) {
				event.preventDefault();
				const step = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1;
				const nodes = presentation.current.visibleGraph.nodes;
				keyboardIndex = nodes.length
					? (keyboardIndex + step + nodes.length) % nodes.length
					: -1;
				hovered = nodes[keyboardIndex]?.id ?? null;
				setHover(hovered);
				focusNode.current(hovered);
			} else if (event.key === "Enter" || event.key === " ") {
				event.preventDefault();
				if (hovered && presentation.current.tracks.has(hovered))
					select.current(hovered);
			} else if (event.key === "Escape") {
				select.current(null);
				leave();
			} else if (event.key === "+" || event.key === "=") {
				event.preventDefault();
				controls.current.zoom(1.4);
			} else if (event.key === "-") {
				event.preventDefault();
				controls.current.zoom(1 / 1.4);
			} else if (event.key === "Home") {
				event.preventDefault();
				controls.current.reset();
			}
		};
		element.addEventListener("pointerdown", down);
		element.addEventListener("pointermove", move);
		element.addEventListener("pointerup", up);
		element.addEventListener("pointercancel", cancel);
		element.addEventListener("pointerleave", leave);
		element.addEventListener("blur", leave);
		element.addEventListener("wheel", wheel, { passive: false });
		element.addEventListener("keydown", key);
		return () => {
			observer.disconnect();
			themeObserver.disconnect();
			cancelAnimationFrame(raf);
			cancelAnimationFrame(animation);
			element.removeEventListener("pointerdown", down);
			element.removeEventListener("pointermove", move);
			element.removeEventListener("pointerup", up);
			element.removeEventListener("pointercancel", cancel);
			element.removeEventListener("pointerleave", leave);
			element.removeEventListener("blur", leave);
			element.removeEventListener("wheel", wheel);
			element.removeEventListener("keydown", key);
			focusNode.current = () => {};
			redraw.current = () => {};
		};
	}, [graph]);
	useEffect(() => {
		presentation.current = { visibleGraph, tracks };
		clearHover.current();
		redraw.current();
	}, [visibleGraph, tracks]);

	useEffect(() => {
		showEdges.current = edges;
		redraw.current();
	}, [edges]);

	useEffect(() => {
		focusNode.current(selected);
	}, [selected]);
	const hoveredTrack = tracks.get(hover ?? "");
	return (
		<div className="tc-map-wrap">
			<div className="tc-stage" ref={frame}>
				{/* biome-ignore lint/a11y/noInteractiveElementToNoninteractiveRole: This canvas implements a keyboard-operated map; the application role enables its documented arrow controls. */}
				<canvas
					ref={canvas}
					role="application"
					tabIndex={0}
					aria-label="Interactive acoustic constellation"
					aria-describedby={instructions}
				/>
				<div
					className="tc-map-heading text-caption-1-semibold"
					aria-hidden="true"
				>
					<span>ACOUSTIC SPACE</span>
					<span>PC 1 × PC 2</span>
				</div>
				<div className="tc-map-tools">
					<Button
						variant="secondary"
						iconOnly
						leadingIcon={RiAddLine}
						aria-label="Zoom in"
						onClick={() => controls.current.zoom(1.4)}
					/>
					<Button
						variant="secondary"
						iconOnly
						leadingIcon={RiSubtractLine}
						aria-label="Zoom out"
						onClick={() => controls.current.zoom(1 / 1.4)}
					/>
					<Button
						variant="secondary"
						iconOnly
						leadingIcon={RiFocus3Line}
						aria-label="Fit all tracks"
						onClick={() => controls.current.reset()}
					/>
				</div>
				{hoveredTrack && (
					<output className="tc-tooltip text-body-2-medium">
						<b>{hoveredTrack.title}</b>
						<span>
							{hoveredTrack.artist} · {labelName(hoveredTrack.label)}
						</span>
					</output>
				)}
				<div className="tc-map-bottom text-caption-1-regular">
					<span>
						{visibleGraph.nodes.length.toLocaleString()} placed tracks
					</span>
					<span>{zoom}%</span>
				</div>
			</div>
			<div className="tc-map-caption text-caption-1-regular">
				<span id={instructions}>
					Drag to pan · scroll to zoom. Keyboard: arrows browse, Enter selects,
					+/− zoom, Home fits, Esc clears.
				</span>
				<Button
					variant="secondary"
					size="small"
					aria-pressed={edges}
					onClick={() => setEdges(!edges)}
				>
					Sparse links {edges ? "on" : "off"}
				</Button>
			</div>
		</div>
	);
}
