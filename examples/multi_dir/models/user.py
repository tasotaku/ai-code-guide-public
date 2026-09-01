"""ユーザーモデル。"""

import datetime


class User:
    def __init__(self, email: str, password_hash: str, name: str = "") -> None:
        self.email = email
        self.password_hash = password_hash
        self.name = name
        self.created_at = datetime.datetime.utcnow()
        self.is_active = True

    def to_dict(self) -> dict:
        return {
            "email": self.email,
            "name": self.name,
            "created_at": self.created_at.isoformat(),
            "is_active": self.is_active,
        }
