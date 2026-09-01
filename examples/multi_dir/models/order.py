"""注文モデル。"""

import datetime


class OrderItem:
    def __init__(self, product_id: str, quantity: int, unit_price: float) -> None:
        self.product_id = product_id
        self.quantity = quantity
        self.unit_price = unit_price

    def subtotal(self) -> float:
        return self.quantity * self.unit_price


class Order:
    def __init__(self, order_id: str, user_email: str) -> None:
        self.order_id = order_id
        self.user_email = user_email
        self.items: list[OrderItem] = []
        self.status = "pending"
        self.created_at = datetime.datetime.utcnow()

    def add_item(self, product_id: str, quantity: int, unit_price: float) -> None:
        self.items.append(OrderItem(product_id, quantity, unit_price))

    def total(self) -> float:
        return sum(item.subtotal() for item in self.items)

    def to_dict(self) -> dict:
        return {
            "order_id": self.order_id,
            "user_email": self.user_email,
            "status": self.status,
            "total": self.total(),
            "item_count": len(self.items),
        }
