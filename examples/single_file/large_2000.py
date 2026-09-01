"""
library_system.py — 図書館管理システム（フローチャートテスト用: ~2000行）
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, timedelta
from enum import Enum
from typing import Callable, Iterator

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums / constants
# ---------------------------------------------------------------------------

class Genre(Enum):
    FICTION = "fiction"
    NON_FICTION = "non_fiction"
    SCIENCE = "science"
    HISTORY = "history"
    BIOGRAPHY = "biography"
    CHILDREN = "children"
    MANGA = "manga"
    REFERENCE = "reference"
    OTHER = "other"


class BookStatus(Enum):
    AVAILABLE = "available"
    BORROWED = "borrowed"
    RESERVED = "reserved"
    LOST = "lost"
    UNDER_REPAIR = "under_repair"
    DISPOSED = "disposed"


class MembershipTier(Enum):
    BASIC = "basic"
    STANDARD = "standard"
    PREMIUM = "premium"


class LoanStatus(Enum):
    ACTIVE = "active"
    RETURNED = "returned"
    OVERDUE = "overdue"
    LOST = "lost"


class EventType(Enum):
    LOAN = "loan"
    RETURN = "return"
    RESERVATION = "reservation"
    RESERVATION_CANCELLED = "reservation_cancelled"
    MEMBER_REGISTERED = "member_registered"
    BOOK_ADDED = "book_added"
    BOOK_DISPOSED = "book_disposed"
    FEE_PAID = "fee_paid"


LOAN_DAYS: dict[MembershipTier, int] = {
    MembershipTier.BASIC: 7,
    MembershipTier.STANDARD: 14,
    MembershipTier.PREMIUM: 30,
}
MAX_LOANS: dict[MembershipTier, int] = {
    MembershipTier.BASIC: 3,
    MembershipTier.STANDARD: 7,
    MembershipTier.PREMIUM: 15,
}
OVERDUE_FEE_PER_DAY = 10  # JPY
MAX_RESERVATIONS = 5
ISBN_PATTERN = re.compile(r"^(?:97[89])?\d{9}[\dX]$")


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class ISBN:
    value: str

    def __post_init__(self) -> None:
        cleaned = self.value.replace("-", "").replace(" ", "")
        object.__setattr__(self, "value", cleaned)
        if not ISBN_PATTERN.match(cleaned):
            raise ValueError(f"Invalid ISBN: {self.value}")

    def __str__(self) -> str:
        return self.value


@dataclass(frozen=True)
class Money:
    amount: int  # JPY, integer
    currency: str = "JPY"

    def __add__(self, other: Money) -> Money:
        if self.currency != other.currency:
            raise ValueError("Currency mismatch")
        return Money(self.amount + other.amount, self.currency)

    def __sub__(self, other: Money) -> Money:
        if self.currency != other.currency:
            raise ValueError("Currency mismatch")
        return Money(self.amount - other.amount, self.currency)

    def __mul__(self, n: int) -> Money:
        return Money(self.amount * n, self.currency)

    def is_zero(self) -> bool:
        return self.amount == 0

    def __str__(self) -> str:
        return f"¥{self.amount:,}"


ZERO_MONEY = Money(0)


# ---------------------------------------------------------------------------
# Domain models
# ---------------------------------------------------------------------------

@dataclass
class Author:
    author_id: str
    name: str
    birth_year: int | None = None
    nationality: str = ""
    bio: str = ""

    def display_name(self) -> str:
        return self.name


@dataclass
class Book:
    book_id: str
    isbn: ISBN
    title: str
    authors: list[Author]
    genre: Genre
    publisher: str
    published_year: int
    pages: int
    language: str = "ja"
    summary: str = ""
    tags: list[str] = field(default_factory=list)
    status: BookStatus = BookStatus.AVAILABLE
    added_at: datetime = field(default_factory=datetime.now)
    location: str = ""

    def author_names(self) -> str:
        return ", ".join(a.display_name() for a in self.authors)

    def is_available(self) -> bool:
        return self.status == BookStatus.AVAILABLE

    def mark_borrowed(self) -> None:
        if self.status != BookStatus.AVAILABLE:
            raise ValueError(f"Book {self.book_id} is not available (status={self.status})")
        self.status = BookStatus.BORROWED

    def mark_returned(self) -> None:
        if self.status not in (BookStatus.BORROWED, BookStatus.OVERDUE if hasattr(BookStatus, "OVERDUE") else BookStatus.BORROWED):
            pass
        self.status = BookStatus.AVAILABLE

    def mark_reserved(self) -> None:
        if self.status != BookStatus.AVAILABLE:
            raise ValueError(f"Book {self.book_id} cannot be reserved (status={self.status})")
        self.status = BookStatus.RESERVED

    def mark_lost(self) -> None:
        self.status = BookStatus.LOST

    def dispose(self) -> None:
        self.status = BookStatus.DISPOSED

    def matches_query(self, query: str) -> bool:
        q = query.lower()
        return (
            q in self.title.lower()
            or q in self.summary.lower()
            or any(q in a.name.lower() for a in self.authors)
            or any(q in t.lower() for t in self.tags)
        )

    def to_dict(self) -> dict:
        return {
            "book_id": self.book_id,
            "isbn": str(self.isbn),
            "title": self.title,
            "authors": [a.name for a in self.authors],
            "genre": self.genre.value,
            "publisher": self.publisher,
            "published_year": self.published_year,
            "status": self.status.value,
            "location": self.location,
        }


@dataclass
class Member:
    member_id: str
    name: str
    email: str
    tier: MembershipTier = MembershipTier.STANDARD
    joined_at: datetime = field(default_factory=datetime.now)
    active: bool = True
    outstanding_fee: Money = field(default_factory=lambda: ZERO_MONEY)
    address: str = ""
    phone: str = ""

    def can_borrow(self, current_loan_count: int) -> bool:
        if not self.active:
            return False
        if not self.outstanding_fee.is_zero():
            return False
        return current_loan_count < MAX_LOANS[self.tier]

    def loan_period_days(self) -> int:
        return LOAN_DAYS[self.tier]

    def max_loans(self) -> int:
        return MAX_LOANS[self.tier]

    def add_fee(self, amount: Money) -> None:
        self.outstanding_fee = self.outstanding_fee + amount

    def pay_fee(self, amount: Money) -> Money:
        if amount.amount > self.outstanding_fee.amount:
            raise ValueError(f"Overpayment: paying {amount}, outstanding {self.outstanding_fee}")
        self.outstanding_fee = self.outstanding_fee - amount
        return self.outstanding_fee

    def to_dict(self) -> dict:
        return {
            "member_id": self.member_id,
            "name": self.name,
            "email": self.email,
            "tier": self.tier.value,
            "active": self.active,
            "outstanding_fee": self.outstanding_fee.amount,
        }


@dataclass
class Loan:
    loan_id: str
    book: Book
    member: Member
    borrowed_at: datetime
    due_at: datetime
    returned_at: datetime | None = None
    status: LoanStatus = LoanStatus.ACTIVE
    overdue_fee: Money = field(default_factory=lambda: ZERO_MONEY)

    def is_overdue(self, as_of: datetime | None = None) -> bool:
        if self.status in (LoanStatus.RETURNED, LoanStatus.LOST):
            return False
        check_time = as_of or datetime.now()
        return check_time > self.due_at

    def days_overdue(self, as_of: datetime | None = None) -> int:
        if not self.is_overdue(as_of):
            return 0
        check_time = as_of or datetime.now()
        return (check_time - self.due_at).days

    def calc_overdue_fee(self, as_of: datetime | None = None) -> Money:
        days = self.days_overdue(as_of)
        return Money(days * OVERDUE_FEE_PER_DAY)

    def return_book(self, returned_at: datetime | None = None) -> Money:
        self.returned_at = returned_at or datetime.now()
        fee = self.calc_overdue_fee(self.returned_at)
        self.overdue_fee = fee
        self.status = LoanStatus.RETURNED
        return fee

    def mark_lost(self) -> None:
        self.status = LoanStatus.LOST

    def to_dict(self) -> dict:
        return {
            "loan_id": self.loan_id,
            "book_id": self.book.book_id,
            "member_id": self.member.member_id,
            "borrowed_at": self.borrowed_at.isoformat(),
            "due_at": self.due_at.isoformat(),
            "returned_at": self.returned_at.isoformat() if self.returned_at else None,
            "status": self.status.value,
            "overdue_fee": self.overdue_fee.amount,
        }


@dataclass
class Reservation:
    reservation_id: str
    book: Book
    member: Member
    reserved_at: datetime = field(default_factory=datetime.now)
    expires_at: datetime = field(default_factory=lambda: datetime.now() + timedelta(days=7))
    cancelled_at: datetime | None = None
    fulfilled_at: datetime | None = None

    def is_active(self) -> bool:
        return self.cancelled_at is None and self.fulfilled_at is None

    def is_expired(self) -> bool:
        return self.is_active() and datetime.now() > self.expires_at

    def cancel(self) -> None:
        if not self.is_active():
            raise ValueError(f"Reservation {self.reservation_id} is not active")
        self.cancelled_at = datetime.now()

    def fulfill(self) -> None:
        if not self.is_active():
            raise ValueError(f"Reservation {self.reservation_id} is not active")
        self.fulfilled_at = datetime.now()


@dataclass
class AuditEvent:
    event_id: str
    event_type: EventType
    actor_id: str
    target_id: str
    detail: dict
    occurred_at: datetime = field(default_factory=datetime.now)

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "event_type": self.event_type.value,
            "actor_id": self.actor_id,
            "target_id": self.target_id,
            "detail": self.detail,
            "occurred_at": self.occurred_at.isoformat(),
        }


# ---------------------------------------------------------------------------
# Repository layer
# ---------------------------------------------------------------------------

class BookRepository:
    def __init__(self) -> None:
        self._books: dict[str, Book] = {}
        self._isbn_index: dict[str, str] = {}  # isbn -> book_id

    def add(self, book: Book) -> None:
        isbn_str = str(book.isbn)
        if isbn_str in self._isbn_index:
            raise ValueError(f"ISBN already registered: {isbn_str}")
        self._books[book.book_id] = book
        self._isbn_index[isbn_str] = book.book_id

    def get(self, book_id: str) -> Book | None:
        return self._books.get(book_id)

    def get_or_raise(self, book_id: str) -> Book:
        b = self.get(book_id)
        if b is None:
            raise KeyError(f"Book not found: {book_id}")
        return b

    def by_isbn(self, isbn: str) -> Book | None:
        book_id = self._isbn_index.get(isbn.replace("-", ""))
        return self._books.get(book_id) if book_id else None

    def available(self) -> list[Book]:
        return [b for b in self._books.values() if b.is_available()]

    def by_genre(self, genre: Genre) -> list[Book]:
        return [b for b in self._books.values() if b.genre == genre]

    def search(self, query: str) -> list[Book]:
        return [b for b in self._books.values() if b.matches_query(query)]

    def all(self) -> list[Book]:
        return list(self._books.values())

    def count_by_status(self) -> dict[str, int]:
        counts: dict[str, int] = {s.value: 0 for s in BookStatus}
        for b in self._books.values():
            counts[b.status.value] += 1
        return counts


class MemberRepository:
    def __init__(self) -> None:
        self._members: dict[str, Member] = {}
        self._email_index: dict[str, str] = {}

    def add(self, member: Member) -> None:
        if member.email in self._email_index:
            raise ValueError(f"Email already registered: {member.email}")
        self._members[member.member_id] = member
        self._email_index[member.email] = member.member_id

    def get(self, member_id: str) -> Member | None:
        return self._members.get(member_id)

    def get_or_raise(self, member_id: str) -> Member:
        m = self.get(member_id)
        if m is None:
            raise KeyError(f"Member not found: {member_id}")
        return m

    def by_email(self, email: str) -> Member | None:
        member_id = self._email_index.get(email)
        return self._members.get(member_id) if member_id else None

    def active(self) -> list[Member]:
        return [m for m in self._members.values() if m.active]

    def with_outstanding_fees(self) -> list[Member]:
        return [m for m in self._members.values() if not m.outstanding_fee.is_zero()]

    def all(self) -> list[Member]:
        return list(self._members.values())


class LoanRepository:
    def __init__(self) -> None:
        self._loans: dict[str, Loan] = {}

    def add(self, loan: Loan) -> None:
        self._loans[loan.loan_id] = loan

    def get(self, loan_id: str) -> Loan | None:
        return self._loans.get(loan_id)

    def get_or_raise(self, loan_id: str) -> Loan:
        l = self.get(loan_id)
        if l is None:
            raise KeyError(f"Loan not found: {loan_id}")
        return l

    def active_by_member(self, member_id: str) -> list[Loan]:
        return [
            l for l in self._loans.values()
            if l.member.member_id == member_id and l.status == LoanStatus.ACTIVE
        ]

    def active_by_book(self, book_id: str) -> Loan | None:
        for l in self._loans.values():
            if l.book.book_id == book_id and l.status == LoanStatus.ACTIVE:
                return l
        return None

    def overdue(self, as_of: datetime | None = None) -> list[Loan]:
        return [l for l in self._loans.values() if l.is_overdue(as_of)]

    def history_by_member(self, member_id: str) -> list[Loan]:
        return [l for l in self._loans.values() if l.member.member_id == member_id]

    def all(self) -> list[Loan]:
        return list(self._loans.values())


class ReservationRepository:
    def __init__(self) -> None:
        self._reservations: dict[str, Reservation] = {}

    def add(self, reservation: Reservation) -> None:
        self._reservations[reservation.reservation_id] = reservation

    def get(self, reservation_id: str) -> Reservation | None:
        return self._reservations.get(reservation_id)

    def active_by_book(self, book_id: str) -> list[Reservation]:
        return [
            r for r in self._reservations.values()
            if r.book.book_id == book_id and r.is_active()
        ]

    def active_by_member(self, member_id: str) -> list[Reservation]:
        return [
            r for r in self._reservations.values()
            if r.member.member_id == member_id and r.is_active()
        ]

    def expired(self) -> list[Reservation]:
        return [r for r in self._reservations.values() if r.is_expired()]

    def all(self) -> list[Reservation]:
        return list(self._reservations.values())


class AuditLog:
    def __init__(self) -> None:
        self._events: list[AuditEvent] = []

    def record(self, event_type: EventType, actor_id: str, target_id: str, detail: dict) -> None:
        event = AuditEvent(
            event_id=str(uuid.uuid4()),
            event_type=event_type,
            actor_id=actor_id,
            target_id=target_id,
            detail=detail,
        )
        self._events.append(event)

    def events_by_type(self, event_type: EventType) -> list[AuditEvent]:
        return [e for e in self._events if e.event_type == event_type]

    def events_by_actor(self, actor_id: str) -> list[AuditEvent]:
        return [e for e in self._events if e.actor_id == actor_id]

    def recent(self, n: int = 50) -> list[AuditEvent]:
        return sorted(self._events, key=lambda e: e.occurred_at, reverse=True)[:n]

    def dump(self) -> list[dict]:
        return [e.to_dict() for e in self._events]


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------

class LibraryService:
    def __init__(
        self,
        books: BookRepository,
        members: MemberRepository,
        loans: LoanRepository,
        reservations: ReservationRepository,
        audit: AuditLog,
    ) -> None:
        self.books = books
        self.members = members
        self.loans = loans
        self.reservations = reservations
        self.audit = audit

    # --- Book management ---

    def add_book(self, book: Book, staff_id: str) -> None:
        self.books.add(book)
        self.audit.record(EventType.BOOK_ADDED, staff_id, book.book_id, book.to_dict())
        logger.info("Book added: %s (%s)", book.title, book.book_id)

    def dispose_book(self, book_id: str, staff_id: str, reason: str) -> None:
        book = self.books.get_or_raise(book_id)
        if book.status == BookStatus.BORROWED:
            raise ValueError(f"Cannot dispose borrowed book {book_id}")
        book.dispose()
        self.audit.record(EventType.BOOK_DISPOSED, staff_id, book_id, {"reason": reason})
        logger.info("Book disposed: %s (reason=%s)", book_id, reason)

    # --- Member management ---

    def register_member(self, member: Member, staff_id: str) -> None:
        self.members.add(member)
        self.audit.record(EventType.MEMBER_REGISTERED, staff_id, member.member_id, member.to_dict())
        logger.info("Member registered: %s (%s)", member.name, member.member_id)

    def upgrade_tier(self, member_id: str, new_tier: MembershipTier) -> None:
        member = self.members.get_or_raise(member_id)
        old_tier = member.tier
        member.tier = new_tier
        logger.info("Member %s upgraded: %s -> %s", member_id, old_tier.value, new_tier.value)

    # --- Loan operations ---

    def borrow(self, member_id: str, book_id: str) -> Loan:
        member = self.members.get_or_raise(member_id)
        book = self.books.get_or_raise(book_id)

        active_loans = self.loans.active_by_member(member_id)
        if not member.can_borrow(len(active_loans)):
            reason = (
                "has outstanding fees" if not member.outstanding_fee.is_zero()
                else f"reached loan limit ({member.max_loans()})"
            )
            raise ValueError(f"Member {member_id} cannot borrow: {reason}")

        if not book.is_available():
            raise ValueError(f"Book {book_id} is not available (status={book.status})")

        now = datetime.now()
        due = now + timedelta(days=member.loan_period_days())
        loan = Loan(
            loan_id=str(uuid.uuid4()),
            book=book,
            member=member,
            borrowed_at=now,
            due_at=due,
        )
        book.mark_borrowed()
        self.loans.add(loan)
        self.audit.record(EventType.LOAN, member_id, book_id, {"loan_id": loan.loan_id, "due_at": due.isoformat()})
        logger.info("Loan created: %s borrowed %s, due %s", member_id, book_id, due.date())
        return loan

    def return_book(self, loan_id: str) -> Money:
        loan = self.loans.get_or_raise(loan_id)
        if loan.status != LoanStatus.ACTIVE:
            raise ValueError(f"Loan {loan_id} is not active (status={loan.status})")

        fee = loan.return_book()
        loan.book.mark_returned()

        if not fee.is_zero():
            loan.member.add_fee(fee)
            logger.info("Overdue fee %s charged to %s", fee, loan.member.member_id)

        self.audit.record(
            EventType.RETURN,
            loan.member.member_id,
            loan.book.book_id,
            {"loan_id": loan_id, "fee": fee.amount},
        )
        logger.info("Book %s returned by %s", loan.book.book_id, loan.member.member_id)

        self._fulfill_reservation_if_any(loan.book.book_id)
        return fee

    def _fulfill_reservation_if_any(self, book_id: str) -> None:
        waiting = self.reservations.active_by_book(book_id)
        if not waiting:
            return
        earliest = min(waiting, key=lambda r: r.reserved_at)
        earliest.fulfill()
        earliest.book.mark_reserved()
        logger.info(
            "Reservation %s fulfilled for member %s on book %s",
            earliest.reservation_id,
            earliest.member.member_id,
            book_id,
        )

    # --- Reservation operations ---

    def reserve(self, member_id: str, book_id: str) -> Reservation:
        member = self.members.get_or_raise(member_id)
        book = self.books.get_or_raise(book_id)

        if not member.active:
            raise ValueError(f"Member {member_id} is not active")

        active_reservations = self.reservations.active_by_member(member_id)
        if len(active_reservations) >= MAX_RESERVATIONS:
            raise ValueError(f"Member {member_id} has reached the reservation limit ({MAX_RESERVATIONS})")

        if book.status not in (BookStatus.BORROWED, BookStatus.RESERVED):
            raise ValueError(f"Book {book_id} does not need a reservation (status={book.status})")

        reservation = Reservation(
            reservation_id=str(uuid.uuid4()),
            book=book,
            member=member,
        )
        self.reservations.add(reservation)
        self.audit.record(EventType.RESERVATION, member_id, book_id, {"reservation_id": reservation.reservation_id})
        logger.info("Reservation created: %s for book %s by member %s", reservation.reservation_id, book_id, member_id)
        return reservation

    def cancel_reservation(self, reservation_id: str, actor_id: str) -> None:
        reservation = self.reservations.get(reservation_id)
        if reservation is None:
            raise KeyError(f"Reservation not found: {reservation_id}")
        reservation.cancel()
        self.audit.record(
            EventType.RESERVATION_CANCELLED,
            actor_id,
            reservation.book.book_id,
            {"reservation_id": reservation_id},
        )

    # --- Fee operations ---

    def pay_fee(self, member_id: str, amount: Money, staff_id: str) -> Money:
        member = self.members.get_or_raise(member_id)
        remaining = member.pay_fee(amount)
        self.audit.record(EventType.FEE_PAID, staff_id, member_id, {"paid": amount.amount, "remaining": remaining.amount})
        logger.info("Fee paid: member=%s, paid=%s, remaining=%s", member_id, amount, remaining)
        return remaining

    # --- Maintenance ---

    def process_overdue(self) -> list[Loan]:
        overdue = self.loans.overdue()
        for loan in overdue:
            if loan.status == LoanStatus.ACTIVE:
                loan.status = LoanStatus.OVERDUE
        return overdue

    def expire_reservations(self) -> list[Reservation]:
        expired = self.reservations.expired()
        for r in expired:
            r.cancel()
        return expired

    # --- Queries ---

    def member_loan_summary(self, member_id: str) -> dict:
        member = self.members.get_or_raise(member_id)
        active = self.loans.active_by_member(member_id)
        history = self.loans.history_by_member(member_id)
        return {
            "member": member.to_dict(),
            "active_loans": len(active),
            "total_loans": len(history),
            "outstanding_fee": member.outstanding_fee.amount,
            "active_books": [l.book.title for l in active],
        }


# ---------------------------------------------------------------------------
# Search / recommendation engine
# ---------------------------------------------------------------------------

class SearchEngine:
    def __init__(self, books: BookRepository) -> None:
        self.books = books

    def full_text_search(self, query: str, limit: int = 20) -> list[Book]:
        results = self.books.search(query)
        return results[:limit]

    def by_genre(self, genre: Genre, available_only: bool = False) -> list[Book]:
        books = self.books.by_genre(genre)
        if available_only:
            books = [b for b in books if b.is_available()]
        return books

    def new_arrivals(self, days: int = 30) -> list[Book]:
        cutoff = datetime.now() - timedelta(days=days)
        books = [b for b in self.books.all() if b.added_at >= cutoff]
        return sorted(books, key=lambda b: b.added_at, reverse=True)

    def recommend_by_genre(self, member: Member, loans: LoanRepository, n: int = 5) -> list[Book]:
        history = loans.history_by_member(member.member_id)
        if not history:
            return self.new_arrivals(60)[:n]

        genre_counts: dict[Genre, int] = {}
        for loan in history:
            g = loan.book.genre
            genre_counts[g] = genre_counts.get(g, 0) + 1
        top_genre = max(genre_counts, key=lambda g: genre_counts[g])

        borrowed_ids = {l.book.book_id for l in history}
        candidates = [
            b for b in self.books.by_genre(top_genre)
            if b.is_available() and b.book_id not in borrowed_ids
        ]
        return candidates[:n]


# ---------------------------------------------------------------------------
# Report generator
# ---------------------------------------------------------------------------

class LibraryReporter:
    def __init__(self, service: LibraryService) -> None:
        self.service = service

    def collection_overview(self) -> str:
        counts = self.service.books.count_by_status()
        total = sum(counts.values())
        lines = [
            "=== Collection Overview ===",
            f"Total books: {total}",
            "",
        ]
        for status, count in counts.items():
            lines.append(f"  {status:20s}: {count:5d}")
        return "\n".join(lines)

    def overdue_report(self) -> str:
        overdue = self.service.loans.overdue()
        lines = [
            "=== Overdue Loans ===",
            f"Generated: {datetime.now().isoformat()}",
            f"Count: {len(overdue)}",
            "",
        ]
        for loan in sorted(overdue, key=lambda l: l.due_at):
            days = loan.days_overdue()
            fee = loan.calc_overdue_fee()
            lines.append(
                f"  {loan.loan_id[:8]}  "
                f"member={loan.member.name:20s}  "
                f"book={loan.book.title[:30]:30s}  "
                f"due={loan.due_at.date()}  "
                f"days={days:3d}  fee={fee}"
            )
        return "\n".join(lines)

    def fee_report(self) -> str:
        members = self.service.members.with_outstanding_fees()
        total = sum(m.outstanding_fee.amount for m in members)
        lines = [
            "=== Outstanding Fees ===",
            f"Members with fees: {len(members)}",
            f"Total outstanding: ¥{total:,}",
            "",
        ]
        for m in sorted(members, key=lambda m: m.outstanding_fee.amount, reverse=True):
            lines.append(f"  {m.member_id}  {m.name:20s}  {m.outstanding_fee}")
        return "\n".join(lines)

    def popular_books(self, top_n: int = 10) -> str:
        loan_counts: dict[str, int] = {}
        book_names: dict[str, str] = {}
        for loan in self.service.loans.all():
            bid = loan.book.book_id
            loan_counts[bid] = loan_counts.get(bid, 0) + 1
            book_names[bid] = loan.book.title
        ranked = sorted(loan_counts.items(), key=lambda x: x[1], reverse=True)[:top_n]
        lines = [f"=== Top {top_n} Most Borrowed Books ===", ""]
        for rank, (book_id, count) in enumerate(ranked, 1):
            lines.append(f"  {rank:2d}. {book_names[book_id][:40]:40s}  {count} loans")
        return "\n".join(lines)

    def member_activity(self, top_n: int = 10) -> str:
        loan_counts: dict[str, int] = {}
        member_names: dict[str, str] = {}
        for loan in self.service.loans.all():
            mid = loan.member.member_id
            loan_counts[mid] = loan_counts.get(mid, 0) + 1
            member_names[mid] = loan.member.name
        ranked = sorted(loan_counts.items(), key=lambda x: x[1], reverse=True)[:top_n]
        lines = [f"=== Top {top_n} Active Members ===", ""]
        for rank, (member_id, count) in enumerate(ranked, 1):
            lines.append(f"  {rank:2d}. {member_names[member_id]:20s}  {count} total loans")
        return "\n".join(lines)

    def genre_distribution(self) -> str:
        genre_counts: dict[str, int] = {}
        for book in self.service.books.all():
            g = book.genre.value
            genre_counts[g] = genre_counts.get(g, 0) + 1
        total = sum(genre_counts.values())
        lines = ["=== Genre Distribution ===", f"Total: {total}", ""]
        for genre, count in sorted(genre_counts.items(), key=lambda x: x[1], reverse=True):
            pct = count / total * 100 if total else 0
            bar = "#" * int(pct / 2)
            lines.append(f"  {genre:15s}: {count:5d} ({pct:5.1f}%)  {bar}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Demo data builder
# ---------------------------------------------------------------------------

def _make_author(author_id: str, name: str, birth_year: int | None = None) -> Author:
    return Author(author_id=author_id, name=name, birth_year=birth_year)


def _build_demo() -> tuple[LibraryService, SearchEngine]:
    books = BookRepository()
    members = MemberRepository()
    loans = LoanRepository()
    reservations = ReservationRepository()
    audit = AuditLog()
    service = LibraryService(books, members, loans, reservations, audit)
    search = SearchEngine(books)

    authors = [
        _make_author("A001", "夏目漱石", 1867),
        _make_author("A002", "太宰治", 1909),
        _make_author("A003", "村上春樹", 1949),
        _make_author("A004", "宮崎駿", 1941),
        _make_author("A005", "Donald Knuth", 1938),
    ]

    book_list = [
        Book("B001", ISBN("9784101010137"), "坊っちゃん", [authors[0]], Genre.FICTION, "新潮社", 1906, 200, tags=["classic", "humor"]),
        Book("B002", ISBN("9784101021041"), "走れメロス", [authors[1]], Genre.FICTION, "新潮社", 1940, 150, tags=["classic"]),
        Book("B003", ISBN("9784062748681"), "ノルウェイの森", [authors[2]], Genre.FICTION, "講談社", 1987, 296, tags=["romance"]),
        Book("B004", ISBN("9784087711875"), "風の谷のナウシカ", [authors[3]], Genre.MANGA, "徳間書店", 1994, 1060, tags=["manga", "fantasy"]),
        Book("B005", ISBN("9780201896831"), "The Art of Computer Programming Vol.1", [authors[4]], Genre.SCIENCE, "Addison-Wesley", 1968, 672, language="en", tags=["algorithms", "cs"]),
        Book("B006", ISBN("9784101010144"), "三四郎", [authors[0]], Genre.FICTION, "新潮社", 1908, 350, tags=["classic"]),
        Book("B007", ISBN("9784101021058"), "人間失格", [authors[1]], Genre.FICTION, "新潮社", 1948, 170, tags=["classic"]),
        Book("B008", ISBN("9784062748698"), "海辺のカフカ", [authors[2]], Genre.FICTION, "講談社", 2002, 592, tags=["surreal"]),
    ]

    staff_id = "STAFF001"
    for book in book_list:
        service.add_book(book, staff_id)

    member_list = [
        Member("M001", "田中太郎", "tanaka@example.com", MembershipTier.STANDARD),
        Member("M002", "山田花子", "yamada@example.com", MembershipTier.PREMIUM),
        Member("M003", "鈴木一郎", "suzuki@example.com", MembershipTier.BASIC),
        Member("M004", "佐藤美咲", "sato@example.com", MembershipTier.STANDARD),
    ]
    for member in member_list:
        service.register_member(member, staff_id)

    return service, search


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import sys
    argv = argv or sys.argv[1:]
    logging.basicConfig(level=logging.WARNING)
    service, search = _build_demo()
    reporter = LibraryReporter(service)

    cmd = argv[0] if argv else "help"

    if cmd == "overview":
        print(reporter.collection_overview())
    elif cmd == "overdue":
        print(reporter.overdue_report())
    elif cmd == "fees":
        print(reporter.fee_report())
    elif cmd == "popular":
        print(reporter.popular_books())
    elif cmd == "genres":
        print(reporter.genre_distribution())
    elif cmd == "activity":
        print(reporter.member_activity())
    elif cmd == "search":
        query = argv[1] if len(argv) > 1 else ""
        results = search.full_text_search(query)
        for b in results:
            print(f"  {b.book_id}  {b.title}  [{b.status.value}]")
    elif cmd == "borrow":
        if len(argv) < 3:
            print("Usage: borrow <member_id> <book_id>")
            return 1
        try:
            loan = service.borrow(argv[1], argv[2])
            print(f"Loan created: {loan.loan_id}, due {loan.due_at.date()}")
        except (KeyError, ValueError) as e:
            print(f"Error: {e}")
            return 1
    else:
        print("Commands: overview | overdue | fees | popular | genres | activity | search <query> | borrow <member_id> <book_id>")
        return 1

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

class BookValidator:
    @staticmethod
    def validate_isbn_format(raw: str) -> list[str]:
        cleaned = raw.replace("-", "").replace(" ", "")
        if not ISBN_PATTERN.match(cleaned):
            return [f"Invalid ISBN format: {raw}"]
        return []

    @staticmethod
    def validate_book(book: Book) -> list[str]:
        errors: list[str] = []
        if not book.title.strip():
            errors.append("Title must not be empty")
        if len(book.title) > 300:
            errors.append(f"Title too long: {len(book.title)} chars")
        if not book.authors:
            errors.append("Book must have at least one author")
        if book.pages <= 0:
            errors.append(f"Pages must be positive: {book.pages}")
        if book.published_year < 1400 or book.published_year > 2100:
            errors.append(f"Published year out of range: {book.published_year}")
        return errors


class MemberValidator:
    EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")

    @staticmethod
    def validate_email(email: str) -> list[str]:
        if not MemberValidator.EMAIL_PATTERN.match(email):
            return [f"Invalid email: {email}"]
        return []

    @staticmethod
    def validate_member(member: Member) -> list[str]:
        errors: list[str] = []
        if not member.name.strip():
            errors.append("Name must not be empty")
        errors.extend(MemberValidator.validate_email(member.email))
        if not member.member_id:
            errors.append("member_id must not be empty")
        return errors


# ---------------------------------------------------------------------------
# Statistics
# ---------------------------------------------------------------------------

def loan_statistics(loans: list[Loan]) -> dict:
    if not loans:
        return {"total": 0}
    total = len(loans)
    returned = [l for l in loans if l.status == LoanStatus.RETURNED]
    overdue_count = sum(1 for l in loans if l.is_overdue())
    total_fee = sum(l.overdue_fee.amount for l in returned if l.overdue_fee.amount > 0)
    durations = [(l.returned_at - l.borrowed_at).days for l in returned if l.returned_at]
    avg_duration = sum(durations) / len(durations) if durations else 0.0
    return {
        "total": total,
        "returned": len(returned),
        "overdue": overdue_count,
        "total_overdue_fee_collected": total_fee,
        "avg_loan_days": round(avg_duration, 1),
    }


def collection_statistics(books: list[Book]) -> dict:
    by_genre: dict[str, int] = {}
    by_lang: dict[str, int] = {}
    for book in books:
        by_genre[book.genre.value] = by_genre.get(book.genre.value, 0) + 1
        by_lang[book.language] = by_lang.get(book.language, 0) + 1
    return {
        "total": len(books),
        "by_genre": by_genre,
        "by_language": by_lang,
        "available": sum(1 for b in books if b.is_available()),
        "borrowed": sum(1 for b in books if b.status == BookStatus.BORROWED),
        "lost": sum(1 for b in books if b.status == BookStatus.LOST),
    }


def member_statistics(members: list[Member], loans: list[Loan]) -> dict:
    loan_counts: dict[str, int] = {}
    for loan in loans:
        mid = loan.member.member_id
        loan_counts[mid] = loan_counts.get(mid, 0) + 1
    active = [m for m in members if m.active]
    tier_dist: dict[str, int] = {}
    for m in members:
        tier_dist[m.tier.value] = tier_dist.get(m.tier.value, 0) + 1
    top_borrower = max(loan_counts, key=lambda k: loan_counts[k]) if loan_counts else None
    return {
        "total": len(members),
        "active": len(active),
        "tier_distribution": tier_dist,
        "top_borrower_id": top_borrower,
        "top_borrower_loans": loan_counts.get(top_borrower, 0) if top_borrower else 0,
    }


# ---------------------------------------------------------------------------
# Event / notification system
# ---------------------------------------------------------------------------

class LibraryEvent:
    def __init__(self, event_type: str, payload: dict) -> None:
        self.event_id = str(uuid.uuid4())
        self.event_type = event_type
        self.payload = payload
        self.occurred_at = datetime.now()

    def __str__(self) -> str:
        return f"[{self.event_type}] {self.occurred_at.isoformat()}"


class LibraryEventBus:
    def __init__(self) -> None:
        self._handlers: dict[str, list] = {}
        self._log: list[LibraryEvent] = []

    def on(self, event_type: str, handler) -> None:
        self._handlers.setdefault(event_type, []).append(handler)

    def emit(self, event: LibraryEvent) -> None:
        self._log.append(event)
        for handler in self._handlers.get(event.event_type, []):
            try:
                handler(event)
            except Exception as exc:
                logger.error("Event handler failed for %s: %s", event.event_type, exc)

    def recent(self, n: int = 20) -> list[LibraryEvent]:
        return sorted(self._log, key=lambda e: e.occurred_at, reverse=True)[:n]


class LibraryNotifier:
    def __init__(self, bus: LibraryEventBus) -> None:
        self._bus = bus
        bus.on("loan_created", self._on_loan)
        bus.on("loan_returned", self._on_return)
        bus.on("overdue_detected", self._on_overdue)
        bus.on("reservation_fulfilled", self._on_reservation_fulfilled)
        self._notifications: list[dict] = []

    def _on_loan(self, event: LibraryEvent) -> None:
        self._notifications.append({
            "type": "loan_reminder",
            "member_id": event.payload.get("member_id"),
            "due_at": event.payload.get("due_at"),
        })

    def _on_return(self, event: LibraryEvent) -> None:
        fee = event.payload.get("fee", 0)
        if fee > 0:
            self._notifications.append({
                "type": "fee_notice",
                "member_id": event.payload.get("member_id"),
                "fee": fee,
            })

    def _on_overdue(self, event: LibraryEvent) -> None:
        self._notifications.append({
            "type": "overdue_warning",
            "member_id": event.payload.get("member_id"),
            "days_overdue": event.payload.get("days_overdue"),
        })

    def _on_reservation_fulfilled(self, event: LibraryEvent) -> None:
        self._notifications.append({
            "type": "reservation_ready",
            "member_id": event.payload.get("member_id"),
            "book_title": event.payload.get("book_title"),
        })

    def all(self) -> list[dict]:
        return list(self._notifications)

    def for_member(self, member_id: str) -> list[dict]:
        return [n for n in self._notifications if n.get("member_id") == member_id]


# ---------------------------------------------------------------------------
# Catalog / metadata enrichment
# ---------------------------------------------------------------------------

@dataclass
class BookMetadata:
    book_id: str
    dewey_decimal: str = ""
    ndc_code: str = ""
    keywords: list[str] = field(default_factory=list)
    related_book_ids: list[str] = field(default_factory=list)
    cover_image_url: str = ""
    table_of_contents: list[str] = field(default_factory=list)
    awards: list[str] = field(default_factory=list)

    def has_award(self) -> bool:
        return bool(self.awards)


class CatalogService:
    def __init__(self, books: BookRepository) -> None:
        self.books = books
        self._metadata: dict[str, BookMetadata] = {}

    def set_metadata(self, metadata: BookMetadata) -> None:
        self._metadata[metadata.book_id] = metadata

    def get_metadata(self, book_id: str) -> BookMetadata | None:
        return self._metadata.get(book_id)

    def books_by_ndc(self, ndc_prefix: str) -> list[Book]:
        result = []
        for book in self.books.all():
            meta = self._metadata.get(book.book_id)
            if meta and meta.ndc_code.startswith(ndc_prefix):
                result.append(book)
        return result

    def award_winners(self) -> list[Book]:
        result = []
        for book in self.books.all():
            meta = self._metadata.get(book.book_id)
            if meta and meta.has_award():
                result.append(book)
        return result

    def related_books(self, book_id: str) -> list[Book]:
        meta = self._metadata.get(book_id)
        if not meta:
            return []
        return [b for bid in meta.related_book_ids if (b := self.books.get(bid)) is not None]


# ---------------------------------------------------------------------------
# Interlibrary loan
# ---------------------------------------------------------------------------

class InterlibraryLoanStatus(Enum):
    REQUESTED = "requested"
    APPROVED = "approved"
    IN_TRANSIT = "in_transit"
    RECEIVED = "received"
    RETURNED = "returned"
    REJECTED = "rejected"


@dataclass
class InterlibraryLoan:
    ill_id: str
    requesting_member: Member
    isbn: str
    title: str
    source_library: str
    status: InterlibraryLoanStatus = InterlibraryLoanStatus.REQUESTED
    requested_at: datetime = field(default_factory=datetime.now)
    received_at: datetime | None = None
    due_at: datetime | None = None
    returned_at: datetime | None = None
    notes: str = ""

    def approve(self, source: str) -> None:
        if self.status != InterlibraryLoanStatus.REQUESTED:
            raise ValueError(f"ILL {self.ill_id} is not in REQUESTED state")
        self.source_library = source
        self.status = InterlibraryLoanStatus.APPROVED

    def receive(self, loan_days: int = 14) -> None:
        if self.status != InterlibraryLoanStatus.IN_TRANSIT:
            raise ValueError(f"ILL {self.ill_id} is not in transit")
        self.received_at = datetime.now()
        self.due_at = datetime.now() + timedelta(days=loan_days)
        self.status = InterlibraryLoanStatus.RECEIVED

    def return_book(self) -> None:
        self.returned_at = datetime.now()
        self.status = InterlibraryLoanStatus.RETURNED

    def reject(self, reason: str = "") -> None:
        self.status = InterlibraryLoanStatus.REJECTED
        if reason:
            self.notes += f"\nRejected: {reason}"

    def to_dict(self) -> dict:
        return {
            "ill_id": self.ill_id,
            "member_id": self.requesting_member.member_id,
            "isbn": self.isbn,
            "title": self.title,
            "source_library": self.source_library,
            "status": self.status.value,
        }


class InterlibraryLoanRepository:
    def __init__(self) -> None:
        self._loans: dict[str, InterlibraryLoan] = {}

    def add(self, ill: InterlibraryLoan) -> None:
        self._loans[ill.ill_id] = ill

    def get(self, ill_id: str) -> InterlibraryLoan | None:
        return self._loans.get(ill_id)

    def by_member(self, member_id: str) -> list[InterlibraryLoan]:
        return [ill for ill in self._loans.values() if ill.requesting_member.member_id == member_id]

    def by_status(self, status: InterlibraryLoanStatus) -> list[InterlibraryLoan]:
        return [ill for ill in self._loans.values() if ill.status == status]

    def all(self) -> list[InterlibraryLoan]:
        return list(self._loans.values())


class InterlibraryLoanService:
    def __init__(self, ill_repo: InterlibraryLoanRepository, members: MemberRepository) -> None:
        self.ill_repo = ill_repo
        self.members = members

    def request(self, member_id: str, isbn: str, title: str) -> InterlibraryLoan:
        member = self.members.get_or_raise(member_id)
        ill = InterlibraryLoan(
            ill_id=str(uuid.uuid4()),
            requesting_member=member,
            isbn=isbn,
            title=title,
            source_library="",
        )
        self.ill_repo.add(ill)
        logger.info("ILL requested: %s by member %s", ill.ill_id, member_id)
        return ill

    def approve(self, ill_id: str, source_library: str) -> None:
        ill = self.ill_repo.get(ill_id)
        if ill is None:
            raise KeyError(f"ILL not found: {ill_id}")
        ill.approve(source_library)
        ill.status = InterlibraryLoanStatus.IN_TRANSIT
        logger.info("ILL %s approved from %s", ill_id, source_library)

    def receive(self, ill_id: str, loan_days: int = 14) -> None:
        ill = self.ill_repo.get(ill_id)
        if ill is None:
            raise KeyError(f"ILL not found: {ill_id}")
        ill.receive(loan_days)
        logger.info("ILL %s received, due %s", ill_id, ill.due_at)

    def return_book(self, ill_id: str) -> None:
        ill = self.ill_repo.get(ill_id)
        if ill is None:
            raise KeyError(f"ILL not found: {ill_id}")
        ill.return_book()
        logger.info("ILL %s returned", ill_id)

    def status_report(self) -> str:
        lines = ["=== Interlibrary Loan Status ===", ""]
        for status in InterlibraryLoanStatus:
            items = self.ill_repo.by_status(status)
            if not items:
                continue
            lines.append(f"[{status.value.upper()}] {len(items)} items")
            for ill in items:
                lines.append(f"  {ill.ill_id[:8]}  {ill.title[:40]:40s}  member={ill.requesting_member.name}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Reading list / wishlist
# ---------------------------------------------------------------------------

@dataclass
class ReadingList:
    list_id: str
    member: Member
    name: str
    entries: list[str] = field(default_factory=list)  # book_ids
    created_at: datetime = field(default_factory=datetime.now)
    public: bool = False

    def add(self, book_id: str) -> None:
        if book_id not in self.entries:
            self.entries.append(book_id)

    def remove(self, book_id: str) -> None:
        if book_id in self.entries:
            self.entries.remove(book_id)

    def contains(self, book_id: str) -> bool:
        return book_id in self.entries

    def to_dict(self) -> dict:
        return {
            "list_id": self.list_id,
            "member_id": self.member.member_id,
            "name": self.name,
            "entries": self.entries,
            "public": self.public,
        }


class ReadingListRepository:
    def __init__(self) -> None:
        self._lists: dict[str, ReadingList] = {}

    def add(self, reading_list: ReadingList) -> None:
        self._lists[reading_list.list_id] = reading_list

    def get(self, list_id: str) -> ReadingList | None:
        return self._lists.get(list_id)

    def by_member(self, member_id: str) -> list[ReadingList]:
        return [rl for rl in self._lists.values() if rl.member.member_id == member_id]

    def public_lists(self) -> list[ReadingList]:
        return [rl for rl in self._lists.values() if rl.public]

    def all(self) -> list[ReadingList]:
        return list(self._lists.values())


# ---------------------------------------------------------------------------
# Book review system
# ---------------------------------------------------------------------------

@dataclass
class BookReview:
    review_id: str
    book: Book
    member: Member
    rating: int  # 1–5
    title: str
    body: str
    created_at: datetime = field(default_factory=datetime.now)
    helpful_count: int = 0
    flagged: bool = False

    def __post_init__(self) -> None:
        if not 1 <= self.rating <= 5:
            raise ValueError(f"Rating must be 1–5: {self.rating}")
        if len(self.body) < 10:
            raise ValueError("Review body too short (min 10 chars)")

    def mark_helpful(self) -> None:
        self.helpful_count += 1

    def flag(self) -> None:
        self.flagged = True

    def to_dict(self) -> dict:
        return {
            "review_id": self.review_id,
            "book_id": self.book.book_id,
            "member_id": self.member.member_id,
            "rating": self.rating,
            "title": self.title,
            "helpful_count": self.helpful_count,
        }


class ReviewRepository:
    def __init__(self) -> None:
        self._reviews: dict[str, BookReview] = {}

    def add(self, review: BookReview) -> None:
        self._reviews[review.review_id] = review

    def by_book(self, book_id: str) -> list[BookReview]:
        return [r for r in self._reviews.values() if r.book.book_id == book_id and not r.flagged]

    def by_member(self, member_id: str) -> list[BookReview]:
        return [r for r in self._reviews.values() if r.member.member_id == member_id]

    def average_rating(self, book_id: str) -> float:
        reviews = self.by_book(book_id)
        if not reviews:
            return 0.0
        return sum(r.rating for r in reviews) / len(reviews)

    def top_rated(self, n: int = 10) -> list[tuple[str, float]]:
        book_ids = {r.book.book_id for r in self._reviews.values()}
        ratings = [(bid, self.average_rating(bid)) for bid in book_ids]
        return sorted(ratings, key=lambda x: x[1], reverse=True)[:n]

    def all(self) -> list[BookReview]:
        return list(self._reviews.values())


class ReviewService:
    def __init__(self, reviews: ReviewRepository, books: BookRepository, members: MemberRepository) -> None:
        self.reviews = reviews
        self.books = books
        self.members = members

    def submit(self, member_id: str, book_id: str, rating: int, title: str, body: str) -> BookReview:
        member = self.members.get_or_raise(member_id)
        book = self.books.get_or_raise(book_id)
        review = BookReview(
            review_id=str(uuid.uuid4()),
            book=book,
            member=member,
            rating=rating,
            title=title,
            body=body,
        )
        self.reviews.add(review)
        logger.info("Review submitted: %s for book %s by member %s", review.review_id, book_id, member_id)
        return review

    def book_rating_summary(self, book_id: str) -> dict:
        book = self.books.get_or_raise(book_id)
        all_reviews = self.reviews.by_book(book_id)
        dist: dict[int, int] = {i: 0 for i in range(1, 6)}
        for r in all_reviews:
            dist[r.rating] += 1
        return {
            "book_id": book_id,
            "title": book.title,
            "review_count": len(all_reviews),
            "avg_rating": self.reviews.average_rating(book_id),
            "distribution": dist,
        }


# ---------------------------------------------------------------------------
# Export utilities
# ---------------------------------------------------------------------------

class LibraryDataExporter:
    @staticmethod
    def catalog_to_json(books: BookRepository, path: str) -> int:
        data = [b.to_dict() for b in books.all()]
        with open(path, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        return len(data)

    @staticmethod
    def loan_history_to_csv(loans: LoanRepository, path: str) -> int:
        rows = [l.to_dict() for l in loans.all()]
        if not rows:
            return 0
        with open(path, "w", newline="", encoding="utf-8") as f:
            writer = csv.DictWriter(f, fieldnames=rows[0].keys())
            writer.writeheader()
            writer.writerows(rows)
        return len(rows)

    @staticmethod
    def audit_to_jsonl(audit: AuditLog, path: str) -> int:
        events = audit.dump()
        with open(path, "w", encoding="utf-8") as f:
            for event in events:
                f.write(json.dumps(event, ensure_ascii=False) + "\n")
        return len(events)


# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------

def library_health_check(service: LibraryService, search: SearchEngine) -> dict:
    books = service.books.all()
    members = service.members.all()
    loans = service.loans.all()
    overdue = service.loans.overdue()
    reservations = service.reservations.all()
    active_res = [r for r in reservations if r.is_active()]
    return {
        "status": "ok",
        "books_total": len(books),
        "members_total": len(members),
        "loans_total": len(loans),
        "loans_overdue": len(overdue),
        "active_reservations": len(active_res),
        "members_with_fees": len(service.members.with_outstanding_fees()),
        "checked_at": datetime.now().isoformat(),
    }


# ---------------------------------------------------------------------------
# Pagination
# ---------------------------------------------------------------------------

def paginate(items: list, page: int, page_size: int) -> dict:
    total = len(items)
    start = (page - 1) * page_size
    end = start + page_size
    return {
        "page": page,
        "page_size": page_size,
        "total": total,
        "total_pages": (total + page_size - 1) // page_size,
        "items": items[start:end],
    }


# ---------------------------------------------------------------------------
# Scheduled tasks (maintenance)
# ---------------------------------------------------------------------------

class MaintenanceScheduler:
    def __init__(self, service: LibraryService) -> None:
        self.service = service
        self._tasks: list[dict] = []

    def run_daily(self) -> dict:
        overdue = self.service.process_overdue()
        expired_res = self.service.expire_reservations()

        result = {
            "overdue_processed": len(overdue),
            "expired_reservations": len(expired_res),
            "run_at": datetime.now().isoformat(),
        }
        self._tasks.append(result)
        logger.info(
            "Daily maintenance: %d overdue, %d reservations expired",
            len(overdue), len(expired_res),
        )
        return result

    def run_weekly(self) -> dict:
        members_with_fees = self.service.members.with_outstanding_fees()
        long_overdue = [
            l for l in self.service.loans.overdue()
            if l.days_overdue() >= 30
        ]
        result = {
            "members_with_fees": len(members_with_fees),
            "long_overdue_loans": len(long_overdue),
            "run_at": datetime.now().isoformat(),
        }
        self._tasks.append(result)
        return result

    def history(self) -> list[dict]:
        return list(self._tasks)


# ---------------------------------------------------------------------------
# Access log
# ---------------------------------------------------------------------------

@dataclass
class AccessLogEntry:
    entry_id: str
    member_id: str | None
    action: str
    resource: str
    success: bool
    timestamp: datetime = field(default_factory=datetime.now)
    ip_address: str = ""
    user_agent: str = ""

    def to_dict(self) -> dict:
        return {
            "entry_id": self.entry_id,
            "member_id": self.member_id,
            "action": self.action,
            "resource": self.resource,
            "success": self.success,
            "timestamp": self.timestamp.isoformat(),
        }


class AccessLog:
    def __init__(self) -> None:
        self._entries: list[AccessLogEntry] = []

    def record(self, member_id: str | None, action: str, resource: str, success: bool) -> None:
        entry = AccessLogEntry(
            entry_id=str(uuid.uuid4()),
            member_id=member_id,
            action=action,
            resource=resource,
            success=success,
        )
        self._entries.append(entry)

    def by_member(self, member_id: str) -> list[AccessLogEntry]:
        return [e for e in self._entries if e.member_id == member_id]

    def failed(self) -> list[AccessLogEntry]:
        return [e for e in self._entries if not e.success]

    def recent(self, n: int = 100) -> list[AccessLogEntry]:
        return sorted(self._entries, key=lambda e: e.timestamp, reverse=True)[:n]

    def dump(self) -> list[dict]:
        return [e.to_dict() for e in self._entries]


# ---------------------------------------------------------------------------
# Tag management
# ---------------------------------------------------------------------------

class TagManager:
    def __init__(self, books: BookRepository) -> None:
        self.books = books

    def all_tags(self) -> list[str]:
        tags: set[str] = set()
        for book in self.books.all():
            tags.update(book.tags)
        return sorted(tags)

    def tag_frequency(self) -> dict[str, int]:
        freq: dict[str, int] = {}
        for book in self.books.all():
            for tag in book.tags:
                freq[tag] = freq.get(tag, 0) + 1
        return dict(sorted(freq.items(), key=lambda x: x[1], reverse=True))

    def books_by_tag(self, tag: str) -> list[Book]:
        return [b for b in self.books.all() if tag.lower() in [t.lower() for t in b.tags]]

    def add_tag(self, book_id: str, tag: str) -> None:
        book = self.books.get_or_raise(book_id)
        if tag not in book.tags:
            book.tags.append(tag)

    def remove_tag(self, book_id: str, tag: str) -> None:
        book = self.books.get_or_raise(book_id)
        if tag in book.tags:
            book.tags.remove(tag)

    def rename_tag(self, old_tag: str, new_tag: str) -> int:
        count = 0
        for book in self.books.all():
            if old_tag in book.tags:
                book.tags.remove(old_tag)
                if new_tag not in book.tags:
                    book.tags.append(new_tag)
                count += 1
        return count


# ---------------------------------------------------------------------------
# Fine management
# ---------------------------------------------------------------------------

class FinePolicy:
    def __init__(
        self,
        per_day: int = OVERDUE_FEE_PER_DAY,
        max_fine: int = 3000,
        grace_days: int = 0,
    ) -> None:
        self.per_day = per_day
        self.max_fine = max_fine
        self.grace_days = grace_days

    def calculate(self, days_overdue: int) -> Money:
        if days_overdue <= self.grace_days:
            return ZERO_MONEY
        billable = days_overdue - self.grace_days
        raw = billable * self.per_day
        return Money(min(raw, self.max_fine))


class FineService:
    def __init__(
        self,
        loans: LoanRepository,
        members: MemberRepository,
        policy: FinePolicy | None = None,
    ) -> None:
        self.loans = loans
        self.members = members
        self.policy = policy or FinePolicy()

    def recalculate_all(self) -> dict:
        updated = 0
        for loan in self.loans.overdue():
            new_fee = self.policy.calculate(loan.days_overdue())
            if new_fee.amount != loan.overdue_fee.amount:
                loan.overdue_fee = new_fee
                updated += 1
        return {"recalculated": updated, "run_at": datetime.now().isoformat()}

    def waive_fee(self, loan_id: str, reason: str) -> None:
        loan = self.loans.get_or_raise(loan_id)
        old_fee = loan.overdue_fee
        loan.overdue_fee = ZERO_MONEY
        if not loan.member.outstanding_fee.is_zero():
            try:
                loan.member.pay_fee(old_fee)
            except ValueError:
                pass
        logger.info("Fee waived for loan %s (reason: %s)", loan_id, reason)

    def summary(self) -> dict:
        all_loans = self.loans.all()
        total_outstanding = sum(
            l.overdue_fee.amount
            for l in all_loans
            if l.status in (LoanStatus.ACTIVE, LoanStatus.OVERDUE)
            and l.overdue_fee.amount > 0
        )
        return {
            "total_outstanding_fines": total_outstanding,
            "loans_with_fines": sum(1 for l in all_loans if l.overdue_fee.amount > 0),
        }


# ---------------------------------------------------------------------------
# Summary builder (extended)
# ---------------------------------------------------------------------------

def full_library_summary(service: LibraryService, reporter: LibraryReporter) -> str:
    parts = [
        "=" * 60,
        "LIBRARY FULL SUMMARY",
        "=" * 60,
        reporter.collection_overview(),
        "",
        reporter.overdue_report(),
        "",
        reporter.fee_report(),
        "",
        reporter.popular_books(),
        "",
        reporter.member_activity(),
        "",
        reporter.genre_distribution(),
        "=" * 60,
        f"Generated: {datetime.now().isoformat()}",
    ]
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Extended search and filtering
# ---------------------------------------------------------------------------

class AdvancedSearch:
    def __init__(self, books: BookRepository, loans: LoanRepository) -> None:
        self.books = books
        self.loans = loans

    def filter_books(
        self,
        genre: Genre | None = None,
        language: str | None = None,
        available_only: bool = False,
        published_after: int | None = None,
        published_before: int | None = None,
        min_pages: int | None = None,
        max_pages: int | None = None,
        tags: list[str] | None = None,
    ) -> list[Book]:
        results = self.books.all()
        if genre:
            results = [b for b in results if b.genre == genre]
        if language:
            results = [b for b in results if b.language == language]
        if available_only:
            results = [b for b in results if b.is_available()]
        if published_after:
            results = [b for b in results if b.published_year >= published_after]
        if published_before:
            results = [b for b in results if b.published_year <= published_before]
        if min_pages:
            results = [b for b in results if b.pages >= min_pages]
        if max_pages:
            results = [b for b in results if b.pages <= max_pages]
        if tags:
            results = [b for b in results if any(t in b.tags for t in tags)]
        return results

    def members_who_borrowed(self, book_id: str) -> list[Member]:
        seen: set[str] = set()
        members: list[Member] = []
        for loan in self.loans.all():
            if loan.book.book_id == book_id and loan.member.member_id not in seen:
                seen.add(loan.member.member_id)
                members.append(loan.member)
        return members

    def books_borrowed_together(self, book_id: str, limit: int = 5) -> list[Book]:
        members = {l.member.member_id for l in self.loans.all() if l.book.book_id == book_id}
        co_counts: dict[str, int] = {}
        for loan in self.loans.all():
            if loan.member.member_id in members and loan.book.book_id != book_id:
                bid = loan.book.book_id
                co_counts[bid] = co_counts.get(bid, 0) + 1
        top = sorted(co_counts.items(), key=lambda x: x[1], reverse=True)[:limit]
        return [b for bid, _ in top if (b := self.books.get(bid)) is not None]


# ---------------------------------------------------------------------------
# Batch operations
# ---------------------------------------------------------------------------

class BatchProcessor:
    def __init__(self, service: LibraryService) -> None:
        self.service = service

    def bulk_check_in(self, loan_ids: list[str]) -> dict:
        success = []
        errors = []
        for lid in loan_ids:
            try:
                fee = self.service.return_book(lid)
                success.append({"loan_id": lid, "fee": fee.amount})
            except (KeyError, ValueError) as e:
                errors.append({"loan_id": lid, "error": str(e)})
        return {"success": success, "errors": errors}

    def bulk_cancel_reservations(self, reservation_ids: list[str], actor_id: str) -> dict:
        success = []
        errors = []
        for rid in reservation_ids:
            try:
                self.service.cancel_reservation(rid, actor_id)
                success.append(rid)
            except (KeyError, ValueError) as e:
                errors.append({"reservation_id": rid, "error": str(e)})
        return {"cancelled": success, "errors": errors}

    def bulk_upgrade_members(self, member_ids: list[str], new_tier: MembershipTier) -> int:
        count = 0
        for mid in member_ids:
            member = self.service.members.get(mid)
            if member and member.active:
                member.tier = new_tier
                count += 1
        return count

    def send_overdue_notices(self) -> list[dict]:
        overdue_loans = self.service.loans.overdue()
        notices = []
        for loan in overdue_loans:
            notice = {
                "member_id": loan.member.member_id,
                "member_name": loan.member.name,
                "email": loan.member.email,
                "loan_id": loan.loan_id,
                "book_title": loan.book.title,
                "days_overdue": loan.days_overdue(),
                "fee": loan.calc_overdue_fee().amount,
            }
            notices.append(notice)
        logger.info("Overdue notices prepared: %d", len(notices))
        return notices


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

@dataclass
class LibraryConfig:
    name: str
    address: str
    phone: str
    email: str
    website: str = ""
    loan_days_basic: int = LOAN_DAYS[MembershipTier.BASIC]
    loan_days_standard: int = LOAN_DAYS[MembershipTier.STANDARD]
    loan_days_premium: int = LOAN_DAYS[MembershipTier.PREMIUM]
    max_loans_basic: int = MAX_LOANS[MembershipTier.BASIC]
    max_loans_standard: int = MAX_LOANS[MembershipTier.STANDARD]
    max_loans_premium: int = MAX_LOANS[MembershipTier.PREMIUM]
    overdue_fee_per_day: int = OVERDUE_FEE_PER_DAY
    max_reservations: int = MAX_RESERVATIONS
    reservation_expiry_days: int = 7

    def to_dict(self) -> dict:
        return {
            "name": self.name,
            "address": self.address,
            "phone": self.phone,
            "email": self.email,
            "loan_days": {
                "basic": self.loan_days_basic,
                "standard": self.loan_days_standard,
                "premium": self.loan_days_premium,
            },
            "overdue_fee_per_day": self.overdue_fee_per_day,
        }

    @classmethod
    def default(cls) -> LibraryConfig:
        return cls(
            name="市立中央図書館",
            address="東京都千代田区1-1",
            phone="03-0000-0000",
            email="library@example.com",
        )


# ---------------------------------------------------------------------------
# Notification templates
# ---------------------------------------------------------------------------

class NotificationTemplate:
    LOAN_REMINDER = """
件名: 貸出期限のお知らせ
{member_name} 様

以下の資料の返却期限が近づいております。

書名: {book_title}
返却期限: {due_date}

期限を超過した場合、1日につき{fee_per_day}円の延滞料が発生します。
"""

    OVERDUE_NOTICE = """
件名: 延滞のお知らせ
{member_name} 様

以下の資料が延滞しております。

書名: {book_title}
返却期限: {due_date}
延滞日数: {days_overdue}日
現在の延滞料: {current_fee}円

至急ご返却ください。
"""

    RESERVATION_READY = """
件名: ご予約資料の準備が完了しました
{member_name} 様

ご予約いただいていた以下の資料が準備できました。

書名: {book_title}
受取期限: {expiry_date}

期限までにご来館ください。
"""

    FEE_PAYMENT_RECEIPT = """
件名: 延滞料領収書
{member_name} 様

以下の延滞料のお支払いを受け付けました。

支払金額: {amount}円
支払日時: {paid_at}
残高: {remaining}円
"""

    @staticmethod
    def render(template: str, **kwargs: str) -> str:
        result = template
        for key, value in kwargs.items():
            result = result.replace("{" + key + "}", value)
        return result.strip()


# ---------------------------------------------------------------------------
# Report templates (text-based)
# ---------------------------------------------------------------------------

class TextReport:
    @staticmethod
    def header(title: str, width: int = 60) -> str:
        border = "=" * width
        return f"{border}\n{title.center(width)}\n{border}"

    @staticmethod
    def section(title: str, width: int = 60) -> str:
        return f"--- {title} " + "-" * (width - len(title) - 5)

    @staticmethod
    def table(headers: list[str], rows: list[list[str]], col_widths: list[int]) -> str:
        def fmt_row(cells: list[str]) -> str:
            return "  ".join(c[:w].ljust(w) for c, w in zip(cells, col_widths))

        header_line = fmt_row(headers)
        separator = "  ".join("-" * w for w in col_widths)
        data_lines = [fmt_row(row) for row in rows]
        return "\n".join([header_line, separator] + data_lines)

    @staticmethod
    def kv_block(items: dict[str, str], key_width: int = 25) -> str:
        return "\n".join(f"  {k:<{key_width}}: {v}" for k, v in items.items())


# ---------------------------------------------------------------------------
# Archival system
# ---------------------------------------------------------------------------

class ArchiveLevel(Enum):
    ACTIVE = "active"
    NEAR_LINE = "near_line"
    OFF_LINE = "off_line"


@dataclass
class ArchiveEntry:
    entry_id: str
    resource_type: str
    resource_id: str
    archive_level: ArchiveLevel
    archived_at: datetime = field(default_factory=datetime.now)
    archived_by: str = ""
    reason: str = ""
    retrievable: bool = True

    def to_dict(self) -> dict:
        return {
            "entry_id": self.entry_id,
            "resource_type": self.resource_type,
            "resource_id": self.resource_id,
            "level": self.archive_level.value,
            "archived_at": self.archived_at.isoformat(),
        }


class ArchiveManager:
    def __init__(self) -> None:
        self._entries: list[ArchiveEntry] = []

    def archive(
        self,
        resource_type: str,
        resource_id: str,
        level: ArchiveLevel,
        archived_by: str,
        reason: str = "",
    ) -> ArchiveEntry:
        entry = ArchiveEntry(
            entry_id=str(uuid.uuid4()),
            resource_type=resource_type,
            resource_id=resource_id,
            archive_level=level,
            archived_by=archived_by,
            reason=reason,
        )
        self._entries.append(entry)
        logger.info("Archived %s:%s at level %s", resource_type, resource_id, level.value)
        return entry

    def find(self, resource_type: str, resource_id: str) -> ArchiveEntry | None:
        for entry in self._entries:
            if entry.resource_type == resource_type and entry.resource_id == resource_id:
                return entry
        return None

    def by_level(self, level: ArchiveLevel) -> list[ArchiveEntry]:
        return [e for e in self._entries if e.archive_level == level]

    def summary(self) -> dict:
        return {
            level.value: len(self.by_level(level))
            for level in ArchiveLevel
        }


# ---------------------------------------------------------------------------
# Loan renewal system
# ---------------------------------------------------------------------------

@dataclass
class RenewalRequest:
    request_id: str
    loan: Loan
    requested_at: datetime = field(default_factory=datetime.now)
    approved: bool = False
    denied_reason: str = ""
    new_due_at: datetime | None = None

    def approve(self, extension_days: int) -> None:
        self.approved = True
        self.new_due_at = self.loan.due_at + timedelta(days=extension_days)

    def deny(self, reason: str) -> None:
        self.denied_reason = reason

    def to_dict(self) -> dict:
        return {
            "request_id": self.request_id,
            "loan_id": self.loan.loan_id,
            "requested_at": self.requested_at.isoformat(),
            "approved": self.approved,
            "new_due_at": self.new_due_at.isoformat() if self.new_due_at else None,
        }


class RenewalService:
    MAX_RENEWALS = 2
    RENEWAL_DAYS = 7

    def __init__(
        self,
        loans: LoanRepository,
        reservations: ReservationRepository,
        members: MemberRepository,
    ) -> None:
        self.loans = loans
        self.reservations = reservations
        self.members = members
        self._renewal_counts: dict[str, int] = {}
        self._requests: list[RenewalRequest] = []

    def request_renewal(self, loan_id: str) -> RenewalRequest:
        loan = self.loans.get_or_raise(loan_id)
        if loan.status != LoanStatus.ACTIVE:
            raise ValueError(f"Loan {loan_id} is not active")

        count = self._renewal_counts.get(loan_id, 0)
        if count >= self.MAX_RENEWALS:
            raise ValueError(f"Maximum renewals ({self.MAX_RENEWALS}) reached for loan {loan_id}")

        waiting = self.reservations.active_by_book(loan.book.book_id)
        request = RenewalRequest(
            request_id=str(uuid.uuid4()),
            loan=loan,
        )

        if waiting:
            request.deny("Book has waiting reservations")
        elif loan.is_overdue():
            request.deny("Loan is overdue — return first")
        else:
            request.approve(self.RENEWAL_DAYS)
            loan.due_at = request.new_due_at  # type: ignore[assignment]
            self._renewal_counts[loan_id] = count + 1

        self._requests.append(request)
        return request

    def renewal_history(self, loan_id: str) -> list[RenewalRequest]:
        return [r for r in self._requests if r.loan.loan_id == loan_id]

    def renewal_count(self, loan_id: str) -> int:
        return self._renewal_counts.get(loan_id, 0)
