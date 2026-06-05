#!/usr/bin/env python3
"""Verify delayed post-shot trace freezing behavior.

This is a host-side simulation of the firmware trace ring buffer. It verifies
that a shot does not freeze the trace immediately, and that samples logged
during the configured follow-through delay are present in the frozen trace.
"""

from __future__ import annotations

import argparse
import math
from dataclasses import dataclass


TRACE_CAPACITY = 1000


@dataclass(frozen=True)
class TracePoint:
    index: int
    phase: str


class TraceRing:
    def __init__(self, capacity: int = TRACE_CAPACITY) -> None:
        self.capacity = capacity
        self.points: list[TracePoint | None] = [None] * capacity
        self.write_idx = 0
        self.count = 0

    def push(self, point: TracePoint) -> None:
        self.points[self.write_idx] = point
        self.write_idx = (self.write_idx + 1) % self.capacity
        self.count = min(self.count + 1, self.capacity)

    def freeze(self) -> list[TracePoint]:
        read_idx = self.write_idx if self.count == self.capacity else 0
        frozen: list[TracePoint] = []
        for _ in range(self.count):
            point = self.points[read_idx]
            if point is None:
                raise AssertionError("trace ring contained an empty point")
            frozen.append(point)
            read_idx = (read_idx + 1) % self.capacity
        return frozen


def follow_points(follow_ms: int, buffer_hz: int) -> int:
    return math.ceil((follow_ms / 1000.0) * buffer_hz)


def verify_delayed_freeze(
    *,
    follow_ms: int,
    buffer_hz: int,
    pre_seconds: float,
    capacity: int,
) -> tuple[list[TracePoint], int]:
    ring = TraceRing(capacity)
    pre_count = int(pre_seconds * buffer_hz)

    for idx in range(pre_count):
        ring.push(TracePoint(index=idx, phase="pre"))

    immediate = ring.freeze()
    immediate_post = sum(1 for point in immediate if point.phase == "post")
    if immediate_post != 0:
        raise AssertionError("immediate pre-shot snapshot unexpectedly had post-shot samples")

    expected_post = follow_points(follow_ms, buffer_hz)
    for idx in range(expected_post):
        ring.push(TracePoint(index=idx, phase="post"))

    frozen = ring.freeze()
    post_count = sum(1 for point in frozen if point.phase == "post")
    if post_count != expected_post:
        raise AssertionError(
            f"expected {expected_post} post-shot points, found {post_count}"
        )

    trailing = frozen[-expected_post:] if expected_post else []
    if any(point.phase != "post" for point in trailing):
        raise AssertionError("post-shot samples were not at the end of the frozen trace")

    if len(frozen) > capacity:
        raise AssertionError("frozen trace exceeded ring capacity")

    return frozen, expected_post


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Verify OpenFloat delayed follow-through trace freezing."
    )
    parser.add_argument("--follow-ms", type=int, default=1500)
    parser.add_argument("--buffer-hz", type=int, default=52, choices=[52, 104, 208])
    parser.add_argument("--pre-seconds", type=float, default=6.0)
    parser.add_argument("--capacity", type=int, default=TRACE_CAPACITY)
    args = parser.parse_args()

    frozen, expected_post = verify_delayed_freeze(
        follow_ms=args.follow_ms,
        buffer_hz=args.buffer_hz,
        pre_seconds=args.pre_seconds,
        capacity=args.capacity,
    )

    pre_count = sum(1 for point in frozen if point.phase == "pre")
    post_count = sum(1 for point in frozen if point.phase == "post")
    print("PASS delayed follow-through trace freeze")
    print(f"buffer_rate_hz={args.buffer_hz}")
    print(f"follow_ms={args.follow_ms}")
    print(f"expected_post_points={expected_post}")
    print(f"frozen_trace_points={len(frozen)}")
    print(f"pre_points={pre_count}")
    print(f"post_points={post_count}")
    print(f"last_point_phase={frozen[-1].phase if frozen else 'none'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
