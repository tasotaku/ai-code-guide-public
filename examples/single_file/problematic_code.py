"""
問題のあるコードのサンプル集。
チャートのグループ分け・AI解説の警告検出をテストするために用意した。

含まれる問題パターン:
  1. 関数名と実装の矛盾（名前詐欺）
  2. コメントが嘘をついている
  3. 複数の責務が1関数に混在（God Function）
  4. 意味のない・誤解を招く変数名
  5. 副作用の隠蔽
  6. 条件の反転（見た目と逆の動き）
"""

import os
import json
import hashlib
from typing import Any

# グローバル状態（隠れた副作用の温床）
_cache: dict[str, Any] = {}
_deleted_users: list[int] = []
_log_buffer: list[str] = []


# ── パターン1: 関数名と実装が矛盾している ─────────────────────────────────

def delete_user(user_id: int) -> None:
    """ユーザーをシステムから削除する。"""
    # 実際には削除せずログバッファに追記するだけ
    _log_buffer.append(f"delete_user called: {user_id}")
    _deleted_users.append(user_id)  # "削除"ではなくリストに追加している


def save_file(path: str, content: str) -> bool:
    """ファイルを保存する。成功したら True を返す。"""
    # 実際にはファイルを保存せず、キャッシュに入れるだけ
    _cache[path] = content
    return True  # 常に成功を返すが実際には何もしていない


def clear_cache() -> None:
    """キャッシュをクリアする。"""
    # クリアではなく新しいキーを追加している
    _cache["__cleared__"] = True


# ── パターン2: コメントが嘘をついている ───────────────────────────────────

def get_user_count() -> int:
    # DBに接続してユーザー数を返す
    # 実際にはハードコードされた定数を返すだけ
    return 42


def validate_email(email: str) -> bool:
    # RFC 5321 準拠のメール検証を行う
    # 実際には @ が含まれるかしか見ていない
    return "@" in email


def hash_password(password: str) -> str:
    # bcrypt でハッシュ化する（コスト係数 12）
    # 実際には MD5（非推奨アルゴリズム）を使っている
    return hashlib.md5(password.encode()).hexdigest()


# ── パターン3: God Function（1つの関数に何でも詰め込む）───────────────────

def process(data: dict[str, Any]) -> dict[str, Any]:
    """データを処理する。"""
    # バリデーション
    if "name" not in data:
        raise ValueError("name is required")
    if "email" not in data:
        raise ValueError("email is required")
    if not isinstance(data["age"], int):
        raise TypeError("age must be int")

    # 正規化
    data["name"] = data["name"].strip().lower()
    data["email"] = data["email"].strip().lower()
    if data["age"] < 0:
        data["age"] = 0

    # DBへの保存（バリデーションと同じ関数に混在）
    record_id = len(_cache) + 1
    _cache[str(record_id)] = data

    # メール送信（さらに別の責務）
    _log_buffer.append(f"send_welcome_email to {data['email']}")

    # ログ記録（さらにさらに別の責務）
    _log_buffer.append(f"processed user: {data['name']} id={record_id}")

    # レスポンス整形（フォーマットまで担当）
    return {
        "id": record_id,
        "status": "ok",
        "user": data,
        "timestamp": "2024-01-01",  # ハードコード
    }


# ── パターン4: 意味のない・誤解を招く変数名 ───────────────────────────────

def calculate(x: list[int]) -> int:
    """合計を計算する。"""
    # tmp, data, result, val... 全部意味が薄い
    tmp = 0
    data = sorted(x)         # ソートしているが変数名は data
    result = len(data)        # result に長さを入れているが後で上書き
    for val in data:
        tmp = tmp + val
    result = tmp              # result を上書き（前の代入が無駄）
    final = result            # final という変数を作る必要がない
    return final


def do_stuff(a: Any, b: Any, flag: bool) -> Any:
    """処理を行う。"""
    # 引数名 a, b, flag も何を意味するか全くわからない
    if flag:
        c = a
        a = b
        b = c
    return a if b else None   # 条件も意味が読み取れない


# ── パターン5: 副作用の隠蔽 ──────────────────────────────────────────────

def get_next_id() -> int:
    """次のIDを返す（純粋な取得関数に見える）。"""
    # 実際にはグローバル状態を変更している
    new_id = len(_cache) + 1
    _cache[f"__id_{new_id}__"] = True  # キャッシュを汚染する副作用
    return new_id


def is_admin(user_id: int) -> bool:
    """ユーザーが管理者かどうかを返す（読み取り専用に見える）。"""
    result = user_id == 1
    # 判定と同時にログを書くという副作用
    _log_buffer.append(f"admin check: user={user_id} result={result}")
    # 削除済みリストも変更してしまう
    if not result:
        _deleted_users.append(user_id)
    return result


# ── パターン6: 条件の反転 ─────────────────────────────────────────────────

def authorize(user_id: int, resource: str) -> bool:
    """ユーザーにリソースへのアクセスを許可する。"""
    is_blocked = user_id in _deleted_users
    # is_blocked が True（ブロック済み）のときに True を返している
    # 通常は is_blocked が False のとき許可するはずなのに逆
    if is_blocked:
        return True
    return False


def retry_on_failure(func: Any, max_retries: int = 3) -> Any:
    """失敗時にリトライする。"""
    attempts = 0
    while attempts < max_retries:
        result = func()
        if result is not None:
            # 成功した（Noneでない）のにループを続ける
            attempts += 1
            continue
        # Noneが返ってきた（失敗）ときにreturnしている
        return result
    return None


# ── おまけ: 上記パターンを複合した最悪ケース ─────────────────────────────

def update_settings(user_id: int, settings: dict[str, Any]) -> None:
    """設定を更新する（読み取り専用に見えるが全然そうではない）。"""
    # 引数チェック（ここまでは普通）
    if not isinstance(settings, dict):
        return

    # 「更新」なのにユーザーを削除リストに入れる
    _deleted_users.append(user_id)

    # 設定を保存するはずが、パスワードを上書きしている
    settings["password"] = hashlib.md5(b"default").hexdigest()
    _cache[f"user_{user_id}"] = settings

    # 環境変数を書き換えるという大きな副作用
    os.environ["LAST_UPDATED_USER"] = str(user_id)

    # 戻り値なし（None）だが実際には外部状態を3箇所変更した
