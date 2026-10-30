"""HTTP routes. Depends on orders only."""
from shop.orders.service import cancel_order, place_order


def post_order(customer_id: str, items: list[str]) -> dict:
    return place_order(customer_id, items)


def post_cancel(order_id: str) -> dict:
    return cancel_order(order_id)
