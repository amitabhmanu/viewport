"""In-memory order store."""
from shop.orders.models import Order

_ORDERS: dict[str, Order] = {}


def save(order: Order) -> None:
    _ORDERS[order.id] = order


def load(order_id: str) -> Order:
    return _ORDERS[order_id]
