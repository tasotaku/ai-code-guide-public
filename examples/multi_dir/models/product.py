"""商品モデル。"""


class Product:
    def __init__(self, product_id: str, name: str, price: float, stock: int) -> None:
        self.product_id = product_id
        self.name = name
        self.price = price
        self.stock = stock

    def is_available(self) -> bool:
        return self.stock > 0

    def to_dict(self) -> dict:
        return {
            "id": self.product_id,
            "name": self.name,
            "price": self.price,
            "stock": self.stock,
        }
