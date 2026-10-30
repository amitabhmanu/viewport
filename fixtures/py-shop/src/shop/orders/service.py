"""Order lifecycle. Uses payments, notifications and storage."""
import uuid

from shop.notifications.queue import enqueue
from shop.payments.gateway import charge, refund
from shop.storage.db import load, save

from .models import Order


def place_order(customer_id: str, items: list[str]) -> dict:
    order = Order(id=str(uuid.uuid4()), customer_id=customer_id, items=items)
    charge(customer_id, len(items) * 100)
    save(order)
    enqueue("order_placed", order.id)
    return {"id": order.id, "status": order.status}


def cancel_order(order_id: str) -> dict:
    order = load(order_id)
    if order.status == "shipped":
        refund(order.customer_id, len(order.items) * 100)
    order.status = "cancelled"
    save(order)
    enqueue("order_cancelled", order.id)
    return {"id": order.id, "status": order.status}
