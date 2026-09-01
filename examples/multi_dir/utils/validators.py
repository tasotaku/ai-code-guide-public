"""入力バリデーション関数群。"""


def validate_email(email: str) -> bool:
    """メールアドレスの基本形式チェック。"""
    if not email or "@" not in email:
        return False
    local, _, domain = email.partition("@")
    return bool(local) and "." in domain


def validate_quantity(quantity: int) -> bool:
    """数量が正の整数かチェック。"""
    return isinstance(quantity, int) and quantity > 0


def validate_price(price: float) -> bool:
    """価格が正の数値かチェック。"""
    return isinstance(price, (int, float)) and price > 0


def validate_token_format(token: str) -> bool:
    """トークン形式の簡易チェック。16バイト以上の16進数文字列。"""
    return isinstance(token, str) and len(token) >= 32
