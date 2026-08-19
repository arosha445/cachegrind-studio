import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  formatBytes,
  formatDuration,
  formatPercent,
  shortenFunctionName,
  toMilliseconds,
} from '@cachegrind-studio/parser';
import type { FlameGraph, Profile } from '@cachegrind-studio/parser';
import { FlameRenderer, ROW_HEIGHT, type Orientation } from '../lib/flameRenderer.js';
import { usePrefersDark } from '../lib/theme.js';

interface Props {
  readonly profile: Profile;
  readonly flame: FlameGraph;
  readonly filter: string;
  readonly onSelectFunction: (fnId: number) => void;
}

interface Tooltip {
  readonly node: number;
  readonly x: number;
  readonly y: number;
}

export function FlameGraphView({
  profile,
  flame,
  filter,
  onSelectFunction,
}: Props): React.ReactElement {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const rendererRef = useRef<FlameRenderer | null>(null);
  const dragState = useRef<{ x: number; moved: boolean } | null>(null);

  const [orientation, setOrientation] = useState<Orientation>('icicle');
  const [tooltip, setTooltip] = useState<Tooltip | null>(null);
  const [zoomed, setZoomed] = useState(false);
  const dark = usePrefersDark();

  // Set up the renderer once per canvas element.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const renderer = new FlameRenderer(canvas);
    rendererRef.current = renderer;
    return () => {
      renderer.dispose();
      rendererRef.current = null;
    };
  }, []);

  useEffect(() => {
    rendererRef.current?.setGraph(profile, flame, shortenFunctionName);
    setZoomed(false);
    setTooltip(null);
  }, [profile, flame]);

  useEffect(() => {
    rendererRef.current?.setTheme(dark);
  }, [dark]);

  useEffect(() => {
    rendererRef.current?.setOrientation(orientation);
  }, [orientation]);

  // Highlight matches instead of filtering rows out — the shape of the profile
  // is the information, and removing rectangles destroys it.
  const highlighted = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    if (needle === '') return [];
    const matches: number[] = [];
    for (let fn = 0; fn < profile.functions.count; fn++) {
      if (profile.functionNames[fn]!.toLowerCase().includes(needle)) matches.push(fn);
    }
    return matches;
  }, [filter, profile]);

  useEffect(() => {
    rendererRef.current?.setHighlight(highlighted);
  }, [highlighted]);

  // Keep the canvas matched to its container and to the device pixel ratio.
  useEffect(() => {
    const container = scrollRef.current;
    const renderer = rendererRef.current;
    if (container === null || renderer === null) return;

    const apply = (): void => {
      const width = container.clientWidth;
      const height = Math.max(container.clientHeight, renderer.contentHeight());
      renderer.resize(width, height, window.devicePixelRatio || 1);
    };
    apply();

    const observer = new ResizeObserver(apply);
    observer.observe(container);
    return () => observer.disconnect();
  }, [flame]);

  const positionOf = useCallback((event: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  }, []);

  const onMouseMove = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const renderer = rendererRef.current;
      if (renderer === null) return;
      const { x, y } = positionOf(event);

      const drag = dragState.current;
      if (drag !== null) {
        const delta = x - drag.x;
        if (Math.abs(delta) > 1) {
          renderer.panBy(delta);
          dragState.current = { x, moved: true };
          setZoomed(renderer.isZoomed());
        }
        return;
      }

      const node = renderer.nodeAt(x, y);
      renderer.setHovered(node);
      setTooltip(node === -1 ? null : { node, x: event.clientX, y: event.clientY });
    },
    [positionOf],
  );

  const onMouseDown = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      dragState.current = { x: positionOf(event).x, moved: false };
    },
    [positionOf],
  );

  const onMouseUp = useCallback(
    (event: React.MouseEvent<HTMLCanvasElement>) => {
      const renderer = rendererRef.current;
      const drag = dragState.current;
      dragState.current = null;
      if (renderer === null || drag === null || drag.moved) return;

      const { x, y } = positionOf(event);
      const node = renderer.nodeAt(x, y);
      if (node === -1) return;
      onSelectFunction(flame.fnId[node]!);
      renderer.zoomTo(node);
      setZoomed(renderer.isZoomed());
    },
    [flame, onSelectFunction, positionOf],
  );

  const onWheel = useCallback((event: React.WheelEvent<HTMLCanvasElement>) => {
    const renderer = rendererRef.current;
    if (renderer === null || !event.ctrlKey) return;
    // Plain wheel stays vertical scrolling; ctrl+wheel zooms, matching the
    // pinch gesture browsers map onto it.
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    renderer.zoomAt(event.clientX - rect.left, event.deltaY > 0 ? 1.25 : 0.8);
    setZoomed(renderer.isZoomed());
  }, []);

  const resetZoom = useCallback(() => {
    rendererRef.current?.resetZoom();
    setZoomed(false);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') resetZoom();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [resetZoom]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-zinc-200 px-3 py-2 text-xs dark:border-zinc-800">
        <div className="inline-flex overflow-hidden rounded-md border border-zinc-300 dark:border-zinc-700">
          {(['icicle', 'flame'] as const).map((value) => (
            <button
              key={value}
              type="button"
              onClick={() => setOrientation(value)}
              className={`px-3 py-1 capitalize ${
                orientation === value
                  ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900'
                  : 'hover:bg-zinc-100 dark:hover:bg-zinc-800'
              }`}
            >
              {value}
            </button>
          ))}
        </div>

        <button
          type="button"
          onClick={resetZoom}
          disabled={!zoomed}
          className="rounded-md border border-zinc-300 px-3 py-1 disabled:opacity-40 dark:border-zinc-700"
        >
          Reset zoom (Esc)
        </button>

        <span className="text-zinc-500">
          {flame.count.toLocaleString()} frames · depth {flame.maxDepth}
          {flame.hitNodeCeiling ? (
            <span className="text-amber-600 dark:text-amber-400">
              {' '}
              · frame ceiling reached — showing the largest frames only
            </span>
          ) : (
            flame.prunedNodes > 0 && (
              <> · {flame.prunedNodes.toLocaleString()} frames not fully expanded</>
            )
          )}
        </span>

        <span className="ml-auto text-zinc-500">Click to zoom · drag to pan · ctrl+wheel</span>
      </div>

      <div ref={scrollRef} className="relative flex-1 overflow-auto">
        <canvas
          ref={canvasRef}
          className="block cursor-pointer"
          onMouseMove={onMouseMove}
          onMouseDown={onMouseDown}
          onMouseUp={onMouseUp}
          onMouseLeave={() => {
            dragState.current = null;
            rendererRef.current?.setHovered(-1);
            setTooltip(null);
          }}
          onWheel={onWheel}
        />
      </div>

      {tooltip !== null && (
        <FrameTooltip profile={profile} flame={flame} node={tooltip.node} x={tooltip.x} y={tooltip.y} />
      )}
    </div>
  );
}

function FrameTooltip({
  profile,
  flame,
  node,
  x,
  y,
}: {
  profile: Profile;
  flame: FlameGraph;
  node: number;
  x: number;
  y: number;
}): React.ReactElement {
  const fn = flame.fnId[node]!;
  const value = flame.value[node]!;
  const selfValue = flame.selfValue[node]!;
  const fileId = profile.functions.fileId[fn]!;
  const isMemory = flame.metric === 'memory';

  const render = (raw: number): string =>
    isMemory ? formatBytes(raw) : formatDuration(toMilliseconds(profile, raw));

  return (
    <div
      className="pointer-events-none fixed z-50 max-w-md rounded-md border border-zinc-700 bg-zinc-900/95 px-3 py-2 text-xs text-zinc-100 shadow-lg"
      style={{
        left: Math.min(x + 14, window.innerWidth - 400),
        top: Math.min(y + 14, window.innerHeight - 140),
      }}
    >
      <div className="font-mono break-all">{profile.functionNames[fn]}</div>
      <div className="mt-1 text-zinc-400 break-all">
        {fileId >= 0 ? profile.files[fileId] : 'unknown file'}
      </div>
      <dl className="mt-2 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 tabular">
        <dt className="text-zinc-400">This frame</dt>
        <dd>
          {render(value)} ({formatPercent(value / (flame.total || 1))})
        </dd>
        <dt className="text-zinc-400">Own work</dt>
        <dd>{render(selfValue)}</dd>
        <dt className="text-zinc-400">Calls here</dt>
        <dd>{flame.callCount[node]!.toLocaleString()}</dd>
        <dt className="text-zinc-400">Total across profile</dt>
        <dd>
          {render(
            isMemory ? profile.functions.inclMemory[fn]! : profile.functions.inclTime[fn]!,
          )}
        </dd>
      </dl>
      {(flame.flags[node]! & 1) !== 0 && (
        <div className="mt-2 text-amber-400">Recursive — not expanded further.</div>
      )}
    </div>
  );
}

export { ROW_HEIGHT };
