"""タスク管理システムのサンプル。
データモデル・バリデーション・ビジネスロジック・レポートが混在するファイル構成で
粒度切り替えのテスト用に作成。
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from enum import Enum
from typing import Optional


# --- データモデル ---

class Priority(Enum):
    LOW = 1
    MEDIUM = 2
    HIGH = 3
    CRITICAL = 4


class Status(Enum):
    TODO = "todo"
    IN_PROGRESS = "in_progress"
    REVIEW = "review"
    DONE = "done"
    CANCELLED = "cancelled"


@dataclass
class User:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    email: str = ""
    team: str = ""
    capacity: int = 5  # 同時に担当できるタスク数

    def __str__(self) -> str:
        return f"{self.name} <{self.email}>"


@dataclass
class Tag:
    name: str
    color: str = "#888888"


@dataclass
class Task:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    title: str = ""
    description: str = ""
    status: Status = Status.TODO
    priority: Priority = Priority.MEDIUM
    assignee: Optional[User] = None
    created_at: datetime = field(default_factory=datetime.now)
    due_date: Optional[datetime] = None
    tags: list[Tag] = field(default_factory=list)
    subtasks: list[Task] = field(default_factory=list)
    estimate_hours: float = 0.0

    def is_overdue(self) -> bool:
        if not self.due_date or self.status == Status.DONE:
            return False
        return datetime.now() > self.due_date

    def progress(self) -> float:
        if not self.subtasks:
            return 1.0 if self.status == Status.DONE else 0.0
        done = sum(1 for t in self.subtasks if t.status == Status.DONE)
        return done / len(self.subtasks)


@dataclass
class Project:
    id: str = field(default_factory=lambda: str(uuid.uuid4()))
    name: str = ""
    tasks: list[Task] = field(default_factory=list)
    members: list[User] = field(default_factory=list)
    deadline: Optional[datetime] = None


# --- バリデーション ---

def validate_email(email: str) -> bool:
    """メールアドレスの形式チェック。"""
    return "@" in email and "." in email.split("@")[-1]


def validate_user(user: User) -> list[str]:
    """ユーザー情報のバリデーション。エラーメッセージのリストを返す。"""
    errors: list[str] = []
    if not user.name.strip():
        errors.append("名前は必須です")
    if not validate_email(user.email):
        errors.append(f"メールアドレスの形式が不正です: {user.email}")
    if user.capacity < 1 or user.capacity > 20:
        errors.append("処理可能タスク数は1〜20の範囲で指定してください")
    return errors


def validate_task(task: Task) -> list[str]:
    """タスク情報のバリデーション。"""
    errors: list[str] = []
    if not task.title.strip():
        errors.append("タイトルは必須です")
    if len(task.title) > 100:
        errors.append("タイトルは100文字以内にしてください")
    if task.estimate_hours < 0:
        errors.append("見積もり時間は0以上を指定してください")
    if task.due_date and task.due_date < task.created_at:
        errors.append("期限は作成日時より後に設定してください")
    return errors


def validate_project(project: Project) -> list[str]:
    """プロジェクト情報のバリデーション。"""
    errors: list[str] = []
    if not project.name.strip():
        errors.append("プロジェクト名は必須です")
    if project.deadline and project.deadline < datetime.now():
        errors.append("締め切りが過去の日時になっています")
    return errors


# --- タスク管理ロジック ---

def create_task(
    title: str,
    priority: Priority = Priority.MEDIUM,
    assignee: Optional[User] = None,
    due_days: Optional[int] = None,
    estimate_hours: float = 0.0,
) -> Task:
    """タスクを作成して返す。due_days が指定されたら今日から N 日後を期限にする。"""
    due_date = datetime.now() + timedelta(days=due_days) if due_days is not None else None
    task = Task(
        title=title,
        priority=priority,
        assignee=assignee,
        due_date=due_date,
        estimate_hours=estimate_hours,
    )
    errors = validate_task(task)
    if errors:
        raise ValueError(f"タスク作成エラー: {', '.join(errors)}")
    return task


def assign_task(task: Task, user: User, project: Project) -> None:
    """タスクをユーザーに割り当てる。処理可能数を超えている場合はエラー。"""
    current_load = sum(
        1 for t in project.tasks
        if t.assignee and t.assignee.id == user.id and t.status not in (Status.DONE, Status.CANCELLED)
    )
    if current_load >= user.capacity:
        raise ValueError(f"{user.name} の担当可能タスク数({user.capacity})を超えています")
    task.assignee = user


def update_status(task: Task, new_status: Status) -> None:
    """タスクのステータスを更新する。無効な遷移はエラー。"""
    valid_transitions: dict[Status, list[Status]] = {
        Status.TODO:        [Status.IN_PROGRESS, Status.CANCELLED],
        Status.IN_PROGRESS: [Status.REVIEW, Status.TODO, Status.CANCELLED],
        Status.REVIEW:      [Status.DONE, Status.IN_PROGRESS],
        Status.DONE:        [],
        Status.CANCELLED:   [],
    }
    if new_status not in valid_transitions[task.status]:
        raise ValueError(
            f"ステータス遷移エラー: {task.status.value} → {new_status.value} は許可されていません"
        )
    task.status = new_status


def bulk_assign(tasks: list[Task], user: User, project: Project) -> list[str]:
    """複数タスクをまとめて割り当てる。失敗したものはエラーメッセージで返す。"""
    errors: list[str] = []
    for task in tasks:
        try:
            assign_task(task, user, project)
        except ValueError as e:
            errors.append(f"{task.title}: {e}")
    return errors


def add_subtask(parent: Task, title: str, estimate_hours: float = 0.0) -> Task:
    """親タスクにサブタスクを追加する。"""
    sub = create_task(title, parent.priority, estimate_hours=estimate_hours)
    parent.subtasks.append(sub)
    return sub


# --- レポート・集計 ---

def overdue_tasks(project: Project) -> list[Task]:
    """プロジェクト内の期限超過タスクを返す。"""
    return [t for t in project.tasks if t.is_overdue()]


def tasks_by_assignee(project: Project) -> dict[str, list[Task]]:
    """担当者ごとにタスクをグループ化して返す。"""
    result: dict[str, list[Task]] = {}
    for task in project.tasks:
        key = task.assignee.name if task.assignee else "未担当"
        result.setdefault(key, []).append(task)
    return result


def workload_summary(project: Project) -> dict[str, float]:
    """担当者ごとの合計見積もり時間を返す。"""
    summary: dict[str, float] = {}
    for task in project.tasks:
        if task.status in (Status.DONE, Status.CANCELLED):
            continue
        key = task.assignee.name if task.assignee else "未担当"
        summary[key] = summary.get(key, 0.0) + task.estimate_hours
    return summary


def completion_rate(project: Project) -> float:
    """プロジェクト全体の完了率（0〜1）を返す。"""
    if not project.tasks:
        return 0.0
    total = sum(t.progress() for t in project.tasks)
    return total / len(project.tasks)


def critical_path(project: Project) -> list[Task]:
    """優先度 HIGH/CRITICAL かつ期限が近いタスクを優先順に返す。"""
    candidates = [
        t for t in project.tasks
        if t.priority in (Priority.HIGH, Priority.CRITICAL)
        and t.status not in (Status.DONE, Status.CANCELLED)
    ]
    return sorted(candidates, key=lambda t: (
        t.due_date or datetime.max,
        -t.priority.value,
    ))


# --- デモ実行 ---

if __name__ == "__main__":
    # メンバー作成
    alice = User(name="Alice", email="alice@example.com", team="backend", capacity=4)
    bob   = User(name="Bob",   email="bob@example.com",   team="frontend", capacity=3)

    # プロジェクト作成
    proj = Project(
        name="v2.0リリース",
        members=[alice, bob],
        deadline=datetime.now() + timedelta(days=30),
    )

    # タスク追加
    t1 = create_task("認証APIの実装",   Priority.HIGH,     alice, due_days=10, estimate_hours=8.0)
    t2 = create_task("UIコンポーネント", Priority.MEDIUM,   bob,   due_days=14, estimate_hours=5.0)
    t3 = create_task("DBマイグレーション", Priority.CRITICAL, alice, due_days=5,  estimate_hours=3.0)
    t4 = create_task("ドキュメント整備",  Priority.LOW,      bob,   due_days=20, estimate_hours=2.0)
    t5 = create_task("パフォーマンステスト", Priority.HIGH,  None,  due_days=12, estimate_hours=4.0)

    proj.tasks.extend([t1, t2, t3, t4, t5])

    # サブタスク
    add_subtask(t1, "JWTトークン生成", 2.0)
    add_subtask(t1, "リフレッシュトークン対応", 3.0)

    # ステータス更新
    update_status(t3, Status.IN_PROGRESS)
    update_status(t1, Status.IN_PROGRESS)

    # レポート出力
    print(f"完了率: {completion_rate(proj):.0%}")
    print(f"期限超過: {[t.title for t in overdue_tasks(proj)]}")
    print("クリティカルパス:")
    for t in critical_path(proj):
        due = t.due_date.strftime("%m/%d") if t.due_date else "なし"
        print(f"  [{t.priority.name}] {t.title} (期限: {due})")
    print("工数サマリー:")
    for name, hours in workload_summary(proj).items():
        print(f"  {name}: {hours}h")
