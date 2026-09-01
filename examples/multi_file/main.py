"""エントリポイント。シナリオを順に実行して動作確認する。"""

import web


def run_scenario() -> None:
    """ユーザー登録 → ログイン → 注文 → 注文確認のシナリオを実行する。"""
    # ユーザー登録
    res = web.handle_register({"email": "alice@example.com", "password": "secure123"})
    print(f"register: {res}")

    # 重複登録（エラーになるはず）
    res = web.handle_register({"email": "alice@example.com", "password": "other"})
    print(f"register duplicate: {res}")

    # ログイン
    res = web.handle_login({"email": "alice@example.com", "password": "secure123"})
    print(f"login: {res}")

    # 注文
    res = web.handle_place_order(
        {"item": "Widget A", "quantity": 3},
        email="alice@example.com",
    )
    print(f"order: {res}")

    # 注文一覧確認
    res = web.handle_get_orders("alice@example.com")
    print(f"orders: {res}")


if __name__ == "__main__":
    run_scenario()
