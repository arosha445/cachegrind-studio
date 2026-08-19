import { FLAME_FLAG_PRUNED, FLAME_FLAG_RECURSIVE, FunctionKind } from '@cachegrind-studio/parser';
import type { FlameGraph, Profile } from '@cachegrind-studio/parser';

/**
 * Canvas flame/icicle renderer.
 *
 * Invariant 1: frames are never DOM nodes. A 200 MB profile can expand to
 * hundreds of thousands of rectangles, and one element each is exactly what
 * makes the existing tools fall over. Everything here draws into a single
 * canvas and hit-tests against typed arrays.
 */

export const ROW_HEIGHT = 18;
export type Orientation = 'flame' | 'icicle';

export interface HoverTarget {
  readonly node: number;
  readonly x: number;
  readonly y: number;
}

/** Rectangles narrower than this are invisible; drawing them only costs time. */
const MIN_DRAW_WIDTH = 0.4;
/** Below this width there is no room for a readable label. */
const MIN_LABEL_WIDTH = 26;

interface Palette {
  readonly fill: (kind: number, hash: number, highlighted: boolean) => string;
  readonly text: string;
  readonly mutedText: string;
  readonly stroke: string;
  readonly background: string;
}

/**
 * Hue is derived from the function kind, lightness from a name hash. Kind-first
 * means the split between userland, PHP internals and includes is legible
 * without reading a single label.
 */
function makePalette(dark: boolean): Palette {
  const bands: Record<number, [number, number]> = {
    [FunctionKind.User]: [28, 44],
    [FunctionKind.Internal]: [205, 225],
    [FunctionKind.Include]: [270, 290],
    [FunctionKind.Main]: [0, 0],
  };
  return {
    fill(kind, hash, highlighted) {
      const band = bands[kind] ?? bands[FunctionKind.User]!;
      const [low, high] = band;
      const hue = low + (hash % Math.max(1, high - low + 1));
      const saturation = kind === FunctionKind.Main ? 0 : 62;
      const base = dark ? 42 : 62;
      const lightness = base + (hash % 11) - 5 + (highlighted ? 14 : 0);
      return `hsl(${hue} ${saturation}% ${lightness}%)`;
    },
    text: dark ? '#f4f4f5' : '#18181b',
    mutedText: dark ? '#a1a1aa' : '#52525b',
    stroke: dark ? '#18181b' : '#ffffff',
    background: dark ? '#09090b' : '#fafafa',
  };
}

function hashName(name: string): number {
  let hash = 2166136261;
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0) % 1000;
}

export class FlameRenderer {
  private context: CanvasRenderingContext2D;
  private profile: Profile | null = null;
  private graph: FlameGraph | null = null;

  /** Node indices sorted by (depth, start), for O(log n) hit testing. */
  private byDepth = new Uint32Array(0);
  private depthOffsets = new Int32Array(0);

  private nameHash = new Int32Array(0);
  private labels: string[] = [];

  private cssWidth = 0;
  private cssHeight = 0;
  private dpr = 1;

  private viewStart = 0;
  private viewEnd = 1;
  private orientation: Orientation = 'flame';
  private palette = makePalette(false);
  private highlighted = new Set<number>();
  private hoveredNode = -1;
  private frame = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const context = canvas.getContext('2d', { alpha: false });
    if (context === null) throw new Error('2D canvas is unavailable');
    this.context = context;
  }

  setTheme(dark: boolean): void {
    this.palette = makePalette(dark);
    this.scheduleDraw();
  }

  setOrientation(orientation: Orientation): void {
    this.orientation = orientation;
    this.scheduleDraw();
  }

  setGraph(profile: Profile, graph: FlameGraph, shortLabel: (name: string) => string): void {
    this.profile = profile;
    this.graph = graph;
    this.viewStart = 0;
    this.viewEnd = graph.total > 0 ? graph.total : 1;
    this.hoveredNode = -1;

    // Precompute per-function display data once. Doing it per frame would mean
    // hundreds of thousands of string operations at 60 Hz.
    const functionCount = profile.functions.count;
    this.nameHash = new Int32Array(functionCount);
    this.labels = new Array<string>(functionCount);
    for (let fn = 0; fn < functionCount; fn++) {
      const name = profile.functionNames[fn] ?? '';
      this.nameHash[fn] = hashName(name);
      this.labels[fn] = shortLabel(name);
    }

    this.buildDepthIndex(graph);
    this.scheduleDraw();
  }

  private buildDepthIndex(graph: FlameGraph): void {
    const depthCount = graph.maxDepth + 2;
    const counts = new Int32Array(depthCount);
    for (let node = 0; node < graph.count; node++) counts[graph.depth[node]! + 1]! += 1;
    for (let depth = 1; depth < depthCount; depth++) counts[depth]! += counts[depth - 1]!;

    const offsets = counts.slice();
    const cursor = offsets.slice(0, depthCount - 1);
    const order = new Uint32Array(graph.count);
    for (let node = 0; node < graph.count; node++) {
      const depth = graph.depth[node]!;
      order[cursor[depth]!] = node;
      cursor[depth] = cursor[depth]! + 1;
    }

    // Within a depth, DFS emission order is already ascending by `start`
    // for siblings, but not across different parents. Sort each band so hit
    // testing can binary search.
    for (let depth = 0; depth + 1 < depthCount; depth++) {
      const from = offsets[depth]!;
      const to = offsets[depth + 1]!;
      const band = Array.from(order.subarray(from, to));
      band.sort((a, b) => graph.start[a]! - graph.start[b]!);
      order.set(band, from);
    }

    this.byDepth = order;
    this.depthOffsets = offsets;
  }

  resize(cssWidth: number, cssHeight: number, dpr: number): void {
    this.cssWidth = cssWidth;
    this.cssHeight = cssHeight;
    this.dpr = dpr;
    this.canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    this.canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.canvas.style.width = `${cssWidth}px`;
    this.canvas.style.height = `${cssHeight}px`;
    this.scheduleDraw();
  }

  contentHeight(): number {
    const graph = this.graph;
    if (graph === null) return ROW_HEIGHT;
    return (graph.maxDepth + 1) * ROW_HEIGHT;
  }

  setHighlight(fnIds: Iterable<number>): void {
    this.highlighted = new Set(fnIds);
    this.scheduleDraw();
  }

  setHovered(node: number): void {
    if (this.hoveredNode === node) return;
    this.hoveredNode = node;
    this.scheduleDraw();
  }

  /** Zoom so that `node` spans the full width. */
  zoomTo(node: number): void {
    const graph = this.graph;
    if (graph === null || node < 0 || node >= graph.count) return;
    this.viewStart = graph.start[node]!;
    this.viewEnd = this.viewStart + graph.value[node]!;
    this.scheduleDraw();
  }

  resetZoom(): void {
    const graph = this.graph;
    if (graph === null) return;
    this.viewStart = 0;
    this.viewEnd = graph.total > 0 ? graph.total : 1;
    this.scheduleDraw();
  }

  isZoomed(): boolean {
    const graph = this.graph;
    if (graph === null) return false;
    return this.viewStart > 0 || this.viewEnd < graph.total;
  }

  /** Zoom about a pixel position, for ctrl+wheel. */
  zoomAt(cssX: number, factor: number): void {
    const graph = this.graph;
    if (graph === null) return;
    const span = this.viewEnd - this.viewStart;
    const anchor = this.viewStart + (cssX / Math.max(1, this.cssWidth)) * span;
    const nextSpan = Math.min(graph.total, Math.max(graph.total / 1e6, span * factor));
    const ratio = (anchor - this.viewStart) / span;
    let start = anchor - nextSpan * ratio;
    let end = start + nextSpan;
    if (start < 0) {
      start = 0;
      end = nextSpan;
    }
    if (end > graph.total) {
      end = graph.total;
      start = Math.max(0, end - nextSpan);
    }
    this.viewStart = start;
    this.viewEnd = end;
    this.scheduleDraw();
  }

  /** Pan by a pixel delta, for drag. */
  panBy(cssDeltaX: number): void {
    const graph = this.graph;
    if (graph === null) return;
    const span = this.viewEnd - this.viewStart;
    const delta = (cssDeltaX / Math.max(1, this.cssWidth)) * span;
    let start = this.viewStart - delta;
    if (start < 0) start = 0;
    if (start + span > graph.total) start = Math.max(0, graph.total - span);
    this.viewStart = start;
    this.viewEnd = start + span;
    this.scheduleDraw();
  }

  /** Node index at a CSS pixel position, or -1. */
  nodeAt(cssX: number, cssY: number): number {
    const graph = this.graph;
    if (graph === null || graph.count === 0) return -1;

    const depth =
      this.orientation === 'icicle'
        ? Math.floor(cssY / ROW_HEIGHT)
        : Math.floor((this.contentHeight() - cssY) / ROW_HEIGHT);
    if (depth < 0 || depth + 1 >= this.depthOffsets.length) return -1;

    const from = this.depthOffsets[depth]!;
    const to = this.depthOffsets[depth + 1]!;
    if (from >= to) return -1;

    const span = this.viewEnd - this.viewStart;
    const value = this.viewStart + (cssX / Math.max(1, this.cssWidth)) * span;

    // Binary search for the last node whose start <= value.
    let low = from;
    let high = to - 1;
    let found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      const node = this.byDepth[middle]!;
      if (graph.start[node]! <= value) {
        found = node;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    if (found === -1) return -1;
    return value < graph.start[found]! + graph.value[found]! ? found : -1;
  }

  private scheduleDraw(): void {
    if (this.frame !== 0) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  dispose(): void {
    if (this.frame !== 0) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  draw(): void {
    const context = this.context;
    const graph = this.graph;
    const profile = this.profile;

    context.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    context.fillStyle = this.palette.background;
    context.fillRect(0, 0, this.cssWidth, this.cssHeight);
    if (graph === null || profile === null || graph.count === 0) return;

    const span = this.viewEnd - this.viewStart;
    if (!(span > 0)) return;
    const scale = this.cssWidth / span;
    const contentHeight = this.contentHeight();

    context.font = '11px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    context.textBaseline = 'middle';
    context.lineWidth = 1;

    const kinds = profile.functions.kind;

    for (let node = 0; node < graph.count; node++) {
      const start = graph.start[node]!;
      const value = graph.value[node]!;

      const x0 = (start - this.viewStart) * scale;
      const x1 = (start + value - this.viewStart) * scale;
      if (x1 < 0 || x0 > this.cssWidth) continue;

      const width = x1 - x0;
      if (width < MIN_DRAW_WIDTH) continue;

      const depth = graph.depth[node]!;
      const y =
        this.orientation === 'icicle'
          ? depth * ROW_HEIGHT
          : contentHeight - (depth + 1) * ROW_HEIGHT;
      if (y + ROW_HEIGHT < 0 || y > this.cssHeight) continue;

      const fn = graph.fnId[node]!;
      const isHovered = node === this.hoveredNode;
      const isHighlighted = this.highlighted.size > 0 && this.highlighted.has(fn);

      const drawX = Math.max(x0, -1);
      const drawWidth = Math.min(x1, this.cssWidth + 1) - drawX;

      context.fillStyle = this.palette.fill(
        kinds[fn] ?? FunctionKind.User,
        this.nameHash[fn] ?? 0,
        isHovered || isHighlighted,
      );
      context.fillRect(drawX, y, drawWidth, ROW_HEIGHT - 1);

      if (this.highlighted.size > 0 && !isHighlighted) {
        // Dim non-matches instead of hiding them, so the shape of the profile
        // stays readable while filtering.
        context.fillStyle = this.palette.background;
        context.globalAlpha = 0.55;
        context.fillRect(drawX, y, drawWidth, ROW_HEIGHT - 1);
        context.globalAlpha = 1;
      }

      if ((graph.flags[node]! & FLAME_FLAG_RECURSIVE) !== 0) {
        // A recursion stop: the subtree exists but was not expanded.
        context.strokeStyle = this.palette.mutedText;
        context.setLineDash([2, 2]);
        context.strokeRect(drawX + 0.5, y + 0.5, Math.max(1, drawWidth - 1), ROW_HEIGHT - 2);
        context.setLineDash([]);
      }

      if (drawWidth >= MIN_LABEL_WIDTH) {
        context.save();
        context.beginPath();
        context.rect(drawX, y, drawWidth, ROW_HEIGHT - 1);
        context.clip();
        context.fillStyle = this.palette.text;
        let label = this.labels[fn] ?? '';
        if ((graph.flags[node]! & FLAME_FLAG_PRUNED) !== 0) label += ' …';
        context.fillText(label, drawX + 4, y + ROW_HEIGHT / 2);
        context.restore();
      }
    }
  }
}
