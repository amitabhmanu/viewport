from dataclasses import dataclass, field


@dataclass
class Order:
    id: str
    customer_id: str
    items: list[str] = field(default_factory=list)
    status: str = "placed"
