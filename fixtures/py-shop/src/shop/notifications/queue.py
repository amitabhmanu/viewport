"""Async notifications via an in-process queue."""
from collections import deque

_QUEUE: deque[tuple[str, str]] = deque()


def enqueue(event: str, order_id: str) -> None:
    _QUEUE.append((event, order_id))
