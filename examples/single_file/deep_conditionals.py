"""深いネスト条件分岐のテスト。ユーザーのアクセス制御ロジックを模倣する。"""

from typing import Optional


def check_access(
    role: str,
    resource: str,
    is_owner: bool,
    is_banned: bool,
    subscription: Optional[str],
) -> str:
    """ユーザーのリソースアクセス可否を判定して理由を返す。"""
    if is_banned:
        return "denied: banned"

    if role == "admin":
        return "allowed: admin"

    if role == "guest":
        if resource == "public":
            return "allowed: guest+public"
        else:
            return "denied: guest restricted"

    if role == "user":
        if resource == "public":
            return "allowed: user+public"
        elif resource == "premium":
            if subscription is None:
                return "denied: no subscription"
            elif subscription == "expired":
                return "denied: subscription expired"
            elif subscription == "trial":
                if is_owner:
                    return "allowed: trial owner"
                else:
                    return "denied: trial non-owner"
            else:
                return "allowed: active subscription"
        elif resource == "private":
            if is_owner:
                return "allowed: owner"
            else:
                return "denied: not owner"
        else:
            return "denied: unknown resource"

    return "denied: unknown role"


def classify_score(score: int, attempts: int, time_sec: float) -> str:
    """スコア・試行回数・時間からランクを決定する。"""
    if score < 0 or attempts <= 0 or time_sec <= 0:
        return "invalid"

    if score >= 90:
        if attempts == 1:
            if time_sec < 30:
                return "S+"
            elif time_sec < 60:
                return "S"
            else:
                return "A+"
        elif attempts <= 3:
            if time_sec < 60:
                return "A"
            else:
                return "B+"
        else:
            return "B"
    elif score >= 70:
        if attempts <= 2:
            return "B+"
        elif attempts <= 5:
            return "B"
        else:
            return "C"
    elif score >= 50:
        if attempts <= 3:
            return "C"
        else:
            return "D"
    else:
        return "F"


if __name__ == "__main__":
    print(check_access("user", "premium", False, False, "active"))
    print(check_access("guest", "private", False, False, None))
    print(classify_score(95, 1, 25))
    print(classify_score(72, 4, 90))
