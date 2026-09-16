"use client";

import { BaseEdge, getBezierPath, useInternalNode, Position, type EdgeProps } from "@xyflow/react";

type Rect = { x: number; y: number; w: number; h: number };

function rectOf(node: ReturnType<typeof useInternalNode>): Rect | null {
  if (!node) return null;
  const w = node.measured?.width ?? (node.width as number) ?? 0;
  const h = node.measured?.height ?? (node.height as number) ?? 0;
  const abs = node.internals.positionAbsolute;
  return { x: abs.x, y: abs.y, w, h };
}

/**
 * The output leaves the source on its right or bottom, and the input enters the
 * target on its left or top — whichever side faces the other node. Recomputed
 * from live node rects, so the sides stay correct as nodes are dragged.
 */
function endpoints(source: Rect, target: Rect) {
  const sc = { x: source.x + source.w / 2, y: source.y + source.h / 2 };
  const tc = { x: target.x + target.w / 2, y: target.y + target.h / 2 };
  const dx = tc.x - sc.x;
  const dy = tc.y - sc.y;
  // Horizontal separation dominates → right/left; otherwise → bottom/top.
  const horizontal = Math.abs(dx) >= Math.abs(dy);

  const sourcePoint = horizontal
    ? { x: source.x + source.w, y: sc.y, pos: Position.Right }
    : { x: sc.x, y: source.y + source.h, pos: Position.Bottom };
  const targetPoint = horizontal
    ? { x: target.x, y: tc.y, pos: Position.Left }
    : { x: tc.x, y: target.y, pos: Position.Top };
  return { sourcePoint, targetPoint };
}

/**
 * Floating edge that attaches to the output (right/bottom) and input (left/top)
 * sides. The edge's `className` (e.g. design-edge-lb / design-edge-rdi) is applied
 * to the `.react-flow__edge` wrapper by React Flow, so styling still works.
 */
export function FloatingEdge({ id, source, target, markerEnd, style }: EdgeProps) {
  const sourceRect = rectOf(useInternalNode(source));
  const targetRect = rectOf(useInternalNode(target));
  if (!sourceRect || !targetRect) return null;

  const { sourcePoint, targetPoint } = endpoints(sourceRect, targetRect);
  const [path] = getBezierPath({
    sourceX: sourcePoint.x,
    sourceY: sourcePoint.y,
    sourcePosition: sourcePoint.pos,
    targetX: targetPoint.x,
    targetY: targetPoint.y,
    targetPosition: targetPoint.pos,
  });

  return <BaseEdge id={id} path={path} markerEnd={markerEnd} style={style} />;
}
