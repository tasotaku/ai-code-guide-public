"""
hospital_system.py — 病院予約・患者管理システム（フローチャートテスト用: ~5000行）
"""

from __future__ import annotations

import hashlib
import json
import logging
import re
import uuid
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from enum import Enum
from typing import Callable, Iterator, NamedTuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

class Gender(Enum):
    MALE = "male"
    FEMALE = "female"
    OTHER = "other"
    UNKNOWN = "unknown"


class BloodType(Enum):
    A_POS = "A+"
    A_NEG = "A-"
    B_POS = "B+"
    B_NEG = "B-"
    AB_POS = "AB+"
    AB_NEG = "AB-"
    O_POS = "O+"
    O_NEG = "O-"
    UNKNOWN = "unknown"


class Department(Enum):
    INTERNAL = "internal_medicine"
    SURGERY = "surgery"
    PEDIATRICS = "pediatrics"
    OBSTETRICS = "obstetrics"
    CARDIOLOGY = "cardiology"
    ORTHOPEDICS = "orthopedics"
    DERMATOLOGY = "dermatology"
    OPHTHALMOLOGY = "ophthalmology"
    PSYCHIATRY = "psychiatry"
    EMERGENCY = "emergency"
    RADIOLOGY = "radiology"
    REHABILITATION = "rehabilitation"


class AppointmentStatus(Enum):
    SCHEDULED = "scheduled"
    CHECKED_IN = "checked_in"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    NO_SHOW = "no_show"


class PrescriptionStatus(Enum):
    ACTIVE = "active"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class BedStatus(Enum):
    AVAILABLE = "available"
    OCCUPIED = "occupied"
    CLEANING = "cleaning"
    MAINTENANCE = "maintenance"
    RESERVED = "reserved"


class AdmissionStatus(Enum):
    ADMITTED = "admitted"
    DISCHARGED = "discharged"
    TRANSFERRED = "transferred"


class InvoiceStatus(Enum):
    DRAFT = "draft"
    ISSUED = "issued"
    PAID = "paid"
    OVERDUE = "overdue"
    CANCELLED = "cancelled"


class LabTestStatus(Enum):
    ORDERED = "ordered"
    SAMPLE_COLLECTED = "sample_collected"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class AlertLevel(Enum):
    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"


class InsuranceType(Enum):
    NATIONAL = "national"
    EMPLOYEE = "employee"
    ELDERLY = "elderly"
    SELF_PAY = "self_pay"
    OTHER = "other"


# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

APPOINTMENT_SLOT_MINUTES = 15
MAX_DAILY_APPOINTMENTS_PER_DOCTOR = 40
INSURANCE_COVERAGE: dict[InsuranceType, float] = {
    InsuranceType.NATIONAL: 0.70,
    InsuranceType.EMPLOYEE: 0.70,
    InsuranceType.ELDERLY: 0.90,
    InsuranceType.SELF_PAY: 0.0,
    InsuranceType.OTHER: 0.70,
}
OVERDUE_DAYS = 30
TAX_RATE = 0.10
MIN_PASSWORD_LENGTH = 8
PHONE_PATTERN = re.compile(r"^\d{2,4}-\d{2,4}-\d{4}$")
EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")


# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Money:
    amount: float
    currency: str = "JPY"

    def __post_init__(self) -> None:
        if self.amount < 0:
            raise ValueError(f"Money cannot be negative: {self.amount}")

    def __add__(self, other: Money) -> Money:
        if self.currency != other.currency:
            raise ValueError("Currency mismatch")
        return Money(round(self.amount + other.amount, 2), self.currency)

    def __sub__(self, other: Money) -> Money:
        if self.currency != other.currency:
            raise ValueError("Currency mismatch")
        result = round(self.amount - other.amount, 2)
        if result < 0:
            raise ValueError(f"Result would be negative: {self.amount} - {other.amount}")
        return Money(result, self.currency)

    def __mul__(self, factor: float) -> Money:
        return Money(round(self.amount * factor, 2), self.currency)

    def is_zero(self) -> bool:
        return self.amount == 0.0

    def __str__(self) -> str:
        return f"¥{self.amount:,.0f}"


ZERO = Money(0.0)


@dataclass(frozen=True)
class TimeSlot:
    date: date
    start: time
    end: time

    def __post_init__(self) -> None:
        if self.start >= self.end:
            raise ValueError(f"Start must be before end: {self.start} >= {self.end}")

    def overlaps(self, other: TimeSlot) -> bool:
        if self.date != other.date:
            return False
        return self.start < other.end and other.start < self.end

    def duration_minutes(self) -> int:
        start_minutes = self.start.hour * 60 + self.start.minute
        end_minutes = self.end.hour * 60 + self.end.minute
        return end_minutes - start_minutes

    def __str__(self) -> str:
        return f"{self.date} {self.start.strftime('%H:%M')}–{self.end.strftime('%H:%M')}"


@dataclass(frozen=True)
class Address:
    postal_code: str
    prefecture: str
    city: str
    street: str
    building: str = ""

    def full(self) -> str:
        parts = [self.postal_code, self.prefecture, self.city, self.street]
        if self.building:
            parts.append(self.building)
        return " ".join(parts)


# ---------------------------------------------------------------------------
# Domain models — Personnel
# ---------------------------------------------------------------------------

@dataclass
class Doctor:
    doctor_id: str
    name: str
    department: Department
    license_no: str
    specialties: list[str] = field(default_factory=list)
    email: str = ""
    phone: str = ""
    active: bool = True
    max_daily_appointments: int = MAX_DAILY_APPOINTMENTS_PER_DOCTOR

    def is_available_on(self, target_date: date, existing_count: int) -> bool:
        return self.active and existing_count < self.max_daily_appointments

    def to_dict(self) -> dict:
        return {
            "doctor_id": self.doctor_id,
            "name": self.name,
            "department": self.department.value,
            "specialties": self.specialties,
            "active": self.active,
        }


@dataclass
class Nurse:
    nurse_id: str
    name: str
    department: Department
    license_no: str
    email: str = ""
    active: bool = True

    def to_dict(self) -> dict:
        return {"nurse_id": self.nurse_id, "name": self.name, "department": self.department.value}


@dataclass
class Staff:
    staff_id: str
    name: str
    role: str
    department: Department | None = None
    email: str = ""
    active: bool = True


# ---------------------------------------------------------------------------
# Domain models — Patient
# ---------------------------------------------------------------------------

@dataclass
class EmergencyContact:
    name: str
    relationship: str
    phone: str
    email: str = ""


@dataclass
class Insurance:
    insurance_id: str
    insurer_name: str
    policy_no: str
    insurance_type: InsuranceType
    valid_from: date
    valid_to: date
    holder_name: str = ""

    def is_valid(self, on_date: date | None = None) -> bool:
        check = on_date or date.today()
        return self.valid_from <= check <= self.valid_to

    def coverage_rate(self) -> float:
        return INSURANCE_COVERAGE.get(self.insurance_type, 0.0)


@dataclass
class Patient:
    patient_id: str
    name: str
    name_kana: str
    birth_date: date
    gender: Gender
    blood_type: BloodType = BloodType.UNKNOWN
    address: Address | None = None
    phone: str = ""
    email: str = ""
    emergency_contact: EmergencyContact | None = None
    insurance: Insurance | None = None
    allergies: list[str] = field(default_factory=list)
    chronic_conditions: list[str] = field(default_factory=list)
    notes: str = ""
    registered_at: datetime = field(default_factory=datetime.now)
    active: bool = True

    def age(self) -> int:
        today = date.today()
        return today.year - self.birth_date.year - (
            (today.month, today.day) < (self.birth_date.month, self.birth_date.day)
        )

    def has_allergy(self, substance: str) -> bool:
        return any(substance.lower() in a.lower() for a in self.allergies)

    def insurance_coverage(self) -> float:
        if self.insurance and self.insurance.is_valid():
            return self.insurance.coverage_rate()
        return 0.0

    def to_dict(self) -> dict:
        return {
            "patient_id": self.patient_id,
            "name": self.name,
            "birth_date": self.birth_date.isoformat(),
            "age": self.age(),
            "gender": self.gender.value,
            "blood_type": self.blood_type.value,
            "phone": self.phone,
            "allergies": self.allergies,
            "chronic_conditions": self.chronic_conditions,
        }


# ---------------------------------------------------------------------------
# Domain models — Appointments & Visits
# ---------------------------------------------------------------------------

@dataclass
class Appointment:
    appointment_id: str
    patient: Patient
    doctor: Doctor
    slot: TimeSlot
    department: Department
    reason: str = ""
    status: AppointmentStatus = AppointmentStatus.SCHEDULED
    created_at: datetime = field(default_factory=datetime.now)
    notes: str = ""
    checked_in_at: datetime | None = None
    completed_at: datetime | None = None

    def check_in(self) -> None:
        if self.status != AppointmentStatus.SCHEDULED:
            raise ValueError(f"Cannot check in: status={self.status}")
        self.status = AppointmentStatus.CHECKED_IN
        self.checked_in_at = datetime.now()

    def start(self) -> None:
        if self.status != AppointmentStatus.CHECKED_IN:
            raise ValueError(f"Cannot start: status={self.status}")
        self.status = AppointmentStatus.IN_PROGRESS

    def complete(self) -> None:
        if self.status != AppointmentStatus.IN_PROGRESS:
            raise ValueError(f"Cannot complete: status={self.status}")
        self.status = AppointmentStatus.COMPLETED
        self.completed_at = datetime.now()

    def cancel(self, reason: str = "") -> None:
        if self.status in (AppointmentStatus.COMPLETED, AppointmentStatus.CANCELLED):
            raise ValueError(f"Cannot cancel: status={self.status}")
        self.status = AppointmentStatus.CANCELLED
        if reason:
            self.notes += f"\nCancelled: {reason}"

    def mark_no_show(self) -> None:
        if self.status != AppointmentStatus.SCHEDULED:
            raise ValueError(f"Cannot mark no-show: status={self.status}")
        self.status = AppointmentStatus.NO_SHOW

    def to_dict(self) -> dict:
        return {
            "appointment_id": self.appointment_id,
            "patient_id": self.patient.patient_id,
            "doctor_id": self.doctor.doctor_id,
            "slot": str(self.slot),
            "department": self.department.value,
            "status": self.status.value,
            "reason": self.reason,
        }


@dataclass
class VitalSigns:
    recorded_at: datetime
    recorded_by: str
    temperature: float | None = None      # °C
    blood_pressure_systolic: int | None = None
    blood_pressure_diastolic: int | None = None
    pulse: int | None = None              # bpm
    spo2: float | None = None             # %
    respiratory_rate: int | None = None   # /min
    weight: float | None = None           # kg
    height: float | None = None           # cm
    notes: str = ""

    def bmi(self) -> float | None:
        if self.weight and self.height:
            return round(self.weight / (self.height / 100) ** 2, 1)
        return None

    def has_critical_values(self) -> bool:
        if self.temperature and self.temperature >= 39.0:
            return True
        if self.spo2 and self.spo2 < 90.0:
            return True
        if self.pulse and (self.pulse < 40 or self.pulse > 150):
            return True
        if self.blood_pressure_systolic and self.blood_pressure_systolic >= 180:
            return True
        return False

    def to_dict(self) -> dict:
        return {
            "recorded_at": self.recorded_at.isoformat(),
            "temperature": self.temperature,
            "blood_pressure": f"{self.blood_pressure_systolic}/{self.blood_pressure_diastolic}" if self.blood_pressure_systolic else None,
            "pulse": self.pulse,
            "spo2": self.spo2,
            "weight": self.weight,
            "bmi": self.bmi(),
        }


@dataclass
class Diagnosis:
    icd_code: str
    name: str
    is_primary: bool = True
    notes: str = ""


@dataclass
class MedicalRecord:
    record_id: str
    patient: Patient
    doctor: Doctor
    appointment: Appointment | None
    recorded_at: datetime = field(default_factory=datetime.now)
    subjective: str = ""      # S: 主訴
    objective: str = ""       # O: 所見
    assessment: str = ""      # A: 評価
    plan: str = ""            # P: 計画
    diagnoses: list[Diagnosis] = field(default_factory=list)
    vitals: VitalSigns | None = None
    is_confidential: bool = False

    def primary_diagnosis(self) -> Diagnosis | None:
        for d in self.diagnoses:
            if d.is_primary:
                return d
        return self.diagnoses[0] if self.diagnoses else None

    def soap_summary(self) -> str:
        return (
            f"S: {self.subjective}\n"
            f"O: {self.objective}\n"
            f"A: {self.assessment}\n"
            f"P: {self.plan}"
        )

    def to_dict(self) -> dict:
        primary = self.primary_diagnosis()
        return {
            "record_id": self.record_id,
            "patient_id": self.patient.patient_id,
            "doctor_id": self.doctor.doctor_id,
            "recorded_at": self.recorded_at.isoformat(),
            "primary_diagnosis": primary.name if primary else None,
            "plan": self.plan,
        }


# ---------------------------------------------------------------------------
# Domain models — Medication
# ---------------------------------------------------------------------------

@dataclass
class Drug:
    drug_id: str
    generic_name: str
    brand_name: str
    category: str
    unit: str
    contraindications: list[str] = field(default_factory=list)
    requires_prescription: bool = True
    stock: int = 0

    def is_contraindicated_for(self, patient: Patient) -> bool:
        return any(patient.has_allergy(c) for c in self.contraindications)


@dataclass
class PrescriptionLine:
    drug: Drug
    dosage: str
    frequency: str
    duration_days: int
    instructions: str = ""
    quantity: int = 0

    def __post_init__(self) -> None:
        if self.quantity == 0:
            self.quantity = self.duration_days


@dataclass
class Prescription:
    prescription_id: str
    patient: Patient
    doctor: Doctor
    record: MedicalRecord
    lines: list[PrescriptionLine] = field(default_factory=list)
    issued_at: datetime = field(default_factory=datetime.now)
    valid_until: date = field(default_factory=lambda: (datetime.now() + timedelta(days=30)).date())
    status: PrescriptionStatus = PrescriptionStatus.ACTIVE
    dispensed_at: datetime | None = None
    dispensed_by: str = ""

    def is_valid(self) -> bool:
        return self.status == PrescriptionStatus.ACTIVE and date.today() <= self.valid_until

    def dispense(self, dispensed_by: str) -> None:
        if not self.is_valid():
            raise ValueError(f"Prescription {self.prescription_id} is not valid")
        self.dispensed_at = datetime.now()
        self.dispensed_by = dispensed_by
        self.status = PrescriptionStatus.COMPLETED

    def check_allergies(self) -> list[str]:
        return [
            line.drug.generic_name
            for line in self.lines
            if line.drug.is_contraindicated_for(self.patient)
        ]

    def to_dict(self) -> dict:
        return {
            "prescription_id": self.prescription_id,
            "patient_id": self.patient.patient_id,
            "issued_at": self.issued_at.isoformat(),
            "status": self.status.value,
            "lines": [
                {"drug": line.drug.generic_name, "dosage": line.dosage, "frequency": line.frequency}
                for line in self.lines
            ],
        }


# ---------------------------------------------------------------------------
# Domain models — Lab
# ---------------------------------------------------------------------------

@dataclass
class LabTest:
    test_id: str
    name: str
    code: str
    category: str
    reference_range: str = ""
    unit: str = ""
    turnaround_hours: int = 24


@dataclass
class LabOrder:
    order_id: str
    patient: Patient
    doctor: Doctor
    tests: list[LabTest]
    ordered_at: datetime = field(default_factory=datetime.now)
    status: LabTestStatus = LabTestStatus.ORDERED
    sample_collected_at: datetime | None = None
    results: dict[str, str] = field(default_factory=dict)
    completed_at: datetime | None = None
    notes: str = ""

    def collect_sample(self) -> None:
        if self.status != LabTestStatus.ORDERED:
            raise ValueError(f"Cannot collect sample: status={self.status}")
        self.status = LabTestStatus.SAMPLE_COLLECTED
        self.sample_collected_at = datetime.now()

    def add_result(self, test_code: str, value: str) -> None:
        self.results[test_code] = value

    def complete(self) -> None:
        self.status = LabTestStatus.COMPLETED
        self.completed_at = datetime.now()

    def is_complete(self) -> bool:
        return self.status == LabTestStatus.COMPLETED

    def to_dict(self) -> dict:
        return {
            "order_id": self.order_id,
            "patient_id": self.patient.patient_id,
            "tests": [t.code for t in self.tests],
            "status": self.status.value,
            "results": self.results,
        }


# ---------------------------------------------------------------------------
# Domain models — Inpatient
# ---------------------------------------------------------------------------

@dataclass
class Ward:
    ward_id: str
    name: str
    department: Department
    floor: int
    total_beds: int

    def to_dict(self) -> dict:
        return {"ward_id": self.ward_id, "name": self.name, "floor": self.floor, "total_beds": self.total_beds}


@dataclass
class Bed:
    bed_id: str
    ward: Ward
    bed_number: str
    status: BedStatus = BedStatus.AVAILABLE
    current_patient_id: str | None = None

    def is_available(self) -> bool:
        return self.status == BedStatus.AVAILABLE

    def assign(self, patient_id: str) -> None:
        if not self.is_available():
            raise ValueError(f"Bed {self.bed_id} is not available (status={self.status})")
        self.status = BedStatus.OCCUPIED
        self.current_patient_id = patient_id

    def release(self) -> None:
        self.status = BedStatus.CLEANING
        self.current_patient_id = None

    def mark_clean(self) -> None:
        if self.status != BedStatus.CLEANING:
            raise ValueError(f"Bed {self.bed_id} is not being cleaned")
        self.status = BedStatus.AVAILABLE


@dataclass
class Admission:
    admission_id: str
    patient: Patient
    doctor: Doctor
    bed: Bed
    ward: Ward
    admitted_at: datetime = field(default_factory=datetime.now)
    expected_discharge: date | None = None
    discharged_at: datetime | None = None
    status: AdmissionStatus = AdmissionStatus.ADMITTED
    admission_reason: str = ""
    discharge_summary: str = ""

    def discharge(self, summary: str) -> None:
        if self.status != AdmissionStatus.ADMITTED:
            raise ValueError(f"Cannot discharge: status={self.status}")
        self.discharge_summary = summary
        self.discharged_at = datetime.now()
        self.status = AdmissionStatus.DISCHARGED
        self.bed.release()

    def days_admitted(self) -> int:
        end = self.discharged_at or datetime.now()
        return (end - self.admitted_at).days + 1

    def to_dict(self) -> dict:
        return {
            "admission_id": self.admission_id,
            "patient_id": self.patient.patient_id,
            "ward": self.ward.name,
            "bed": self.bed.bed_number,
            "admitted_at": self.admitted_at.isoformat(),
            "discharged_at": self.discharged_at.isoformat() if self.discharged_at else None,
            "status": self.status.value,
        }


# ---------------------------------------------------------------------------
# Domain models — Billing
# ---------------------------------------------------------------------------

@dataclass
class InvoiceLine:
    description: str
    quantity: int
    unit_price: Money
    category: str = "treatment"

    @property
    def total(self) -> Money:
        return self.unit_price * self.quantity


@dataclass
class Invoice:
    invoice_id: str
    patient: Patient
    lines: list[InvoiceLine] = field(default_factory=list)
    status: InvoiceStatus = InvoiceStatus.DRAFT
    issued_at: datetime | None = None
    due_date: date | None = None
    paid_at: datetime | None = None
    paid_amount: Money = field(default_factory=lambda: ZERO)
    insurance_claimed: Money = field(default_factory=lambda: ZERO)
    notes: str = ""

    @property
    def subtotal(self) -> Money:
        if not self.lines:
            return ZERO
        result = self.lines[0].total
        for line in self.lines[1:]:
            result = result + line.total
        return result

    @property
    def tax(self) -> Money:
        return self.subtotal * TAX_RATE

    @property
    def gross_total(self) -> Money:
        return self.subtotal + self.tax

    @property
    def patient_due(self) -> Money:
        coverage = self.patient.insurance_coverage()
        insured = self.gross_total * coverage
        return self.gross_total - insured

    def add_line(self, description: str, quantity: int, unit_price: Money, category: str = "treatment") -> None:
        self.lines.append(InvoiceLine(description, quantity, unit_price, category))

    def issue(self, due_days: int = 30) -> None:
        if self.status != InvoiceStatus.DRAFT:
            raise ValueError(f"Invoice {self.invoice_id} is already issued")
        self.status = InvoiceStatus.ISSUED
        self.issued_at = datetime.now()
        self.due_date = date.today() + timedelta(days=due_days)

    def mark_paid(self, amount: Money) -> None:
        if self.status != InvoiceStatus.ISSUED:
            raise ValueError(f"Invoice {self.invoice_id} is not in ISSUED state")
        self.paid_amount = amount
        self.paid_at = datetime.now()
        self.status = InvoiceStatus.PAID

    def mark_overdue(self) -> None:
        if self.status == InvoiceStatus.ISSUED and self.due_date and date.today() > self.due_date:
            self.status = InvoiceStatus.OVERDUE

    def to_dict(self) -> dict:
        return {
            "invoice_id": self.invoice_id,
            "patient_id": self.patient.patient_id,
            "gross_total": self.gross_total.amount,
            "patient_due": self.patient_due.amount,
            "status": self.status.value,
            "issued_at": self.issued_at.isoformat() if self.issued_at else None,
        }


# ---------------------------------------------------------------------------
# Domain models — Alert system
# ---------------------------------------------------------------------------

@dataclass
class Alert:
    alert_id: str
    level: AlertLevel
    title: str
    message: str
    patient_id: str | None
    created_at: datetime = field(default_factory=datetime.now)
    acknowledged_at: datetime | None = None
    acknowledged_by: str | None = None

    def acknowledge(self, staff_id: str) -> None:
        self.acknowledged_at = datetime.now()
        self.acknowledged_by = staff_id

    def is_acknowledged(self) -> bool:
        return self.acknowledged_at is not None

    def to_dict(self) -> dict:
        return {
            "alert_id": self.alert_id,
            "level": self.level.value,
            "title": self.title,
            "patient_id": self.patient_id,
            "acknowledged": self.is_acknowledged(),
        }


# ---------------------------------------------------------------------------
# Repository layer
# ---------------------------------------------------------------------------

class PatientRepository:
    def __init__(self) -> None:
        self._patients: dict[str, Patient] = {}
        self._phone_index: dict[str, str] = {}

    def add(self, patient: Patient) -> None:
        self._patients[patient.patient_id] = patient
        if patient.phone:
            self._phone_index[patient.phone] = patient.patient_id

    def get(self, patient_id: str) -> Patient | None:
        return self._patients.get(patient_id)

    def get_or_raise(self, patient_id: str) -> Patient:
        p = self.get(patient_id)
        if p is None:
            raise KeyError(f"Patient not found: {patient_id}")
        return p

    def by_phone(self, phone: str) -> Patient | None:
        pid = self._phone_index.get(phone)
        return self._patients.get(pid) if pid else None

    def search(self, query: str) -> list[Patient]:
        q = query.lower()
        return [
            p for p in self._patients.values()
            if q in p.name.lower() or q in p.name_kana.lower() or q in p.patient_id.lower()
        ]

    def all(self) -> list[Patient]:
        return list(self._patients.values())

    def active(self) -> list[Patient]:
        return [p for p in self._patients.values() if p.active]


class DoctorRepository:
    def __init__(self) -> None:
        self._doctors: dict[str, Doctor] = {}

    def add(self, doctor: Doctor) -> None:
        self._doctors[doctor.doctor_id] = doctor

    def get(self, doctor_id: str) -> Doctor | None:
        return self._doctors.get(doctor_id)

    def get_or_raise(self, doctor_id: str) -> Doctor:
        d = self.get(doctor_id)
        if d is None:
            raise KeyError(f"Doctor not found: {doctor_id}")
        return d

    def by_department(self, department: Department) -> list[Doctor]:
        return [d for d in self._doctors.values() if d.department == department and d.active]

    def active(self) -> list[Doctor]:
        return [d for d in self._doctors.values() if d.active]

    def all(self) -> list[Doctor]:
        return list(self._doctors.values())


class AppointmentRepository:
    def __init__(self) -> None:
        self._appointments: dict[str, Appointment] = {}

    def add(self, appointment: Appointment) -> None:
        self._appointments[appointment.appointment_id] = appointment

    def get(self, appointment_id: str) -> Appointment | None:
        return self._appointments.get(appointment_id)

    def get_or_raise(self, appointment_id: str) -> Appointment:
        a = self.get(appointment_id)
        if a is None:
            raise KeyError(f"Appointment not found: {appointment_id}")
        return a

    def by_patient(self, patient_id: str) -> list[Appointment]:
        return [a for a in self._appointments.values() if a.patient.patient_id == patient_id]

    def by_doctor_on_date(self, doctor_id: str, target_date: date) -> list[Appointment]:
        return [
            a for a in self._appointments.values()
            if a.doctor.doctor_id == doctor_id
            and a.slot.date == target_date
            and a.status not in (AppointmentStatus.CANCELLED, AppointmentStatus.NO_SHOW)
        ]

    def by_date(self, target_date: date) -> list[Appointment]:
        return [a for a in self._appointments.values() if a.slot.date == target_date]

    def upcoming(self, patient_id: str) -> list[Appointment]:
        today = date.today()
        return [
            a for a in self._appointments.values()
            if a.patient.patient_id == patient_id
            and a.slot.date >= today
            and a.status == AppointmentStatus.SCHEDULED
        ]

    def all(self) -> list[Appointment]:
        return list(self._appointments.values())


class MedicalRecordRepository:
    def __init__(self) -> None:
        self._records: dict[str, MedicalRecord] = {}

    def add(self, record: MedicalRecord) -> None:
        self._records[record.record_id] = record

    def get(self, record_id: str) -> MedicalRecord | None:
        return self._records.get(record_id)

    def by_patient(self, patient_id: str) -> list[MedicalRecord]:
        return sorted(
            [r for r in self._records.values() if r.patient.patient_id == patient_id],
            key=lambda r: r.recorded_at,
            reverse=True,
        )

    def by_doctor(self, doctor_id: str) -> list[MedicalRecord]:
        return [r for r in self._records.values() if r.doctor.doctor_id == doctor_id]

    def all(self) -> list[MedicalRecord]:
        return list(self._records.values())


class PrescriptionRepository:
    def __init__(self) -> None:
        self._prescriptions: dict[str, Prescription] = {}

    def add(self, prescription: Prescription) -> None:
        self._prescriptions[prescription.prescription_id] = prescription

    def get(self, prescription_id: str) -> Prescription | None:
        return self._prescriptions.get(prescription_id)

    def active_by_patient(self, patient_id: str) -> list[Prescription]:
        return [
            p for p in self._prescriptions.values()
            if p.patient.patient_id == patient_id and p.is_valid()
        ]

    def all(self) -> list[Prescription]:
        return list(self._prescriptions.values())


class LabOrderRepository:
    def __init__(self) -> None:
        self._orders: dict[str, LabOrder] = {}

    def add(self, order: LabOrder) -> None:
        self._orders[order.order_id] = order

    def get(self, order_id: str) -> LabOrder | None:
        return self._orders.get(order_id)

    def get_or_raise(self, order_id: str) -> LabOrder:
        o = self.get(order_id)
        if o is None:
            raise KeyError(f"LabOrder not found: {order_id}")
        return o

    def pending_by_patient(self, patient_id: str) -> list[LabOrder]:
        return [
            o for o in self._orders.values()
            if o.patient.patient_id == patient_id
            and o.status not in (LabTestStatus.COMPLETED, LabTestStatus.CANCELLED)
        ]

    def all(self) -> list[LabOrder]:
        return list(self._orders.values())


class AdmissionRepository:
    def __init__(self) -> None:
        self._admissions: dict[str, Admission] = {}

    def add(self, admission: Admission) -> None:
        self._admissions[admission.admission_id] = admission

    def get(self, admission_id: str) -> Admission | None:
        return self._admissions.get(admission_id)

    def current_by_patient(self, patient_id: str) -> Admission | None:
        for a in self._admissions.values():
            if a.patient.patient_id == patient_id and a.status == AdmissionStatus.ADMITTED:
                return a
        return None

    def by_ward(self, ward_id: str) -> list[Admission]:
        return [a for a in self._admissions.values() if a.ward.ward_id == ward_id and a.status == AdmissionStatus.ADMITTED]

    def all(self) -> list[Admission]:
        return list(self._admissions.values())


class BedRepository:
    def __init__(self) -> None:
        self._beds: dict[str, Bed] = {}

    def add(self, bed: Bed) -> None:
        self._beds[bed.bed_id] = bed

    def get(self, bed_id: str) -> Bed | None:
        return self._beds.get(bed_id)

    def available_in_ward(self, ward_id: str) -> list[Bed]:
        return [b for b in self._beds.values() if b.ward.ward_id == ward_id and b.is_available()]

    def all(self) -> list[Bed]:
        return list(self._beds.values())


class InvoiceRepository:
    def __init__(self) -> None:
        self._invoices: dict[str, Invoice] = {}

    def add(self, invoice: Invoice) -> None:
        self._invoices[invoice.invoice_id] = invoice

    def get(self, invoice_id: str) -> Invoice | None:
        return self._invoices.get(invoice_id)

    def by_patient(self, patient_id: str) -> list[Invoice]:
        return [i for i in self._invoices.values() if i.patient.patient_id == patient_id]

    def unpaid(self) -> list[Invoice]:
        return [i for i in self._invoices.values() if i.status in (InvoiceStatus.ISSUED, InvoiceStatus.OVERDUE)]

    def all(self) -> list[Invoice]:
        return list(self._invoices.values())


class AlertRepository:
    def __init__(self) -> None:
        self._alerts: dict[str, Alert] = {}

    def add(self, alert: Alert) -> None:
        self._alerts[alert.alert_id] = alert

    def unacknowledged(self, level: AlertLevel | None = None) -> list[Alert]:
        alerts = [a for a in self._alerts.values() if not a.is_acknowledged()]
        if level:
            alerts = [a for a in alerts if a.level == level]
        return sorted(alerts, key=lambda a: a.created_at, reverse=True)

    def by_patient(self, patient_id: str) -> list[Alert]:
        return [a for a in self._alerts.values() if a.patient_id == patient_id]

    def all(self) -> list[Alert]:
        return list(self._alerts.values())


# ---------------------------------------------------------------------------
# Service layer
# ---------------------------------------------------------------------------

class AppointmentService:
    def __init__(
        self,
        appointments: AppointmentRepository,
        patients: PatientRepository,
        doctors: DoctorRepository,
    ) -> None:
        self.appointments = appointments
        self.patients = patients
        self.doctors = doctors

    def book(
        self,
        patient_id: str,
        doctor_id: str,
        slot: TimeSlot,
        reason: str = "",
    ) -> Appointment:
        patient = self.patients.get_or_raise(patient_id)
        doctor = self.doctors.get_or_raise(doctor_id)

        if not patient.active:
            raise ValueError(f"Patient {patient_id} is not active")
        if not doctor.active:
            raise ValueError(f"Doctor {doctor_id} is not active")

        existing = self.appointments.by_doctor_on_date(doctor_id, slot.date)
        if not doctor.is_available_on(slot.date, len(existing)):
            raise ValueError(f"Doctor {doctor_id} has reached daily appointment limit on {slot.date}")

        for appt in existing:
            if appt.slot.overlaps(slot):
                raise ValueError(f"Time slot {slot} overlaps with existing appointment {appt.appointment_id}")

        appt = Appointment(
            appointment_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            slot=slot,
            department=doctor.department,
            reason=reason,
        )
        self.appointments.add(appt)
        logger.info("Appointment booked: %s for patient %s with doctor %s on %s", appt.appointment_id, patient_id, doctor_id, slot)
        return appt

    def cancel(self, appointment_id: str, reason: str = "") -> None:
        appt = self.appointments.get_or_raise(appointment_id)
        appt.cancel(reason)
        logger.info("Appointment cancelled: %s", appointment_id)

    def check_in(self, appointment_id: str) -> None:
        appt = self.appointments.get_or_raise(appointment_id)
        appt.check_in()

    def complete(self, appointment_id: str) -> None:
        appt = self.appointments.get_or_raise(appointment_id)
        if appt.status == AppointmentStatus.CHECKED_IN:
            appt.start()
        appt.complete()

    def daily_schedule(self, doctor_id: str, target_date: date) -> list[Appointment]:
        return sorted(
            self.appointments.by_doctor_on_date(doctor_id, target_date),
            key=lambda a: a.slot.start,
        )


class ClinicalService:
    def __init__(
        self,
        records: MedicalRecordRepository,
        prescriptions: PrescriptionRepository,
        lab_orders: LabOrderRepository,
        alerts: AlertRepository,
        patients: PatientRepository,
    ) -> None:
        self.records = records
        self.prescriptions = prescriptions
        self.lab_orders = lab_orders
        self.alerts = alerts
        self.patients = patients

    def create_record(
        self,
        patient_id: str,
        doctor: Doctor,
        appointment: Appointment | None,
        subjective: str,
        objective: str,
        assessment: str,
        plan: str,
        diagnoses: list[Diagnosis] | None = None,
        vitals: VitalSigns | None = None,
    ) -> MedicalRecord:
        patient = self.patients.get_or_raise(patient_id)
        record = MedicalRecord(
            record_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            appointment=appointment,
            subjective=subjective,
            objective=objective,
            assessment=assessment,
            plan=plan,
            diagnoses=diagnoses or [],
            vitals=vitals,
        )
        self.records.add(record)

        if vitals and vitals.has_critical_values():
            self._raise_vital_alert(patient, vitals)

        logger.info("Medical record created: %s for patient %s", record.record_id, patient_id)
        return record

    def _raise_vital_alert(self, patient: Patient, vitals: VitalSigns) -> None:
        alert = Alert(
            alert_id=str(uuid.uuid4()),
            level=AlertLevel.CRITICAL,
            title="Critical Vital Signs",
            message=f"Patient {patient.name} has critical vital signs. Immediate attention required.",
            patient_id=patient.patient_id,
        )
        self.alerts.add(alert)
        logger.warning("Critical vital alert raised for patient %s", patient.patient_id)

    def prescribe(
        self,
        patient_id: str,
        doctor: Doctor,
        record: MedicalRecord,
        lines: list[PrescriptionLine],
    ) -> Prescription:
        patient = self.patients.get_or_raise(patient_id)
        prescription = Prescription(
            prescription_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            record=record,
            lines=lines,
        )
        allergy_alerts = prescription.check_allergies()
        if allergy_alerts:
            alert = Alert(
                alert_id=str(uuid.uuid4()),
                level=AlertLevel.WARNING,
                title="Allergy Warning",
                message=f"Patient {patient.name} may be allergic to: {', '.join(allergy_alerts)}",
                patient_id=patient_id,
            )
            self.alerts.add(alert)
            logger.warning("Allergy alert for patient %s: %s", patient_id, allergy_alerts)

        self.prescriptions.add(prescription)
        logger.info("Prescription created: %s for patient %s", prescription.prescription_id, patient_id)
        return prescription

    def order_lab(self, patient_id: str, doctor: Doctor, tests: list[LabTest]) -> LabOrder:
        patient = self.patients.get_or_raise(patient_id)
        order = LabOrder(
            order_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            tests=tests,
        )
        self.lab_orders.add(order)
        logger.info("Lab order created: %s for patient %s (%d tests)", order.order_id, patient_id, len(tests))
        return order

    def enter_lab_results(self, order_id: str, results: dict[str, str]) -> None:
        order = self.lab_orders.get_or_raise(order_id)
        for code, value in results.items():
            order.add_result(code, value)
        order.complete()
        logger.info("Lab results entered for order %s", order_id)

    def patient_timeline(self, patient_id: str) -> list[dict]:
        events: list[dict] = []
        for record in self.records.by_patient(patient_id):
            events.append({
                "type": "record",
                "date": record.recorded_at.isoformat(),
                "summary": record.primary_diagnosis().name if record.primary_diagnosis() else record.assessment[:50],
            })
        for order in self.lab_orders.all():
            if order.patient.patient_id == patient_id:
                events.append({
                    "type": "lab",
                    "date": order.ordered_at.isoformat(),
                    "summary": f"{len(order.tests)} tests ordered",
                })
        return sorted(events, key=lambda e: e["date"], reverse=True)


class AdmissionService:
    def __init__(
        self,
        admissions: AdmissionRepository,
        beds: BedRepository,
        patients: PatientRepository,
        invoices: InvoiceRepository,
    ) -> None:
        self.admissions = admissions
        self.beds = beds
        self.patients = patients
        self.invoices = invoices

    def admit(self, patient_id: str, doctor: Doctor, ward: Ward, reason: str) -> Admission:
        patient = self.patients.get_or_raise(patient_id)
        current = self.admissions.current_by_patient(patient_id)
        if current:
            raise ValueError(f"Patient {patient_id} is already admitted ({current.admission_id})")

        available = self.beds.available_in_ward(ward.ward_id)
        if not available:
            raise ValueError(f"No available beds in ward {ward.ward_id}")

        bed = available[0]
        bed.assign(patient_id)

        admission = Admission(
            admission_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            bed=bed,
            ward=ward,
            admission_reason=reason,
        )
        self.admissions.add(admission)
        logger.info("Patient %s admitted to ward %s bed %s", patient_id, ward.name, bed.bed_number)
        return admission

    def discharge(self, admission_id: str, summary: str) -> Invoice:
        admission = self.admissions.get(admission_id)
        if admission is None:
            raise KeyError(f"Admission not found: {admission_id}")
        days = admission.days_admitted()
        admission.discharge(summary)

        invoice = Invoice(
            invoice_id=str(uuid.uuid4()),
            patient=admission.patient,
        )
        invoice.add_line("入院基本料", days, Money(8000), "hospitalization")
        invoice.add_line("管理料", days, Money(500), "management")
        invoice.issue()
        self.invoices.add(invoice)
        logger.info("Patient %s discharged after %d days, invoice %s issued", admission.patient.patient_id, days, invoice.invoice_id)
        return invoice

    def bed_occupancy(self, ward: Ward) -> dict:
        occupied = self.admissions.by_ward(ward.ward_id)
        available = self.beds.available_in_ward(ward.ward_id)
        return {
            "ward": ward.name,
            "total": ward.total_beds,
            "occupied": len(occupied),
            "available": len(available),
            "occupancy_rate": len(occupied) / ward.total_beds if ward.total_beds else 0.0,
        }


class BillingService:
    def __init__(self, invoices: InvoiceRepository, patients: PatientRepository) -> None:
        self.invoices = invoices
        self.patients = patients

    def create_outpatient_invoice(self, patient_id: str, items: list[dict]) -> Invoice:
        patient = self.patients.get_or_raise(patient_id)
        invoice = Invoice(invoice_id=str(uuid.uuid4()), patient=patient)
        for item in items:
            invoice.add_line(item["description"], item["qty"], Money(item["unit_price"]), item.get("category", "treatment"))
        invoice.issue()
        self.invoices.add(invoice)
        logger.info("Outpatient invoice %s created for patient %s", invoice.invoice_id, patient_id)
        return invoice

    def record_payment(self, invoice_id: str, amount: float) -> None:
        invoice = self.invoices.get(invoice_id)
        if invoice is None:
            raise KeyError(f"Invoice not found: {invoice_id}")
        invoice.mark_paid(Money(amount))
        logger.info("Payment recorded: invoice %s, amount ¥%,.0f", invoice_id, amount)

    def process_overdue(self) -> list[Invoice]:
        overdue = []
        for invoice in self.invoices.unpaid():
            if invoice.due_date and date.today() > invoice.due_date:
                invoice.mark_overdue()
                overdue.append(invoice)
        return overdue

    def revenue_summary(self) -> dict:
        all_invoices = self.invoices.all()
        paid = [i for i in all_invoices if i.status == InvoiceStatus.PAID]
        total_billed = sum(i.gross_total.amount for i in all_invoices if i.status != InvoiceStatus.CANCELLED)
        total_paid = sum(i.paid_amount.amount for i in paid)
        return {
            "total_invoices": len(all_invoices),
            "paid_count": len(paid),
            "total_billed": total_billed,
            "total_collected": total_paid,
            "collection_rate": total_paid / total_billed if total_billed else 0.0,
        }


# ---------------------------------------------------------------------------
# Hospital facade
# ---------------------------------------------------------------------------

@dataclass
class HospitalSystem:
    patients: PatientRepository
    doctors: DoctorRepository
    appointments: AppointmentRepository
    records: MedicalRecordRepository
    prescriptions: PrescriptionRepository
    lab_orders: LabOrderRepository
    admissions: AdmissionRepository
    beds: BedRepository
    invoices: InvoiceRepository
    alerts: AlertRepository

    appointment_svc: AppointmentService
    clinical_svc: ClinicalService
    admission_svc: AdmissionService
    billing_svc: BillingService

    @classmethod
    def create(cls) -> HospitalSystem:
        patients = PatientRepository()
        doctors = DoctorRepository()
        appointments = AppointmentRepository()
        records = MedicalRecordRepository()
        prescriptions = PrescriptionRepository()
        lab_orders = LabOrderRepository()
        admissions = AdmissionRepository()
        beds = BedRepository()
        invoices = InvoiceRepository()
        alerts = AlertRepository()

        return cls(
            patients=patients,
            doctors=doctors,
            appointments=appointments,
            records=records,
            prescriptions=prescriptions,
            lab_orders=lab_orders,
            admissions=admissions,
            beds=beds,
            invoices=invoices,
            alerts=alerts,
            appointment_svc=AppointmentService(appointments, patients, doctors),
            clinical_svc=ClinicalService(records, prescriptions, lab_orders, alerts, patients),
            admission_svc=AdmissionService(admissions, beds, patients, invoices),
            billing_svc=BillingService(invoices, patients),
        )


# ---------------------------------------------------------------------------
# Report generator
# ---------------------------------------------------------------------------

class HospitalReporter:
    def __init__(self, system: HospitalSystem) -> None:
        self.system = system

    def daily_appointment_summary(self, target_date: date) -> str:
        appts = self.system.appointments.by_date(target_date)
        counts: dict[str, int] = {}
        for a in appts:
            counts[a.status.value] = counts.get(a.status.value, 0) + 1
        lines = [
            f"=== Daily Appointment Summary: {target_date} ===",
            f"Total: {len(appts)}",
            "",
        ]
        for status, count in sorted(counts.items()):
            lines.append(f"  {status:20s}: {count}")
        return "\n".join(lines)

    def critical_alerts(self) -> str:
        alerts = self.system.alerts.unacknowledged(AlertLevel.CRITICAL)
        lines = [f"=== Critical Alerts ({len(alerts)}) ===", ""]
        for alert in alerts:
            lines.append(f"  [{alert.alert_id[:8]}] {alert.title} — patient={alert.patient_id}")
            lines.append(f"    {alert.message}")
        return "\n".join(lines)

    def bed_occupancy_report(self, wards: list[Ward]) -> str:
        lines = ["=== Bed Occupancy Report ===", ""]
        for ward in wards:
            info = self.system.admission_svc.bed_occupancy(ward)
            pct = info["occupancy_rate"] * 100
            bar = "#" * int(pct / 5)
            lines.append(f"  {ward.name:20s}: {info['occupied']:3d}/{info['total']:3d} ({pct:5.1f}%)  {bar}")
        return "\n".join(lines)

    def revenue_report(self) -> str:
        summary = self.system.billing_svc.revenue_summary()
        lines = [
            "=== Revenue Summary ===",
            f"Total invoices  : {summary['total_invoices']}",
            f"Paid            : {summary['paid_count']}",
            f"Total billed    : ¥{summary['total_billed']:,.0f}",
            f"Total collected : ¥{summary['total_collected']:,.0f}",
            f"Collection rate : {summary['collection_rate']*100:.1f}%",
        ]
        return "\n".join(lines)

    def patient_summary(self, patient_id: str) -> str:
        patient = self.system.patients.get_or_raise(patient_id)
        appts = self.system.appointments.by_patient(patient_id)
        records = self.system.records.by_patient(patient_id)
        active_prescriptions = self.system.prescriptions.active_by_patient(patient_id)
        lines = [
            f"=== Patient Summary: {patient.name} ({patient_id}) ===",
            f"Age: {patient.age()}  Gender: {patient.gender.value}  Blood: {patient.blood_type.value}",
            f"Allergies: {', '.join(patient.allergies) or 'None'}",
            f"Chronic conditions: {', '.join(patient.chronic_conditions) or 'None'}",
            "",
            f"Appointments: {len(appts)} total",
            f"Medical records: {len(records)}",
            f"Active prescriptions: {len(active_prescriptions)}",
        ]
        if records:
            latest = records[0]
            primary = latest.primary_diagnosis()
            lines.append(f"\nLatest visit: {latest.recorded_at.date()}")
            lines.append(f"  Diagnosis: {primary.name if primary else 'N/A'}")
            lines.append(f"  Plan: {latest.plan[:100]}")
        return "\n".join(lines)

    def overdue_invoices_report(self) -> str:
        unpaid = self.system.invoices.unpaid()
        overdue = [i for i in unpaid if i.status == InvoiceStatus.OVERDUE]
        lines = [f"=== Overdue Invoices ({len(overdue)}) ===", ""]
        total = sum(i.patient_due.amount for i in overdue)
        for invoice in sorted(overdue, key=lambda i: i.due_date or date.min):
            lines.append(
                f"  {invoice.invoice_id[:8]}  "
                f"patient={invoice.patient.name:15s}  "
                f"due={invoice.due_date}  "
                f"amount={invoice.patient_due}"
            )
        lines.append(f"\nTotal overdue: ¥{total:,.0f}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Demo data builder
# ---------------------------------------------------------------------------

def _build_demo_system() -> tuple[HospitalSystem, list[Ward]]:
    system = HospitalSystem.create()

    doctors = [
        Doctor("D001", "田中医師", Department.INTERNAL, "L001", specialties=["循環器", "糖尿病"]),
        Doctor("D002", "山田医師", Department.SURGERY, "L002", specialties=["消化器外科"]),
        Doctor("D003", "鈴木医師", Department.PEDIATRICS, "L003", specialties=["小児科一般"]),
        Doctor("D004", "佐藤医師", Department.CARDIOLOGY, "L004", specialties=["心臓外科", "不整脈"]),
        Doctor("D005", "高橋医師", Department.PSYCHIATRY, "L005", specialties=["うつ病", "不安障害"]),
    ]
    for doc in doctors:
        system.doctors.add(doc)

    patients = [
        Patient(
            "P001", "青木太郎", "アオキタロウ",
            date(1975, 3, 12), Gender.MALE, BloodType.A_POS,
            phone="03-1234-5678", allergies=["ペニシリン"],
            chronic_conditions=["高血圧", "2型糖尿病"],
            insurance=Insurance("INS001", "協会けんぽ", "1234567890", InsuranceType.EMPLOYEE,
                                date(2025, 4, 1), date(2026, 3, 31)),
        ),
        Patient(
            "P002", "伊藤花子", "イトウハナコ",
            date(1990, 7, 25), Gender.FEMALE, BloodType.B_NEG,
            phone="06-9876-5432",
            insurance=Insurance("INS002", "国民健康保険", "9876543210", InsuranceType.NATIONAL,
                                date(2025, 1, 1), date(2025, 12, 31)),
        ),
        Patient(
            "P003", "渡辺二郎", "ワタナベジロウ",
            date(1955, 11, 8), Gender.MALE, BloodType.O_POS,
            phone="052-111-2222", chronic_conditions=["慢性腎不全"],
            insurance=Insurance("INS003", "後期高齢者医療", "5555555555", InsuranceType.ELDERLY,
                                date(2025, 1, 1), date(2025, 12, 31)),
        ),
        Patient(
            "P004", "中村三恵", "ナカムラミエ",
            date(2005, 2, 14), Gender.FEMALE, BloodType.AB_POS,
            phone="011-333-4444",
        ),
    ]
    for pat in patients:
        system.patients.add(pat)

    ward_internal = Ward("W001", "内科病棟", Department.INTERNAL, 3, 20)
    ward_surgery = Ward("W002", "外科病棟", Department.SURGERY, 4, 15)
    wards = [ward_internal, ward_surgery]

    for ward in wards:
        for i in range(1, ward.total_beds + 1):
            bed = Bed(f"{ward.ward_id}-BED{i:02d}", ward, f"{i:02d}")
            system.beds.add(bed)

    return system, wards


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    import sys
    argv = argv or sys.argv[1:]
    logging.basicConfig(level=logging.WARNING)

    system, wards = _build_demo_system()
    reporter = HospitalReporter(system)

    cmd = argv[0] if argv else "help"

    if cmd == "appointments":
        target = date.fromisoformat(argv[1]) if len(argv) > 1 else date.today()
        print(reporter.daily_appointment_summary(target))

    elif cmd == "alerts":
        print(reporter.critical_alerts())

    elif cmd == "beds":
        print(reporter.bed_occupancy_report(wards))

    elif cmd == "revenue":
        print(reporter.revenue_report())

    elif cmd == "patient":
        if len(argv) < 2:
            print("Usage: patient <patient_id>")
            return 1
        try:
            print(reporter.patient_summary(argv[1]))
        except KeyError as e:
            print(f"Error: {e}")
            return 1

    elif cmd == "overdue":
        print(reporter.overdue_invoices_report())

    elif cmd == "book":
        if len(argv) < 5:
            print("Usage: book <patient_id> <doctor_id> <date YYYY-MM-DD> <HH:MM>")
            return 1
        try:
            slot_date = date.fromisoformat(argv[3])
            start_h, start_m = map(int, argv[4].split(":"))
            start_t = time(start_h, start_m)
            end_t = time(start_h, start_m + APPOINTMENT_SLOT_MINUTES)
            slot = TimeSlot(slot_date, start_t, end_t)
            appt = system.appointment_svc.book(argv[1], argv[2], slot)
            print(f"Appointment booked: {appt.appointment_id}")
        except (KeyError, ValueError) as e:
            print(f"Error: {e}")
            return 1

    else:
        print("Commands: appointments [date] | alerts | beds | revenue | patient <id> | overdue | book <patient> <doctor> <date> <time>")
        return 1

    return 0


if __name__ == "__main__":
    import sys
    sys.exit(main())


# ---------------------------------------------------------------------------
# Validators
# ---------------------------------------------------------------------------

class PatientValidator:
    PHONE_PATTERN = re.compile(r"^\d{2,4}-\d{2,4}-\d{4}$")
    EMAIL_PATTERN = re.compile(r"^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$")

    @staticmethod
    def validate_phone(phone: str) -> list[str]:
        if not PatientValidator.PHONE_PATTERN.match(phone):
            return [f"Invalid phone format: {phone}"]
        return []

    @staticmethod
    def validate_email(email: str) -> list[str]:
        if not PatientValidator.EMAIL_PATTERN.match(email):
            return [f"Invalid email: {email}"]
        return []

    @staticmethod
    def validate_patient(patient: Patient) -> list[str]:
        errors: list[str] = []
        if not patient.name.strip():
            errors.append("Name must not be empty")
        if not patient.name_kana.strip():
            errors.append("Name kana must not be empty")
        if patient.birth_date > date.today():
            errors.append(f"Birth date is in the future: {patient.birth_date}")
        if patient.phone:
            errors.extend(PatientValidator.validate_phone(patient.phone))
        if patient.email:
            errors.extend(PatientValidator.validate_email(patient.email))
        return errors


class AppointmentValidator:
    @staticmethod
    def validate_slot(slot: TimeSlot) -> list[str]:
        errors: list[str] = []
        if slot.date < date.today():
            errors.append(f"Slot date is in the past: {slot.date}")
        if slot.duration_minutes() < APPOINTMENT_SLOT_MINUTES:
            errors.append(f"Slot duration too short: {slot.duration_minutes()} min")
        return errors

    @staticmethod
    def validate_appointment(appointment: Appointment) -> list[str]:
        errors = AppointmentValidator.validate_slot(appointment.slot)
        if not appointment.reason.strip():
            errors.append("Appointment reason must not be empty")
        return errors


class PrescriptionValidator:
    @staticmethod
    def validate_line(line: PrescriptionLine) -> list[str]:
        errors: list[str] = []
        if not line.dosage.strip():
            errors.append(f"Dosage must not be empty for {line.drug.generic_name}")
        if not line.frequency.strip():
            errors.append(f"Frequency must not be empty for {line.drug.generic_name}")
        if line.duration_days <= 0:
            errors.append(f"Duration must be positive for {line.drug.generic_name}: {line.duration_days}")
        if line.quantity <= 0:
            errors.append(f"Quantity must be positive: {line.quantity}")
        return errors

    @staticmethod
    def validate_prescription(prescription: Prescription) -> list[str]:
        errors: list[str] = []
        if not prescription.lines:
            errors.append("Prescription must have at least one line")
        for line in prescription.lines:
            errors.extend(PrescriptionValidator.validate_line(line))
        allergy_alerts = prescription.check_allergies()
        if allergy_alerts:
            errors.append(f"Allergy conflict: {', '.join(allergy_alerts)}")
        return errors


# ---------------------------------------------------------------------------
# Vital signs analysis
# ---------------------------------------------------------------------------

class VitalSignsAnalyzer:
    @staticmethod
    def classify_bmi(bmi: float) -> str:
        if bmi < 18.5:
            return "underweight"
        if bmi < 25.0:
            return "normal"
        if bmi < 30.0:
            return "overweight"
        return "obese"

    @staticmethod
    def classify_blood_pressure(systolic: int, diastolic: int) -> str:
        if systolic < 120 and diastolic < 80:
            return "normal"
        if systolic < 130 and diastolic < 80:
            return "elevated"
        if systolic < 140 or diastolic < 90:
            return "hypertension_stage1"
        if systolic < 180 and diastolic < 120:
            return "hypertension_stage2"
        return "hypertensive_crisis"

    @staticmethod
    def classify_pulse(pulse: int) -> str:
        if pulse < 40:
            return "severe_bradycardia"
        if pulse < 60:
            return "bradycardia"
        if pulse <= 100:
            return "normal"
        if pulse <= 150:
            return "tachycardia"
        return "severe_tachycardia"

    @staticmethod
    def classify_temperature(temp: float) -> str:
        if temp < 35.0:
            return "hypothermia"
        if temp < 37.5:
            return "normal"
        if temp < 38.0:
            return "low_grade_fever"
        if temp < 39.0:
            return "fever"
        return "high_fever"

    @staticmethod
    def classify_spo2(spo2: float) -> str:
        if spo2 >= 95.0:
            return "normal"
        if spo2 >= 90.0:
            return "mild_hypoxia"
        return "severe_hypoxia"

    @staticmethod
    def full_assessment(vitals: VitalSigns) -> dict:
        result: dict[str, str] = {}
        if vitals.bmi() is not None:
            result["bmi"] = VitalSignsAnalyzer.classify_bmi(vitals.bmi())  # type: ignore[arg-type]
        if vitals.blood_pressure_systolic and vitals.blood_pressure_diastolic:
            result["blood_pressure"] = VitalSignsAnalyzer.classify_blood_pressure(
                vitals.blood_pressure_systolic, vitals.blood_pressure_diastolic
            )
        if vitals.pulse:
            result["pulse"] = VitalSignsAnalyzer.classify_pulse(vitals.pulse)
        if vitals.temperature:
            result["temperature"] = VitalSignsAnalyzer.classify_temperature(vitals.temperature)
        if vitals.spo2:
            result["spo2"] = VitalSignsAnalyzer.classify_spo2(vitals.spo2)
        result["has_critical"] = "yes" if vitals.has_critical_values() else "no"
        return result


# ---------------------------------------------------------------------------
# Drug repository and pharmacy service
# ---------------------------------------------------------------------------

class DrugRepository:
    def __init__(self) -> None:
        self._drugs: dict[str, Drug] = {}
        self._code_index: dict[str, str] = {}  # code -> drug_id

    def add(self, drug: Drug) -> None:
        self._drugs[drug.drug_id] = drug

    def get(self, drug_id: str) -> Drug | None:
        return self._drugs.get(drug_id)

    def get_or_raise(self, drug_id: str) -> Drug:
        d = self.get(drug_id)
        if d is None:
            raise KeyError(f"Drug not found: {drug_id}")
        return d

    def search(self, query: str) -> list[Drug]:
        q = query.lower()
        return [
            d for d in self._drugs.values()
            if q in d.generic_name.lower() or q in d.brand_name.lower()
        ]

    def by_category(self, category: str) -> list[Drug]:
        return [d for d in self._drugs.values() if d.category == category]

    def low_stock(self, threshold: int = 10) -> list[Drug]:
        return [d for d in self._drugs.values() if d.stock <= threshold]

    def all(self) -> list[Drug]:
        return list(self._drugs.values())


class PharmacyService:
    def __init__(
        self,
        drugs: DrugRepository,
        prescriptions: PrescriptionRepository,
        alerts: AlertRepository,
    ) -> None:
        self.drugs = drugs
        self.prescriptions = prescriptions
        self.alerts = alerts

    def dispense(self, prescription_id: str, pharmacist_id: str) -> dict:
        prescription = self.prescriptions.get(prescription_id)
        if prescription is None:
            raise KeyError(f"Prescription not found: {prescription_id}")

        allergy_alerts = prescription.check_allergies()
        if allergy_alerts:
            alert = Alert(
                alert_id=str(uuid.uuid4()),
                level=AlertLevel.CRITICAL,
                title="Allergy Alert - Dispensing Blocked",
                message=f"Cannot dispense: allergy conflict with {', '.join(allergy_alerts)}",
                patient_id=prescription.patient.patient_id,
            )
            self.alerts.add(alert)
            raise ValueError(f"Allergy conflict: {allergy_alerts}")

        stock_issues = []
        for line in prescription.lines:
            drug = self.drugs.get(line.drug.drug_id)
            if drug and drug.stock < line.quantity:
                stock_issues.append(f"{drug.generic_name}: need {line.quantity}, have {drug.stock}")

        if stock_issues:
            raise ValueError(f"Insufficient stock: {'; '.join(stock_issues)}")

        for line in prescription.lines:
            drug = self.drugs.get(line.drug.drug_id)
            if drug:
                drug.stock -= line.quantity

        prescription.dispense(pharmacist_id)
        logger.info("Prescription %s dispensed by %s", prescription_id, pharmacist_id)
        return {
            "prescription_id": prescription_id,
            "dispensed_by": pharmacist_id,
            "dispensed_at": prescription.dispensed_at.isoformat() if prescription.dispensed_at else None,
            "items": len(prescription.lines),
        }

    def low_stock_report(self, threshold: int = 10) -> str:
        low = self.drugs.low_stock(threshold)
        lines = [f"=== Low Stock Alert (threshold={threshold}) ===", ""]
        if not low:
            lines.append("No drugs below threshold.")
        else:
            for drug in sorted(low, key=lambda d: d.stock):
                lines.append(f"  {drug.drug_id}  {drug.generic_name:30s}  stock={drug.stock}")
        return "\n".join(lines)

    def drug_usage_report(self) -> dict:
        usage: dict[str, int] = {}
        for prescription in self.prescriptions.all():
            if prescription.status != PrescriptionStatus.COMPLETED:
                continue
            for line in prescription.lines:
                gn = line.drug.generic_name
                usage[gn] = usage.get(gn, 0) + line.quantity
        return dict(sorted(usage.items(), key=lambda x: x[1], reverse=True))


# ---------------------------------------------------------------------------
# Medical imaging
# ---------------------------------------------------------------------------

class ImagingType(Enum):
    XRAY = "xray"
    CT = "ct"
    MRI = "mri"
    ULTRASOUND = "ultrasound"
    PET = "pet"
    MAMMOGRAPHY = "mammography"


class ImagingStatus(Enum):
    ORDERED = "ordered"
    SCHEDULED = "scheduled"
    PERFORMED = "performed"
    REPORTED = "reported"
    CANCELLED = "cancelled"


@dataclass
class ImagingOrder:
    order_id: str
    patient: Patient
    doctor: Doctor
    imaging_type: ImagingType
    body_part: str
    clinical_indication: str
    ordered_at: datetime = field(default_factory=datetime.now)
    scheduled_at: datetime | None = None
    performed_at: datetime | None = None
    status: ImagingStatus = ImagingStatus.ORDERED
    findings: str = ""
    impression: str = ""
    reported_by: str = ""
    urgent: bool = False

    def schedule(self, dt: datetime) -> None:
        if self.status != ImagingStatus.ORDERED:
            raise ValueError(f"Cannot schedule: status={self.status}")
        self.scheduled_at = dt
        self.status = ImagingStatus.SCHEDULED

    def perform(self) -> None:
        if self.status not in (ImagingStatus.ORDERED, ImagingStatus.SCHEDULED):
            raise ValueError(f"Cannot perform: status={self.status}")
        self.performed_at = datetime.now()
        self.status = ImagingStatus.PERFORMED

    def report(self, findings: str, impression: str, reported_by: str) -> None:
        if self.status != ImagingStatus.PERFORMED:
            raise ValueError(f"Cannot report: status={self.status}")
        self.findings = findings
        self.impression = impression
        self.reported_by = reported_by
        self.status = ImagingStatus.REPORTED

    def to_dict(self) -> dict:
        return {
            "order_id": self.order_id,
            "patient_id": self.patient.patient_id,
            "type": self.imaging_type.value,
            "body_part": self.body_part,
            "status": self.status.value,
            "urgent": self.urgent,
        }


class ImagingRepository:
    def __init__(self) -> None:
        self._orders: dict[str, ImagingOrder] = {}

    def add(self, order: ImagingOrder) -> None:
        self._orders[order.order_id] = order

    def get(self, order_id: str) -> ImagingOrder | None:
        return self._orders.get(order_id)

    def get_or_raise(self, order_id: str) -> ImagingOrder:
        o = self.get(order_id)
        if o is None:
            raise KeyError(f"ImagingOrder not found: {order_id}")
        return o

    def by_patient(self, patient_id: str) -> list[ImagingOrder]:
        return [o for o in self._orders.values() if o.patient.patient_id == patient_id]

    def by_status(self, status: ImagingStatus) -> list[ImagingOrder]:
        return [o for o in self._orders.values() if o.status == status]

    def urgent_pending(self) -> list[ImagingOrder]:
        return [
            o for o in self._orders.values()
            if o.urgent and o.status not in (ImagingStatus.REPORTED, ImagingStatus.CANCELLED)
        ]

    def all(self) -> list[ImagingOrder]:
        return list(self._orders.values())


class ImagingService:
    def __init__(
        self,
        imaging: ImagingRepository,
        patients: PatientRepository,
        alerts: AlertRepository,
    ) -> None:
        self.imaging = imaging
        self.patients = patients
        self.alerts = alerts

    def order(
        self,
        patient_id: str,
        doctor: Doctor,
        imaging_type: ImagingType,
        body_part: str,
        indication: str,
        urgent: bool = False,
    ) -> ImagingOrder:
        patient = self.patients.get_or_raise(patient_id)
        order = ImagingOrder(
            order_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            imaging_type=imaging_type,
            body_part=body_part,
            clinical_indication=indication,
            urgent=urgent,
        )
        self.imaging.add(order)
        if urgent:
            alert = Alert(
                alert_id=str(uuid.uuid4()),
                level=AlertLevel.WARNING,
                title=f"Urgent Imaging: {imaging_type.value.upper()}",
                message=f"Urgent {imaging_type.value} ordered for {patient.name} — {body_part}",
                patient_id=patient_id,
            )
            self.alerts.add(alert)
        logger.info("Imaging order %s: %s %s for patient %s", order.order_id, imaging_type.value, body_part, patient_id)
        return order

    def report(self, order_id: str, findings: str, impression: str, radiologist_id: str) -> None:
        order = self.imaging.get_or_raise(order_id)
        order.report(findings, impression, radiologist_id)
        logger.info("Imaging report filed for order %s by %s", order_id, radiologist_id)

    def worklist(self) -> list[ImagingOrder]:
        return sorted(
            self.imaging.by_status(ImagingStatus.PERFORMED),
            key=lambda o: (not o.urgent, o.performed_at or datetime.min),
        )

    def turnaround_stats(self) -> dict:
        reported = self.imaging.by_status(ImagingStatus.REPORTED)
        if not reported:
            return {"count": 0}
        turnarounds = []
        for order in reported:
            if order.ordered_at and order.performed_at:
                delta = (order.performed_at - order.ordered_at).total_seconds() / 3600
                turnarounds.append(delta)
        avg = sum(turnarounds) / len(turnarounds) if turnarounds else 0.0
        return {
            "count": len(reported),
            "avg_hours_to_perform": round(avg, 1),
            "urgent_pending": len(self.imaging.urgent_pending()),
        }


# ---------------------------------------------------------------------------
# Surgery scheduling
# ---------------------------------------------------------------------------

class SurgeryType(Enum):
    ELECTIVE = "elective"
    URGENT = "urgent"
    EMERGENCY = "emergency"


class SurgeryStatus(Enum):
    SCHEDULED = "scheduled"
    PREP = "prep"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    POSTPONED = "postponed"


@dataclass
class Surgery:
    surgery_id: str
    patient: Patient
    lead_surgeon: Doctor
    assistant_surgeons: list[Doctor]
    surgery_type: SurgeryType
    procedure_name: str
    scheduled_at: datetime
    estimated_duration_hours: float
    operating_room: str
    anesthesia_type: str = ""
    status: SurgeryStatus = SurgeryStatus.SCHEDULED
    started_at: datetime | None = None
    finished_at: datetime | None = None
    pre_op_notes: str = ""
    post_op_notes: str = ""
    complications: str = ""

    def start(self) -> None:
        if self.status not in (SurgeryStatus.SCHEDULED, SurgeryStatus.PREP):
            raise ValueError(f"Cannot start surgery: status={self.status}")
        self.status = SurgeryStatus.IN_PROGRESS
        self.started_at = datetime.now()

    def complete(self, post_op_notes: str = "", complications: str = "") -> None:
        if self.status != SurgeryStatus.IN_PROGRESS:
            raise ValueError(f"Cannot complete surgery: status={self.status}")
        self.status = SurgeryStatus.COMPLETED
        self.finished_at = datetime.now()
        self.post_op_notes = post_op_notes
        self.complications = complications

    def cancel(self, reason: str = "") -> None:
        if self.status in (SurgeryStatus.IN_PROGRESS, SurgeryStatus.COMPLETED):
            raise ValueError(f"Cannot cancel surgery in state: {self.status}")
        self.status = SurgeryStatus.CANCELLED
        if reason:
            self.pre_op_notes += f"\nCancelled: {reason}"

    def duration_actual(self) -> float | None:
        if self.started_at and self.finished_at:
            return (self.finished_at - self.started_at).total_seconds() / 3600
        return None

    def to_dict(self) -> dict:
        return {
            "surgery_id": self.surgery_id,
            "patient_id": self.patient.patient_id,
            "surgeon_id": self.lead_surgeon.doctor_id,
            "procedure": self.procedure_name,
            "type": self.surgery_type.value,
            "status": self.status.value,
            "scheduled_at": self.scheduled_at.isoformat(),
        }


class SurgeryRepository:
    def __init__(self) -> None:
        self._surgeries: dict[str, Surgery] = {}

    def add(self, surgery: Surgery) -> None:
        self._surgeries[surgery.surgery_id] = surgery

    def get(self, surgery_id: str) -> Surgery | None:
        return self._surgeries.get(surgery_id)

    def get_or_raise(self, surgery_id: str) -> Surgery:
        s = self.get(surgery_id)
        if s is None:
            raise KeyError(f"Surgery not found: {surgery_id}")
        return s

    def by_patient(self, patient_id: str) -> list[Surgery]:
        return [s for s in self._surgeries.values() if s.patient.patient_id == patient_id]

    def by_surgeon(self, doctor_id: str) -> list[Surgery]:
        return [
            s for s in self._surgeries.values()
            if s.lead_surgeon.doctor_id == doctor_id
            or any(a.doctor_id == doctor_id for a in s.assistant_surgeons)
        ]

    def by_date(self, target_date: date) -> list[Surgery]:
        return [s for s in self._surgeries.values() if s.scheduled_at.date() == target_date]

    def by_or(self, operating_room: str) -> list[Surgery]:
        return [s for s in self._surgeries.values() if s.operating_room == operating_room]

    def in_progress(self) -> list[Surgery]:
        return [s for s in self._surgeries.values() if s.status == SurgeryStatus.IN_PROGRESS]

    def all(self) -> list[Surgery]:
        return list(self._surgeries.values())


class SurgeryService:
    def __init__(
        self,
        surgeries: SurgeryRepository,
        patients: PatientRepository,
        admissions: AdmissionRepository,
        alerts: AlertRepository,
    ) -> None:
        self.surgeries = surgeries
        self.patients = patients
        self.admissions = admissions
        self.alerts = alerts

    def schedule(
        self,
        patient_id: str,
        surgeon: Doctor,
        assistants: list[Doctor],
        surgery_type: SurgeryType,
        procedure: str,
        scheduled_at: datetime,
        duration_hours: float,
        operating_room: str,
        anesthesia: str = "",
    ) -> Surgery:
        patient = self.patients.get_or_raise(patient_id)
        existing_on_date = self.surgeries.by_or(operating_room)
        for s in existing_on_date:
            if s.scheduled_at.date() == scheduled_at.date() and s.status not in (SurgeryStatus.CANCELLED, SurgeryStatus.POSTPONED):
                end_time = s.scheduled_at + timedelta(hours=s.estimated_duration_hours)
                new_end = scheduled_at + timedelta(hours=duration_hours)
                if s.scheduled_at < new_end and scheduled_at < end_time:
                    raise ValueError(f"OR {operating_room} conflict with surgery {s.surgery_id}")

        surgery = Surgery(
            surgery_id=str(uuid.uuid4()),
            patient=patient,
            lead_surgeon=surgeon,
            assistant_surgeons=assistants,
            surgery_type=surgery_type,
            procedure_name=procedure,
            scheduled_at=scheduled_at,
            estimated_duration_hours=duration_hours,
            operating_room=operating_room,
            anesthesia_type=anesthesia,
        )
        self.surgeries.add(surgery)

        if surgery_type == SurgeryType.EMERGENCY:
            alert = Alert(
                alert_id=str(uuid.uuid4()),
                level=AlertLevel.CRITICAL,
                title="Emergency Surgery Scheduled",
                message=f"Emergency {procedure} for patient {patient.name} in OR {operating_room}",
                patient_id=patient_id,
            )
            self.alerts.add(alert)

        logger.info(
            "Surgery scheduled: %s %s for %s at %s OR=%s",
            surgery.surgery_id, procedure, patient_id, scheduled_at, operating_room,
        )
        return surgery

    def or_schedule(self, target_date: date) -> dict[str, list[Surgery]]:
        schedule: dict[str, list[Surgery]] = {}
        for surgery in self.surgeries.by_date(target_date):
            schedule.setdefault(surgery.operating_room, []).append(surgery)
        return {or_: sorted(sched, key=lambda s: s.scheduled_at) for or_, sched in schedule.items()}

    def surgeon_workload(self) -> dict[str, int]:
        counts: dict[str, int] = {}
        for surgery in self.surgeries.all():
            if surgery.status == SurgeryStatus.COMPLETED:
                sid = surgery.lead_surgeon.doctor_id
                counts[sid] = counts.get(sid, 0) + 1
        return dict(sorted(counts.items(), key=lambda x: x[1], reverse=True))

    def complication_rate(self) -> float:
        completed = [s for s in self.surgeries.all() if s.status == SurgeryStatus.COMPLETED]
        if not completed:
            return 0.0
        with_complications = sum(1 for s in completed if s.complications.strip())
        return with_complications / len(completed)


# ---------------------------------------------------------------------------
# Patient transfer
# ---------------------------------------------------------------------------

class TransferReason(Enum):
    HIGHER_CARE = "higher_care"
    SPECIALIST = "specialist"
    PATIENT_REQUEST = "patient_request"
    BED_SHORTAGE = "bed_shortage"
    OTHER = "other"


@dataclass
class PatientTransfer:
    transfer_id: str
    patient: Patient
    from_ward: Ward
    to_ward: Ward
    reason: TransferReason
    requested_by: str
    approved_by: str | None = None
    requested_at: datetime = field(default_factory=datetime.now)
    transferred_at: datetime | None = None
    notes: str = ""
    completed: bool = False

    def approve(self, approver_id: str) -> None:
        self.approved_by = approver_id

    def complete(self) -> None:
        if not self.approved_by:
            raise ValueError(f"Transfer {self.transfer_id} not approved")
        self.transferred_at = datetime.now()
        self.completed = True

    def to_dict(self) -> dict:
        return {
            "transfer_id": self.transfer_id,
            "patient_id": self.patient.patient_id,
            "from_ward": self.from_ward.name,
            "to_ward": self.to_ward.name,
            "reason": self.reason.value,
            "completed": self.completed,
        }


class TransferRepository:
    def __init__(self) -> None:
        self._transfers: dict[str, PatientTransfer] = {}

    def add(self, transfer: PatientTransfer) -> None:
        self._transfers[transfer.transfer_id] = transfer

    def get(self, transfer_id: str) -> PatientTransfer | None:
        return self._transfers.get(transfer_id)

    def pending(self) -> list[PatientTransfer]:
        return [t for t in self._transfers.values() if not t.completed]

    def by_patient(self, patient_id: str) -> list[PatientTransfer]:
        return [t for t in self._transfers.values() if t.patient.patient_id == patient_id]

    def all(self) -> list[PatientTransfer]:
        return list(self._transfers.values())


# ---------------------------------------------------------------------------
# Discharge planning
# ---------------------------------------------------------------------------

class DischargeStatus(Enum):
    PLANNING = "planning"
    READY = "ready"
    DISCHARGED = "discharged"
    DELAYED = "delayed"


@dataclass
class DischargePlan:
    plan_id: str
    patient: Patient
    doctor: Doctor
    admission: Admission
    target_date: date
    status: DischargeStatus = DischargeStatus.PLANNING
    follow_up_instructions: str = ""
    medications_on_discharge: list[str] = field(default_factory=list)
    referrals: list[str] = field(default_factory=list)
    home_care_required: bool = False
    created_at: datetime = field(default_factory=datetime.now)
    updated_at: datetime = field(default_factory=datetime.now)

    def mark_ready(self) -> None:
        self.status = DischargeStatus.READY
        self.updated_at = datetime.now()

    def delay(self, reason: str) -> None:
        self.status = DischargeStatus.DELAYED
        self.follow_up_instructions += f"\nDelayed: {reason}"
        self.updated_at = datetime.now()

    def complete(self) -> None:
        self.status = DischargeStatus.DISCHARGED
        self.updated_at = datetime.now()

    def to_dict(self) -> dict:
        return {
            "plan_id": self.plan_id,
            "patient_id": self.patient.patient_id,
            "target_date": self.target_date.isoformat(),
            "status": self.status.value,
            "home_care_required": self.home_care_required,
        }


class DischargePlanRepository:
    def __init__(self) -> None:
        self._plans: dict[str, DischargePlan] = {}

    def add(self, plan: DischargePlan) -> None:
        self._plans[plan.plan_id] = plan

    def get(self, plan_id: str) -> DischargePlan | None:
        return self._plans.get(plan_id)

    def by_patient(self, patient_id: str) -> list[DischargePlan]:
        return [p for p in self._plans.values() if p.patient.patient_id == patient_id]

    def ready_today(self) -> list[DischargePlan]:
        today = date.today()
        return [p for p in self._plans.values() if p.target_date == today and p.status == DischargeStatus.READY]

    def all(self) -> list[DischargePlan]:
        return list(self._plans.values())


# ---------------------------------------------------------------------------
# Clinical decision support
# ---------------------------------------------------------------------------

class ClinicalAlert:
    """Rule-based decision support checks."""

    @staticmethod
    def check_drug_interactions(prescription: Prescription, other_prescriptions: list[Prescription]) -> list[str]:
        active_drugs = {
            line.drug.drug_id
            for p in other_prescriptions
            if p.is_valid() and p.prescription_id != prescription.prescription_id
            for line in p.lines
        }
        new_drugs = {line.drug.drug_id for line in prescription.lines}
        interactions = []
        KNOWN_INTERACTIONS: dict[frozenset, str] = {
            # Placeholder: in real systems, this would be a full drug interaction DB
        }
        for pair, description in KNOWN_INTERACTIONS.items():
            if pair.issubset(active_drugs | new_drugs) and bool(pair & new_drugs):
                interactions.append(description)
        return interactions

    @staticmethod
    def check_duplicate_orders(new_order: LabOrder, existing_orders: list[LabOrder]) -> list[str]:
        warnings = []
        for order in existing_orders:
            if order.status == LabTestStatus.ORDERED or order.status == LabTestStatus.SAMPLE_COLLECTED:
                overlap = {t.code for t in order.tests} & {t.code for t in new_order.tests}
                if overlap:
                    warnings.append(f"Duplicate test(s) already ordered: {', '.join(overlap)} in {order.order_id[:8]}")
        return warnings

    @staticmethod
    def check_age_restrictions(drug: Drug, patient: Patient) -> list[str]:
        warnings = []
        age = patient.age()
        if "pediatric" in drug.category.lower() and age > 18:
            warnings.append(f"{drug.generic_name} is for pediatric use only (patient age: {age})")
        if "geriatric_caution" in drug.contraindications and age < 65:
            pass
        return warnings

    @staticmethod
    def check_pregnancy_precautions(prescription: Prescription) -> list[str]:
        warnings = []
        if prescription.patient.gender != Gender.FEMALE:
            return warnings
        for line in prescription.lines:
            if "pregnancy_risk" in line.drug.contraindications:
                warnings.append(f"{line.drug.generic_name}: pregnancy risk — confirm patient is not pregnant")
        return warnings


# ---------------------------------------------------------------------------
# Statistics and analytics
# ---------------------------------------------------------------------------

def appointment_statistics(appointments: list[Appointment]) -> dict:
    total = len(appointments)
    if not total:
        return {"total": 0}
    status_counts: dict[str, int] = {}
    dept_counts: dict[str, int] = {}
    for a in appointments:
        status_counts[a.status.value] = status_counts.get(a.status.value, 0) + 1
        dept_counts[a.department.value] = dept_counts.get(a.department.value, 0) + 1
    no_show_rate = status_counts.get(AppointmentStatus.NO_SHOW.value, 0) / total
    cancel_rate = status_counts.get(AppointmentStatus.CANCELLED.value, 0) / total
    return {
        "total": total,
        "by_status": status_counts,
        "by_department": dept_counts,
        "no_show_rate": round(no_show_rate, 3),
        "cancellation_rate": round(cancel_rate, 3),
    }


def admission_statistics(admissions: list[Admission]) -> dict:
    if not admissions:
        return {"total": 0}
    active = [a for a in admissions if a.status == AdmissionStatus.ADMITTED]
    discharged = [a for a in admissions if a.status == AdmissionStatus.DISCHARGED]
    avg_stay = (
        sum(a.days_admitted() for a in discharged) / len(discharged)
        if discharged else 0.0
    )
    return {
        "total": len(admissions),
        "active": len(active),
        "discharged": len(discharged),
        "avg_length_of_stay_days": round(avg_stay, 1),
    }


def billing_statistics(invoices: list[Invoice]) -> dict:
    if not invoices:
        return {"total": 0}
    total_billed = sum(i.gross_total.amount for i in invoices if i.status != InvoiceStatus.CANCELLED)
    paid = [i for i in invoices if i.status == InvoiceStatus.PAID]
    total_paid = sum(i.paid_amount.amount for i in paid)
    overdue = [i for i in invoices if i.status == InvoiceStatus.OVERDUE]
    total_overdue = sum(i.patient_due.amount for i in overdue)
    return {
        "total_invoices": len(invoices),
        "paid_count": len(paid),
        "total_billed": total_billed,
        "total_collected": total_paid,
        "overdue_count": len(overdue),
        "total_overdue": total_overdue,
        "collection_rate": round(total_paid / total_billed, 3) if total_billed else 0.0,
    }


def patient_demographics(patients: list[Patient]) -> dict:
    if not patients:
        return {"total": 0}
    ages = [p.age() for p in patients]
    gender_dist: dict[str, int] = {}
    blood_dist: dict[str, int] = {}
    insurance_dist: dict[str, int] = {}
    for p in patients:
        gender_dist[p.gender.value] = gender_dist.get(p.gender.value, 0) + 1
        blood_dist[p.blood_type.value] = blood_dist.get(p.blood_type.value, 0) + 1
        ins_type = p.insurance.insurance_type.value if p.insurance else "none"
        insurance_dist[ins_type] = insurance_dist.get(ins_type, 0) + 1
    return {
        "total": len(patients),
        "avg_age": round(sum(ages) / len(ages), 1),
        "min_age": min(ages),
        "max_age": max(ages),
        "gender_distribution": gender_dist,
        "blood_type_distribution": blood_dist,
        "insurance_distribution": insurance_dist,
    }


# ---------------------------------------------------------------------------
# Extended report generator
# ---------------------------------------------------------------------------

class ExtendedReporter(HospitalReporter):
    def __init__(self, system: HospitalSystem, imaging: ImagingRepository, surgeries: SurgeryRepository) -> None:
        super().__init__(system)
        self.imaging = imaging
        self.surgeries = surgeries

    def imaging_worklist(self) -> str:
        pending = [o for o in self.imaging.by_status(ImagingStatus.PERFORMED)]
        urgent_first = sorted(pending, key=lambda o: (not o.urgent, o.performed_at or datetime.min))
        lines = [f"=== Imaging Worklist ({len(urgent_first)} pending) ===", ""]
        for order in urgent_first:
            urg = "[URGENT] " if order.urgent else "        "
            lines.append(
                f"  {urg}{order.order_id[:8]}  "
                f"{order.imaging_type.value:12s}  "
                f"{order.body_part:20s}  "
                f"patient={order.patient.name}"
            )
        return "\n".join(lines)

    def surgical_schedule(self, target_date: date) -> str:
        surgeries_on_date = sorted(
            [s for s in self.surgeries.all() if s.scheduled_at.date() == target_date],
            key=lambda s: (s.operating_room, s.scheduled_at),
        )
        lines = [f"=== Surgical Schedule: {target_date} ===", f"Total: {len(surgeries_on_date)}", ""]
        current_or = ""
        for surgery in surgeries_on_date:
            if surgery.operating_room != current_or:
                current_or = surgery.operating_room
                lines.append(f"  [{current_or}]")
            lines.append(
                f"    {surgery.scheduled_at.strftime('%H:%M')}  "
                f"{surgery.procedure_name:30s}  "
                f"patient={surgery.patient.name:15s}  "
                f"surgeon={surgery.lead_surgeon.name}  "
                f"[{surgery.surgery_type.value}]"
            )
        return "\n".join(lines)

    def patient_full_summary(self, patient_id: str) -> str:
        base = self.patient_summary(patient_id)
        imaging_orders = self.imaging.by_patient(patient_id)
        surgery_history = self.surgeries.by_patient(patient_id)
        lines = [base, "", f"Imaging orders: {len(imaging_orders)}"]
        for order in imaging_orders[-3:]:
            lines.append(f"  {order.order_id[:8]}  {order.imaging_type.value}  {order.body_part}  [{order.status.value}]")
        lines.append(f"\nSurgery history: {len(surgery_history)}")
        for surgery in surgery_history[-3:]:
            lines.append(f"  {surgery.scheduled_at.date()}  {surgery.procedure_name}  [{surgery.status.value}]")
        return "\n".join(lines)

    def kpi_dashboard(self) -> str:
        all_appts = self.system.appointments.all()
        all_admissions = self.system.admissions.all()
        all_invoices = self.system.invoices.all()
        all_patients = self.system.patients.all()

        appt_stats = appointment_statistics(all_appts)
        admit_stats = admission_statistics(all_admissions)
        billing_stats = billing_statistics(all_invoices)
        demo_stats = patient_demographics(all_patients)

        lines = [
            "=" * 60,
            "HOSPITAL KPI DASHBOARD",
            f"Generated: {datetime.now().isoformat()}",
            "=" * 60,
            "",
            "--- Appointments ---",
            f"  Total              : {appt_stats.get('total', 0)}",
            f"  No-show rate       : {appt_stats.get('no_show_rate', 0):.1%}",
            f"  Cancellation rate  : {appt_stats.get('cancellation_rate', 0):.1%}",
            "",
            "--- Admissions ---",
            f"  Total              : {admit_stats.get('total', 0)}",
            f"  Currently admitted : {admit_stats.get('active', 0)}",
            f"  Avg length of stay : {admit_stats.get('avg_length_of_stay_days', 0):.1f} days",
            "",
            "--- Billing ---",
            f"  Total invoices     : {billing_stats.get('total_invoices', 0)}",
            f"  Collection rate    : {billing_stats.get('collection_rate', 0):.1%}",
            f"  Overdue invoices   : {billing_stats.get('overdue_count', 0)}",
            "",
            "--- Patients ---",
            f"  Total registered   : {demo_stats.get('total', 0)}",
            f"  Average age        : {demo_stats.get('avg_age', 0):.1f} years",
            "",
            "--- Alerts ---",
            f"  Critical unacked   : {len(self.system.alerts.unacknowledged(AlertLevel.CRITICAL))}",
            f"  Warning unacked    : {len(self.system.alerts.unacknowledged(AlertLevel.WARNING))}",
        ]
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Access control
# ---------------------------------------------------------------------------

class Role(Enum):
    ADMIN = "admin"
    DOCTOR = "doctor"
    NURSE = "nurse"
    RECEPTIONIST = "receptionist"
    PHARMACIST = "pharmacist"
    RADIOLOGIST = "radiologist"
    BILLING_STAFF = "billing_staff"
    READ_ONLY = "read_only"


ROLE_PERMISSIONS: dict[Role, set[str]] = {
    Role.ADMIN: {"*"},
    Role.DOCTOR: {"patient:read", "patient:write", "record:read", "record:write", "prescription:write", "lab:write", "imaging:write", "appointment:read", "appointment:write"},
    Role.NURSE: {"patient:read", "vital:write", "record:read", "appointment:read", "appointment:write"},
    Role.RECEPTIONIST: {"patient:read", "patient:write", "appointment:read", "appointment:write", "invoice:read"},
    Role.PHARMACIST: {"prescription:read", "prescription:dispense", "drug:read", "drug:write"},
    Role.RADIOLOGIST: {"imaging:read", "imaging:report", "patient:read"},
    Role.BILLING_STAFF: {"invoice:read", "invoice:write", "patient:read"},
    Role.READ_ONLY: {"patient:read", "record:read", "appointment:read"},
}


@dataclass
class SystemUser:
    user_id: str
    username: str
    role: Role
    linked_id: str | None = None  # doctor_id, nurse_id, etc.
    active: bool = True
    _password_hash: str = field(default="", repr=False)

    def set_password(self, password: str) -> None:
        if len(password) < MIN_PASSWORD_LENGTH:
            raise ValueError(f"Password must be at least {MIN_PASSWORD_LENGTH} characters")
        self._password_hash = hashlib.sha256(password.encode()).hexdigest()

    def check_password(self, password: str) -> bool:
        return self._password_hash == hashlib.sha256(password.encode()).hexdigest()

    def has_permission(self, permission: str) -> bool:
        perms = ROLE_PERMISSIONS.get(self.role, set())
        return "*" in perms or permission in perms


class UserRepository:
    def __init__(self) -> None:
        self._users: dict[str, SystemUser] = {}
        self._username_index: dict[str, str] = {}

    def add(self, user: SystemUser) -> None:
        if user.username in self._username_index:
            raise ValueError(f"Username already taken: {user.username}")
        self._users[user.user_id] = user
        self._username_index[user.username] = user.user_id

    def get(self, user_id: str) -> SystemUser | None:
        return self._users.get(user_id)

    def by_username(self, username: str) -> SystemUser | None:
        uid = self._username_index.get(username)
        return self._users.get(uid) if uid else None

    def by_role(self, role: Role) -> list[SystemUser]:
        return [u for u in self._users.values() if u.role == role]

    def all(self) -> list[SystemUser]:
        return list(self._users.values())


class AuthService:
    def __init__(self, users: UserRepository) -> None:
        self.users = users
        self._sessions: dict[str, str] = {}  # token -> user_id

    def login(self, username: str, password: str) -> str:
        user = self.users.by_username(username)
        if user is None or not user.active:
            raise ValueError("Invalid credentials")
        if not user.check_password(password):
            raise ValueError("Invalid credentials")
        token = hashlib.sha256(f"{user.user_id}:{datetime.now().isoformat()}".encode()).hexdigest()
        self._sessions[token] = user.user_id
        logger.info("User %s logged in", username)
        return token

    def logout(self, token: str) -> None:
        self._sessions.pop(token, None)

    def get_user(self, token: str) -> SystemUser | None:
        user_id = self._sessions.get(token)
        if user_id is None:
            return None
        return self.users.get(user_id)

    def require_permission(self, token: str, permission: str) -> SystemUser:
        user = self.get_user(token)
        if user is None:
            raise PermissionError("Not authenticated")
        if not user.has_permission(permission):
            raise PermissionError(f"Permission denied: {permission}")
        return user


# ---------------------------------------------------------------------------
# Full system health check
# ---------------------------------------------------------------------------

def full_system_health(system: HospitalSystem) -> dict:
    patients = system.patients.all()
    doctors = system.doctors.all()
    appointments = system.appointments.all()
    admissions = system.admissions.all()
    alerts_critical = system.alerts.unacknowledged(AlertLevel.CRITICAL)
    alerts_warning = system.alerts.unacknowledged(AlertLevel.WARNING)
    invoices = system.invoices.all()
    overdue_invoices = [i for i in invoices if i.status == InvoiceStatus.OVERDUE]

    today_appts = [a for a in appointments if a.slot.date == date.today()]
    active_admissions = [a for a in admissions if a.status == AdmissionStatus.ADMITTED]

    return {
        "status": "ok",
        "patients_total": len(patients),
        "active_patients": len([p for p in patients if p.active]),
        "doctors_total": len(doctors),
        "active_doctors": len([d for d in doctors if d.active]),
        "appointments_today": len(today_appts),
        "inpatients": len(active_admissions),
        "critical_alerts": len(alerts_critical),
        "warning_alerts": len(alerts_warning),
        "overdue_invoices": len(overdue_invoices),
        "checked_at": datetime.now().isoformat(),
    }


# ---------------------------------------------------------------------------
# Scheduling and resource management
# ---------------------------------------------------------------------------

class ResourceType(Enum):
    EXAMINATION_ROOM = "examination_room"
    OPERATING_ROOM = "operating_room"
    MRI_MACHINE = "mri_machine"
    CT_MACHINE = "ct_machine"
    XRAY_UNIT = "xray_unit"
    ULTRASOUND_UNIT = "ultrasound_unit"
    DIALYSIS_UNIT = "dialysis_unit"
    ENDOSCOPY_UNIT = "endoscopy_unit"


@dataclass
class HospitalResource:
    resource_id: str
    resource_type: ResourceType
    name: str
    location: str
    department: Department | None = None
    active: bool = True
    maintenance_due: date | None = None
    notes: str = ""

    def needs_maintenance(self) -> bool:
        return self.maintenance_due is not None and self.maintenance_due <= date.today()

    def to_dict(self) -> dict:
        return {
            "resource_id": self.resource_id,
            "type": self.resource_type.value,
            "name": self.name,
            "location": self.location,
            "active": self.active,
        }


@dataclass
class ResourceBooking:
    booking_id: str
    resource: HospitalResource
    booked_by: str
    slot: TimeSlot
    purpose: str = ""
    cancelled: bool = False
    cancelled_at: datetime | None = None

    def cancel(self) -> None:
        self.cancelled = True
        self.cancelled_at = datetime.now()

    def to_dict(self) -> dict:
        return {
            "booking_id": self.booking_id,
            "resource_id": self.resource.resource_id,
            "slot": str(self.slot),
            "purpose": self.purpose,
            "cancelled": self.cancelled,
        }


class ResourceRepository:
    def __init__(self) -> None:
        self._resources: dict[str, HospitalResource] = {}

    def add(self, resource: HospitalResource) -> None:
        self._resources[resource.resource_id] = resource

    def get(self, resource_id: str) -> HospitalResource | None:
        return self._resources.get(resource_id)

    def by_type(self, resource_type: ResourceType) -> list[HospitalResource]:
        return [r for r in self._resources.values() if r.resource_type == resource_type and r.active]

    def needing_maintenance(self) -> list[HospitalResource]:
        return [r for r in self._resources.values() if r.needs_maintenance()]

    def all(self) -> list[HospitalResource]:
        return list(self._resources.values())


class BookingRepository:
    def __init__(self) -> None:
        self._bookings: dict[str, ResourceBooking] = {}

    def add(self, booking: ResourceBooking) -> None:
        self._bookings[booking.booking_id] = booking

    def get(self, booking_id: str) -> ResourceBooking | None:
        return self._bookings.get(booking_id)

    def active_for_resource(self, resource_id: str, on_date: date) -> list[ResourceBooking]:
        return [
            b for b in self._bookings.values()
            if b.resource.resource_id == resource_id
            and b.slot.date == on_date
            and not b.cancelled
        ]

    def all(self) -> list[ResourceBooking]:
        return list(self._bookings.values())


class ResourceScheduler:
    def __init__(self, resources: ResourceRepository, bookings: BookingRepository) -> None:
        self.resources = resources
        self.bookings = bookings

    def book(
        self,
        resource_id: str,
        booked_by: str,
        slot: TimeSlot,
        purpose: str = "",
    ) -> ResourceBooking:
        resource = self.resources.get(resource_id)
        if resource is None:
            raise KeyError(f"Resource not found: {resource_id}")
        if not resource.active:
            raise ValueError(f"Resource {resource_id} is not active")

        existing = self.bookings.active_for_resource(resource_id, slot.date)
        for b in existing:
            if b.slot.overlaps(slot):
                raise ValueError(f"Resource {resource_id} already booked for {b.slot}")

        booking = ResourceBooking(
            booking_id=str(uuid.uuid4()),
            resource=resource,
            booked_by=booked_by,
            slot=slot,
            purpose=purpose,
        )
        self.bookings.add(booking)
        logger.info("Resource %s booked by %s for %s", resource_id, booked_by, slot)
        return booking

    def cancel_booking(self, booking_id: str) -> None:
        booking = self.bookings.get(booking_id)
        if booking is None:
            raise KeyError(f"Booking not found: {booking_id}")
        booking.cancel()

    def daily_utilization(self, resource_id: str, target_date: date) -> float:
        bookings = self.bookings.active_for_resource(resource_id, target_date)
        total_minutes = sum(b.slot.duration_minutes() for b in bookings)
        working_hours = 8 * 60  # 8-hour working day
        return min(total_minutes / working_hours, 1.0)

    def maintenance_report(self) -> str:
        needing = self.resources.needing_maintenance()
        lines = [f"=== Resources Needing Maintenance ({len(needing)}) ===", ""]
        for r in needing:
            lines.append(f"  {r.resource_id}  {r.name:20s}  due={r.maintenance_due}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Patient feedback system
# ---------------------------------------------------------------------------

class FeedbackCategory(Enum):
    WAIT_TIME = "wait_time"
    STAFF_ATTITUDE = "staff_attitude"
    FACILITY_CLEANLINESS = "facility_cleanliness"
    TREATMENT_QUALITY = "treatment_quality"
    COMMUNICATION = "communication"
    BILLING = "billing"
    OVERALL = "overall"


@dataclass
class PatientFeedback:
    feedback_id: str
    patient_id: str | None
    appointment_id: str | None
    category: FeedbackCategory
    rating: int  # 1–5
    comment: str = ""
    submitted_at: datetime = field(default_factory=datetime.now)
    anonymous: bool = False
    response: str = ""
    responded_by: str = ""
    responded_at: datetime | None = None

    def __post_init__(self) -> None:
        if not 1 <= self.rating <= 5:
            raise ValueError(f"Rating must be 1–5: {self.rating}")

    def respond(self, response: str, staff_id: str) -> None:
        self.response = response
        self.responded_by = staff_id
        self.responded_at = datetime.now()

    def to_dict(self) -> dict:
        return {
            "feedback_id": self.feedback_id,
            "category": self.category.value,
            "rating": self.rating,
            "comment": self.comment[:100],
            "anonymous": self.anonymous,
            "responded": bool(self.response),
        }


class FeedbackRepository:
    def __init__(self) -> None:
        self._feedbacks: dict[str, PatientFeedback] = {}

    def add(self, feedback: PatientFeedback) -> None:
        self._feedbacks[feedback.feedback_id] = feedback

    def by_category(self, category: FeedbackCategory) -> list[PatientFeedback]:
        return [f for f in self._feedbacks.values() if f.category == category]

    def unresponded(self) -> list[PatientFeedback]:
        return [f for f in self._feedbacks.values() if not f.response and not f.anonymous]

    def average_rating(self, category: FeedbackCategory | None = None) -> float:
        feedbacks = self.by_category(category) if category else list(self._feedbacks.values())
        if not feedbacks:
            return 0.0
        return sum(f.rating for f in feedbacks) / len(feedbacks)

    def all(self) -> list[PatientFeedback]:
        return list(self._feedbacks.values())


class FeedbackService:
    def __init__(self, feedbacks: FeedbackRepository) -> None:
        self.feedbacks = feedbacks

    def submit(
        self,
        patient_id: str | None,
        category: FeedbackCategory,
        rating: int,
        comment: str = "",
        anonymous: bool = False,
        appointment_id: str | None = None,
    ) -> PatientFeedback:
        feedback = PatientFeedback(
            feedback_id=str(uuid.uuid4()),
            patient_id=None if anonymous else patient_id,
            appointment_id=appointment_id,
            category=category,
            rating=rating,
            comment=comment,
            anonymous=anonymous,
        )
        self.feedbacks.add(feedback)
        logger.info("Feedback submitted: %s rating=%d", category.value, rating)
        return feedback

    def respond(self, feedback_id: str, response: str, staff_id: str) -> None:
        feedback = self.feedbacks._feedbacks.get(feedback_id)
        if feedback is None:
            raise KeyError(f"Feedback not found: {feedback_id}")
        feedback.respond(response, staff_id)

    def satisfaction_report(self) -> str:
        lines = ["=== Patient Satisfaction Report ===", ""]
        overall_avg = self.feedbacks.average_rating()
        lines.append(f"Overall average: {overall_avg:.2f}/5.0")
        lines.append(f"Total responses: {len(self.feedbacks.all())}")
        lines.append(f"Awaiting response: {len(self.feedbacks.unresponded())}")
        lines.append("")
        for category in FeedbackCategory:
            avg = self.feedbacks.average_rating(category)
            count = len(self.feedbacks.by_category(category))
            if count == 0:
                continue
            bar = "*" * int(avg * 2)
            lines.append(f"  {category.value:25s}: {avg:.2f}  ({count})  {bar}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Outbreak / infection control
# ---------------------------------------------------------------------------

class InfectionRisk(Enum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"
    CRITICAL = "critical"


@dataclass
class InfectionEvent:
    event_id: str
    pathogen: str
    affected_patient_id: str
    ward_id: str | None
    risk_level: InfectionRisk
    detected_at: datetime = field(default_factory=datetime.now)
    reported_by: str = ""
    containment_measures: list[str] = field(default_factory=list)
    resolved_at: datetime | None = None
    notes: str = ""

    def resolve(self, notes: str = "") -> None:
        self.resolved_at = datetime.now()
        if notes:
            self.notes += f"\nResolved: {notes}"

    def is_active(self) -> bool:
        return self.resolved_at is None

    def to_dict(self) -> dict:
        return {
            "event_id": self.event_id,
            "pathogen": self.pathogen,
            "patient_id": self.affected_patient_id,
            "risk_level": self.risk_level.value,
            "active": self.is_active(),
        }


class InfectionControlRepository:
    def __init__(self) -> None:
        self._events: dict[str, InfectionEvent] = {}

    def add(self, event: InfectionEvent) -> None:
        self._events[event.event_id] = event

    def active_events(self) -> list[InfectionEvent]:
        return [e for e in self._events.values() if e.is_active()]

    def by_risk(self, risk: InfectionRisk) -> list[InfectionEvent]:
        return [e for e in self._events.values() if e.risk_level == risk]

    def by_ward(self, ward_id: str) -> list[InfectionEvent]:
        return [e for e in self._events.values() if e.ward_id == ward_id]

    def all(self) -> list[InfectionEvent]:
        return list(self._events.values())


class InfectionControlService:
    def __init__(
        self,
        events: InfectionControlRepository,
        alerts: AlertRepository,
    ) -> None:
        self.events = events
        self.alerts = alerts

    def report(
        self,
        patient_id: str,
        pathogen: str,
        risk_level: InfectionRisk,
        ward_id: str | None,
        reported_by: str,
        measures: list[str] | None = None,
    ) -> InfectionEvent:
        event = InfectionEvent(
            event_id=str(uuid.uuid4()),
            pathogen=pathogen,
            affected_patient_id=patient_id,
            ward_id=ward_id,
            risk_level=risk_level,
            reported_by=reported_by,
            containment_measures=measures or [],
        )
        self.events.add(event)

        if risk_level in (InfectionRisk.HIGH, InfectionRisk.CRITICAL):
            alert = Alert(
                alert_id=str(uuid.uuid4()),
                level=AlertLevel.CRITICAL if risk_level == InfectionRisk.CRITICAL else AlertLevel.WARNING,
                title=f"Infection Alert: {pathogen}",
                message=f"{risk_level.value.upper()} infection risk — {pathogen} detected in patient {patient_id}" +
                        (f" (ward {ward_id})" if ward_id else ""),
                patient_id=patient_id,
            )
            self.alerts.add(alert)

        logger.warning("Infection event reported: %s %s risk=%s", event.event_id, pathogen, risk_level.value)
        return event

    def active_summary(self) -> str:
        active = self.events.active_events()
        lines = [f"=== Active Infection Events ({len(active)}) ===", ""]
        for event in sorted(active, key=lambda e: e.risk_level.value, reverse=True):
            lines.append(
                f"  [{event.risk_level.value.upper():8s}]  "
                f"{event.pathogen:20s}  "
                f"patient={event.affected_patient_id}  "
                f"detected={event.detected_at.date()}"
            )
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Telemedicine
# ---------------------------------------------------------------------------

class TelemedicineStatus(Enum):
    SCHEDULED = "scheduled"
    WAITING = "waiting"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    TECHNICAL_FAILURE = "technical_failure"
    CANCELLED = "cancelled"


@dataclass
class TelemedicineSession:
    session_id: str
    patient: Patient
    doctor: Doctor
    scheduled_at: datetime
    platform: str = "internal"
    status: TelemedicineStatus = TelemedicineStatus.SCHEDULED
    started_at: datetime | None = None
    ended_at: datetime | None = None
    join_url: str = ""
    recording_consent: bool = False
    technical_notes: str = ""
    clinical_notes: str = ""

    def start(self) -> None:
        if self.status not in (TelemedicineStatus.SCHEDULED, TelemedicineStatus.WAITING):
            raise ValueError(f"Cannot start: status={self.status}")
        self.started_at = datetime.now()
        self.status = TelemedicineStatus.IN_PROGRESS

    def end(self, clinical_notes: str = "") -> None:
        if self.status != TelemedicineStatus.IN_PROGRESS:
            raise ValueError(f"Cannot end: status={self.status}")
        self.ended_at = datetime.now()
        self.clinical_notes = clinical_notes
        self.status = TelemedicineStatus.COMPLETED

    def duration_minutes(self) -> float | None:
        if self.started_at and self.ended_at:
            return (self.ended_at - self.started_at).total_seconds() / 60
        return None

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "patient_id": self.patient.patient_id,
            "doctor_id": self.doctor.doctor_id,
            "scheduled_at": self.scheduled_at.isoformat(),
            "status": self.status.value,
            "duration_minutes": self.duration_minutes(),
        }


class TelemedicineRepository:
    def __init__(self) -> None:
        self._sessions: dict[str, TelemedicineSession] = {}

    def add(self, session: TelemedicineSession) -> None:
        self._sessions[session.session_id] = session

    def get(self, session_id: str) -> TelemedicineSession | None:
        return self._sessions.get(session_id)

    def by_patient(self, patient_id: str) -> list[TelemedicineSession]:
        return [s for s in self._sessions.values() if s.patient.patient_id == patient_id]

    def by_doctor(self, doctor_id: str) -> list[TelemedicineSession]:
        return [s for s in self._sessions.values() if s.doctor.doctor_id == doctor_id]

    def scheduled_today(self) -> list[TelemedicineSession]:
        today = date.today()
        return [
            s for s in self._sessions.values()
            if s.scheduled_at.date() == today
            and s.status in (TelemedicineStatus.SCHEDULED, TelemedicineStatus.WAITING)
        ]

    def all(self) -> list[TelemedicineSession]:
        return list(self._sessions.values())


class TelemedicineService:
    def __init__(
        self,
        sessions: TelemedicineRepository,
        patients: PatientRepository,
        doctors: DoctorRepository,
    ) -> None:
        self.sessions = sessions
        self.patients = patients
        self.doctors = doctors

    def schedule(
        self,
        patient_id: str,
        doctor_id: str,
        scheduled_at: datetime,
        platform: str = "internal",
        recording_consent: bool = False,
    ) -> TelemedicineSession:
        patient = self.patients.get_or_raise(patient_id)
        doctor = self.doctors.get_or_raise(doctor_id)

        session = TelemedicineSession(
            session_id=str(uuid.uuid4()),
            patient=patient,
            doctor=doctor,
            scheduled_at=scheduled_at,
            platform=platform,
            recording_consent=recording_consent,
        )
        self.sessions.add(session)
        logger.info("Telemedicine session scheduled: %s for patient %s with doctor %s", session.session_id, patient_id, doctor_id)
        return session

    def usage_stats(self) -> dict:
        all_sessions = self.sessions.all()
        completed = [s for s in all_sessions if s.status == TelemedicineStatus.COMPLETED]
        failed = [s for s in all_sessions if s.status == TelemedicineStatus.TECHNICAL_FAILURE]
        durations = [s.duration_minutes() for s in completed if s.duration_minutes() is not None]
        avg_dur = sum(durations) / len(durations) if durations else 0.0
        return {
            "total_sessions": len(all_sessions),
            "completed": len(completed),
            "technical_failures": len(failed),
            "avg_duration_minutes": round(avg_dur, 1),
            "failure_rate": round(len(failed) / len(all_sessions), 3) if all_sessions else 0.0,
        }


# ---------------------------------------------------------------------------
# Volunteer management
# ---------------------------------------------------------------------------

@dataclass
class Volunteer:
    volunteer_id: str
    name: str
    email: str
    phone: str
    skills: list[str] = field(default_factory=list)
    available_days: list[str] = field(default_factory=list)
    active: bool = True
    hours_logged: float = 0.0
    joined_at: date = field(default_factory=date.today)

    def log_hours(self, hours: float) -> None:
        if hours <= 0:
            raise ValueError(f"Hours must be positive: {hours}")
        self.hours_logged += hours

    def to_dict(self) -> dict:
        return {
            "volunteer_id": self.volunteer_id,
            "name": self.name,
            "skills": self.skills,
            "hours_logged": self.hours_logged,
            "active": self.active,
        }


class VolunteerRepository:
    def __init__(self) -> None:
        self._volunteers: dict[str, Volunteer] = {}

    def add(self, volunteer: Volunteer) -> None:
        self._volunteers[volunteer.volunteer_id] = volunteer

    def get(self, volunteer_id: str) -> Volunteer | None:
        return self._volunteers.get(volunteer_id)

    def by_skill(self, skill: str) -> list[Volunteer]:
        return [v for v in self._volunteers.values() if skill.lower() in [s.lower() for s in v.skills] and v.active]

    def by_available_day(self, day: str) -> list[Volunteer]:
        return [v for v in self._volunteers.values() if day.lower() in [d.lower() for d in v.available_days] and v.active]

    def top_contributors(self, n: int = 10) -> list[Volunteer]:
        active = [v for v in self._volunteers.values() if v.active]
        return sorted(active, key=lambda v: v.hours_logged, reverse=True)[:n]

    def all(self) -> list[Volunteer]:
        return list(self._volunteers.values())


# ---------------------------------------------------------------------------
# Staff scheduling
# ---------------------------------------------------------------------------

class ShiftType(Enum):
    MORNING = "morning"    # 08:00-16:00
    AFTERNOON = "afternoon"  # 16:00-00:00
    NIGHT = "night"         # 00:00-08:00
    LONG = "long"            # 08:00-20:00
    ON_CALL = "on_call"


SHIFT_HOURS: dict[ShiftType, tuple[time, time]] = {
    ShiftType.MORNING: (time(8, 0), time(16, 0)),
    ShiftType.AFTERNOON: (time(16, 0), time(23, 59)),
    ShiftType.NIGHT: (time(0, 0), time(8, 0)),
    ShiftType.LONG: (time(8, 0), time(20, 0)),
    ShiftType.ON_CALL: (time(0, 0), time(23, 59)),
}


@dataclass
class StaffShift:
    shift_id: str
    staff_id: str
    department: Department
    shift_type: ShiftType
    shift_date: date
    actual_start: datetime | None = None
    actual_end: datetime | None = None
    notes: str = ""

    def planned_start(self) -> datetime:
        start_time = SHIFT_HOURS[self.shift_type][0]
        return datetime.combine(self.shift_date, start_time)

    def planned_end(self) -> datetime:
        end_time = SHIFT_HOURS[self.shift_type][1]
        return datetime.combine(self.shift_date, end_time)

    def clock_in(self) -> None:
        self.actual_start = datetime.now()

    def clock_out(self) -> None:
        self.actual_end = datetime.now()

    def hours_worked(self) -> float | None:
        if self.actual_start and self.actual_end:
            return (self.actual_end - self.actual_start).total_seconds() / 3600
        return None

    def to_dict(self) -> dict:
        return {
            "shift_id": self.shift_id,
            "staff_id": self.staff_id,
            "department": self.department.value,
            "shift_type": self.shift_type.value,
            "shift_date": self.shift_date.isoformat(),
            "hours_worked": self.hours_worked(),
        }


class ShiftRepository:
    def __init__(self) -> None:
        self._shifts: dict[str, StaffShift] = {}

    def add(self, shift: StaffShift) -> None:
        self._shifts[shift.shift_id] = shift

    def by_staff(self, staff_id: str) -> list[StaffShift]:
        return [s for s in self._shifts.values() if s.staff_id == staff_id]

    def by_date(self, target_date: date) -> list[StaffShift]:
        return [s for s in self._shifts.values() if s.shift_date == target_date]

    def by_department(self, department: Department, target_date: date) -> list[StaffShift]:
        return [
            s for s in self._shifts.values()
            if s.department == department and s.shift_date == target_date
        ]

    def all(self) -> list[StaffShift]:
        return list(self._shifts.values())


class StaffScheduler:
    def __init__(self, shifts: ShiftRepository) -> None:
        self.shifts = shifts

    def schedule_shift(
        self,
        staff_id: str,
        department: Department,
        shift_type: ShiftType,
        shift_date: date,
    ) -> StaffShift:
        existing = self.shifts.by_staff(staff_id)
        for s in existing:
            if s.shift_date == shift_date and s.shift_type == shift_type:
                raise ValueError(f"Staff {staff_id} already has a {shift_type.value} shift on {shift_date}")

        shift = StaffShift(
            shift_id=str(uuid.uuid4()),
            staff_id=staff_id,
            department=department,
            shift_type=shift_type,
            shift_date=shift_date,
        )
        self.shifts.add(shift)
        return shift

    def weekly_roster(self, department: Department, week_start: date) -> dict[date, list[StaffShift]]:
        roster: dict[date, list[StaffShift]] = {}
        for i in range(7):
            day = week_start + timedelta(days=i)
            roster[day] = sorted(
                self.shifts.by_department(department, day),
                key=lambda s: s.shift_type.value,
            )
        return roster

    def overtime_report(self) -> list[dict]:
        report = []
        for shift in self.shifts.all():
            hours = shift.hours_worked()
            if hours and hours > 8:
                report.append({
                    "staff_id": shift.staff_id,
                    "date": shift.shift_date.isoformat(),
                    "shift_type": shift.shift_type.value,
                    "hours_worked": round(hours, 2),
                    "overtime_hours": round(hours - 8, 2),
                })
        return report


# ---------------------------------------------------------------------------
# Equipment maintenance tracking
# ---------------------------------------------------------------------------

class MaintenanceType(Enum):
    PREVENTIVE = "preventive"
    CORRECTIVE = "corrective"
    CALIBRATION = "calibration"
    INSPECTION = "inspection"


class MaintenanceStatus(Enum):
    SCHEDULED = "scheduled"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    CANCELLED = "cancelled"
    OVERDUE = "overdue"


@dataclass
class MaintenanceRecord:
    record_id: str
    resource: HospitalResource
    maintenance_type: MaintenanceType
    scheduled_date: date
    performed_by: str = ""
    status: MaintenanceStatus = MaintenanceStatus.SCHEDULED
    performed_at: datetime | None = None
    findings: str = ""
    actions_taken: str = ""
    next_due: date | None = None
    cost: float = 0.0

    def complete(self, performed_by: str, findings: str, actions: str, next_due: date | None = None) -> None:
        if self.status != MaintenanceStatus.IN_PROGRESS:
            self.status = MaintenanceStatus.IN_PROGRESS
        self.performed_by = performed_by
        self.performed_at = datetime.now()
        self.findings = findings
        self.actions_taken = actions
        self.next_due = next_due
        self.status = MaintenanceStatus.COMPLETED
        if next_due:
            self.resource.maintenance_due = next_due

    def to_dict(self) -> dict:
        return {
            "record_id": self.record_id,
            "resource_id": self.resource.resource_id,
            "type": self.maintenance_type.value,
            "scheduled_date": self.scheduled_date.isoformat(),
            "status": self.status.value,
            "cost": self.cost,
        }


class MaintenanceRepository:
    def __init__(self) -> None:
        self._records: dict[str, MaintenanceRecord] = {}

    def add(self, record: MaintenanceRecord) -> None:
        self._records[record.record_id] = record

    def get(self, record_id: str) -> MaintenanceRecord | None:
        return self._records.get(record_id)

    def by_resource(self, resource_id: str) -> list[MaintenanceRecord]:
        return [r for r in self._records.values() if r.resource.resource_id == resource_id]

    def overdue(self) -> list[MaintenanceRecord]:
        today = date.today()
        return [
            r for r in self._records.values()
            if r.status == MaintenanceStatus.SCHEDULED and r.scheduled_date < today
        ]

    def upcoming(self, days: int = 30) -> list[MaintenanceRecord]:
        today = date.today()
        cutoff = today + timedelta(days=days)
        return [
            r for r in self._records.values()
            if r.status == MaintenanceStatus.SCHEDULED
            and today <= r.scheduled_date <= cutoff
        ]

    def all(self) -> list[MaintenanceRecord]:
        return list(self._records.values())


# ---------------------------------------------------------------------------
# Comprehensive hospital statistics
# ---------------------------------------------------------------------------

def department_workload(appointments: list[Appointment]) -> dict[str, int]:
    counts: dict[str, int] = {}
    for appt in appointments:
        dept = appt.department.value
        counts[dept] = counts.get(dept, 0) + 1
    return dict(sorted(counts.items(), key=lambda x: x[1], reverse=True))


def doctor_performance(
    appointments: list[Appointment],
    records: list[MedicalRecord],
) -> dict[str, dict]:
    stats: dict[str, dict] = {}
    for appt in appointments:
        did = appt.doctor.doctor_id
        if did not in stats:
            stats[did] = {"name": appt.doctor.name, "appointments": 0, "completed": 0, "records": 0}
        stats[did]["appointments"] += 1
        if appt.status == AppointmentStatus.COMPLETED:
            stats[did]["completed"] += 1
    for record in records:
        did = record.doctor.doctor_id
        if did in stats:
            stats[did]["records"] += 1
    return stats


def monthly_summary(
    appointments: list[Appointment],
    admissions: list[Admission],
    invoices: list[Invoice],
    year: int,
    month: int,
) -> dict:
    month_appts = [
        a for a in appointments
        if a.slot.date.year == year and a.slot.date.month == month
    ]
    month_admits = [
        a for a in admissions
        if a.admitted_at.year == year and a.admitted_at.month == month
    ]
    month_invoices = [
        i for i in invoices
        if i.issued_at and i.issued_at.year == year and i.issued_at.month == month
    ]
    revenue = sum(
        i.paid_amount.amount
        for i in month_invoices
        if i.status == InvoiceStatus.PAID
    )
    return {
        "year": year,
        "month": month,
        "appointments": len(month_appts),
        "admissions": len(month_admits),
        "invoices_issued": len(month_invoices),
        "revenue_collected": revenue,
        "no_show_count": sum(1 for a in month_appts if a.status == AppointmentStatus.NO_SHOW),
        "cancellation_count": sum(1 for a in month_appts if a.status == AppointmentStatus.CANCELLED),
    }


def build_comprehensive_report(
    system: HospitalSystem,
    reporter: HospitalReporter,
    wards: list[Ward],
) -> str:
    sections = [
        HospitalReporter.section_header("HOSPITAL COMPREHENSIVE REPORT"),
        f"Generated: {datetime.now().isoformat()}",
        "",
        reporter.daily_appointment_summary(date.today()),
        "",
        reporter.bed_occupancy_report(wards),
        "",
        reporter.critical_alerts(),
        "",
        reporter.revenue_report(),
        "",
        reporter.overdue_invoices_report(),
    ]
    return "\n".join(sections)


class HospitalReporter:  # type: ignore[no-redef]
    @staticmethod
    def section_header(title: str, width: int = 60) -> str:
        return "=" * width + "\n" + title.center(width) + "\n" + "=" * width


# ---------------------------------------------------------------------------
# Organ/tissue donation tracking
# ---------------------------------------------------------------------------

class DonationStatus(Enum):
    CONSENTED = "consented"
    EVALUATED = "evaluated"
    APPROVED = "approved"
    PROCURED = "procured"
    TRANSPLANTED = "transplanted"
    CANCELLED = "cancelled"


class OrganType(Enum):
    KIDNEY = "kidney"
    LIVER = "liver"
    HEART = "heart"
    LUNG = "lung"
    PANCREAS = "pancreas"
    CORNEA = "cornea"
    BONE_MARROW = "bone_marrow"
    SKIN = "skin"


@dataclass
class DonationRecord:
    donation_id: str
    donor_patient_id: str
    organ_type: OrganType
    status: DonationStatus
    consent_date: date
    blood_type: BloodType
    compatible_types: list[BloodType] = field(default_factory=list)
    procured_at: datetime | None = None
    transplanted_to: str | None = None
    notes: str = ""

    def procure(self) -> None:
        if self.status != DonationStatus.APPROVED:
            raise ValueError(f"Cannot procure: status={self.status}")
        self.procured_at = datetime.now()
        self.status = DonationStatus.PROCURED

    def transplant(self, recipient_id: str) -> None:
        if self.status != DonationStatus.PROCURED:
            raise ValueError(f"Cannot transplant: status={self.status}")
        self.transplanted_to = recipient_id
        self.status = DonationStatus.TRANSPLANTED

    def to_dict(self) -> dict:
        return {
            "donation_id": self.donation_id,
            "donor_id": self.donor_patient_id,
            "organ": self.organ_type.value,
            "status": self.status.value,
            "consent_date": self.consent_date.isoformat(),
        }


# ---------------------------------------------------------------------------
# Dialysis scheduling
# ---------------------------------------------------------------------------

class DialysisType(Enum):
    HEMODIALYSIS = "hemodialysis"
    PERITONEAL = "peritoneal"
    CRRT = "crrt"


@dataclass
class DialysisSession:
    session_id: str
    patient: Patient
    dialysis_type: DialysisType
    scheduled_at: datetime
    duration_hours: float = 4.0
    machine_id: str = ""
    nurse_id: str = ""
    completed: bool = False
    started_at: datetime | None = None
    ended_at: datetime | None = None
    pre_weight: float | None = None
    post_weight: float | None = None
    notes: str = ""

    def start(self, pre_weight: float | None = None) -> None:
        self.started_at = datetime.now()
        self.pre_weight = pre_weight

    def end(self, post_weight: float | None = None) -> None:
        self.ended_at = datetime.now()
        self.post_weight = post_weight
        self.completed = True

    def fluid_removed(self) -> float | None:
        if self.pre_weight is not None and self.post_weight is not None:
            return self.pre_weight - self.post_weight
        return None

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "patient_id": self.patient.patient_id,
            "type": self.dialysis_type.value,
            "scheduled_at": self.scheduled_at.isoformat(),
            "completed": self.completed,
            "fluid_removed_kg": self.fluid_removed(),
        }


class DialysisRepository:
    def __init__(self) -> None:
        self._sessions: dict[str, DialysisSession] = {}

    def add(self, session: DialysisSession) -> None:
        self._sessions[session.session_id] = session

    def by_patient(self, patient_id: str) -> list[DialysisSession]:
        return [s for s in self._sessions.values() if s.patient.patient_id == patient_id]

    def scheduled_today(self) -> list[DialysisSession]:
        today = date.today()
        return [
            s for s in self._sessions.values()
            if s.scheduled_at.date() == today and not s.completed
        ]

    def by_machine(self, machine_id: str) -> list[DialysisSession]:
        return [s for s in self._sessions.values() if s.machine_id == machine_id]

    def all(self) -> list[DialysisSession]:
        return list(self._sessions.values())


# ---------------------------------------------------------------------------
# Blood bank management
# ---------------------------------------------------------------------------

class BloodProduct(Enum):
    WHOLE_BLOOD = "whole_blood"
    PACKED_RED_CELLS = "packed_red_cells"
    FRESH_FROZEN_PLASMA = "fresh_frozen_plasma"
    PLATELETS = "platelets"
    CRYOPRECIPITATE = "cryoprecipitate"


@dataclass
class BloodUnit:
    unit_id: str
    blood_type: BloodType
    product: BloodProduct
    volume_ml: int
    donated_at: date
    expires_at: date
    donor_id: str = ""
    location: str = ""
    used: bool = False
    used_at: datetime | None = None
    used_for_patient_id: str | None = None

    def is_expired(self) -> bool:
        return date.today() > self.expires_at

    def is_available(self) -> bool:
        return not self.used and not self.is_expired()

    def dispense(self, patient_id: str) -> None:
        if not self.is_available():
            raise ValueError(f"Blood unit {self.unit_id} is not available")
        self.used = True
        self.used_at = datetime.now()
        self.used_for_patient_id = patient_id

    def to_dict(self) -> dict:
        return {
            "unit_id": self.unit_id,
            "blood_type": self.blood_type.value,
            "product": self.product.value,
            "volume_ml": self.volume_ml,
            "expires_at": self.expires_at.isoformat(),
            "available": self.is_available(),
        }


class BloodBankRepository:
    def __init__(self) -> None:
        self._units: dict[str, BloodUnit] = {}

    def add(self, unit: BloodUnit) -> None:
        self._units[unit.unit_id] = unit

    def available_by_type(self, blood_type: BloodType, product: BloodProduct) -> list[BloodUnit]:
        return [
            u for u in self._units.values()
            if u.blood_type == blood_type
            and u.product == product
            and u.is_available()
        ]

    def expiring_soon(self, days: int = 3) -> list[BloodUnit]:
        cutoff = date.today() + timedelta(days=days)
        return [
            u for u in self._units.values()
            if u.is_available() and u.expires_at <= cutoff
        ]

    def stock_summary(self) -> dict[str, dict[str, int]]:
        summary: dict[str, dict[str, int]] = {}
        for unit in self._units.values():
            if not unit.is_available():
                continue
            bt = unit.blood_type.value
            prod = unit.product.value
            if bt not in summary:
                summary[bt] = {}
            summary[bt][prod] = summary[bt].get(prod, 0) + 1
        return summary

    def all(self) -> list[BloodUnit]:
        return list(self._units.values())


class BloodBankService:
    def __init__(
        self,
        blood_bank: BloodBankRepository,
        alerts: AlertRepository,
    ) -> None:
        self.blood_bank = blood_bank
        self.alerts = alerts
        self.LOW_STOCK_THRESHOLD = 5

    def dispense(self, patient_id: str, blood_type: BloodType, product: BloodProduct) -> BloodUnit:
        available = self.blood_bank.available_by_type(blood_type, product)
        if not available:
            raise ValueError(f"No {product.value} of type {blood_type.value} available")
        unit = sorted(available, key=lambda u: u.expires_at)[0]
        unit.dispense(patient_id)
        remaining = len(self.blood_bank.available_by_type(blood_type, product))
        if remaining <= self.LOW_STOCK_THRESHOLD:
            alert = Alert(
                alert_id=str(uuid.uuid4()),
                level=AlertLevel.WARNING,
                title=f"Low Blood Stock: {blood_type.value} {product.value}",
                message=f"Only {remaining} units of {blood_type.value} {product.value} remaining",
                patient_id=None,
            )
            self.alerts.add(alert)
        return unit

    def expiry_report(self) -> str:
        expiring = self.blood_bank.expiring_soon(days=7)
        lines = [f"=== Expiring Blood Products (within 7 days) ===", f"Count: {len(expiring)}", ""]
        for unit in sorted(expiring, key=lambda u: u.expires_at):
            lines.append(
                f"  {unit.unit_id[:8]}  "
                f"{unit.blood_type.value:5s}  "
                f"{unit.product.value:25s}  "
                f"expires={unit.expires_at}"
            )
        return "\n".join(lines)

    def stock_report(self) -> str:
        summary = self.blood_bank.stock_summary()
        lines = ["=== Blood Bank Stock ===", ""]
        for blood_type in sorted(summary.keys()):
            lines.append(f"  [{blood_type}]")
            for product, count in sorted(summary[blood_type].items()):
                status = " *** LOW ***" if count <= self.LOW_STOCK_THRESHOLD else ""
                lines.append(f"    {product:25s}: {count:3d} units{status}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Rehabilitation tracking
# ---------------------------------------------------------------------------

class RehabGoalStatus(Enum):
    NOT_STARTED = "not_started"
    IN_PROGRESS = "in_progress"
    ACHIEVED = "achieved"
    REVISED = "revised"
    ABANDONED = "abandoned"


@dataclass
class RehabGoal:
    goal_id: str
    description: str
    target_date: date
    status: RehabGoalStatus = RehabGoalStatus.NOT_STARTED
    achieved_at: date | None = None
    progress_notes: str = ""

    def update_progress(self, note: str) -> None:
        self.progress_notes += f"\n[{date.today()}] {note}"
        if self.status == RehabGoalStatus.NOT_STARTED:
            self.status = RehabGoalStatus.IN_PROGRESS

    def achieve(self) -> None:
        self.status = RehabGoalStatus.ACHIEVED
        self.achieved_at = date.today()

    def revise(self, new_description: str, new_target: date) -> None:
        self.description = new_description
        self.target_date = new_target
        self.status = RehabGoalStatus.REVISED

    def to_dict(self) -> dict:
        return {
            "goal_id": self.goal_id,
            "description": self.description,
            "target_date": self.target_date.isoformat(),
            "status": self.status.value,
            "achieved_at": self.achieved_at.isoformat() if self.achieved_at else None,
        }


@dataclass
class RehabSession:
    session_id: str
    patient: Patient
    therapist_id: str
    session_date: date
    duration_minutes: int
    session_type: str
    exercises: list[str] = field(default_factory=list)
    progress_score: int | None = None  # 0–10
    pain_score: int | None = None      # 0–10
    notes: str = ""

    def to_dict(self) -> dict:
        return {
            "session_id": self.session_id,
            "patient_id": self.patient.patient_id,
            "date": self.session_date.isoformat(),
            "duration_minutes": self.duration_minutes,
            "type": self.session_type,
            "progress_score": self.progress_score,
            "pain_score": self.pain_score,
        }


@dataclass
class RehabPlan:
    plan_id: str
    patient: Patient
    doctor: Doctor
    start_date: date
    end_date: date
    diagnosis: str
    goals: list[RehabGoal] = field(default_factory=list)
    sessions: list[RehabSession] = field(default_factory=list)
    active: bool = True

    def add_goal(self, description: str, target_date: date) -> RehabGoal:
        goal = RehabGoal(
            goal_id=str(uuid.uuid4()),
            description=description,
            target_date=target_date,
        )
        self.goals.append(goal)
        return goal

    def add_session(self, session: RehabSession) -> None:
        self.sessions.append(session)

    def achieved_goals(self) -> list[RehabGoal]:
        return [g for g in self.goals if g.status == RehabGoalStatus.ACHIEVED]

    def progress_pct(self) -> float:
        if not self.goals:
            return 0.0
        return len(self.achieved_goals()) / len(self.goals)

    def avg_progress_score(self) -> float | None:
        scores = [s.progress_score for s in self.sessions if s.progress_score is not None]
        return sum(scores) / len(scores) if scores else None

    def to_dict(self) -> dict:
        return {
            "plan_id": self.plan_id,
            "patient_id": self.patient.patient_id,
            "start_date": self.start_date.isoformat(),
            "end_date": self.end_date.isoformat(),
            "diagnosis": self.diagnosis,
            "total_goals": len(self.goals),
            "achieved_goals": len(self.achieved_goals()),
            "progress_pct": round(self.progress_pct() * 100, 1),
        }


class RehabRepository:
    def __init__(self) -> None:
        self._plans: dict[str, RehabPlan] = {}

    def add(self, plan: RehabPlan) -> None:
        self._plans[plan.plan_id] = plan

    def get(self, plan_id: str) -> RehabPlan | None:
        return self._plans.get(plan_id)

    def by_patient(self, patient_id: str) -> list[RehabPlan]:
        return [p for p in self._plans.values() if p.patient.patient_id == patient_id]

    def active(self) -> list[RehabPlan]:
        return [p for p in self._plans.values() if p.active]

    def all(self) -> list[RehabPlan]:
        return list(self._plans.values())


# ---------------------------------------------------------------------------
# Outpatient chemotherapy
# ---------------------------------------------------------------------------

class ChemoProtocol(Enum):
    FOLFOX = "FOLFOX"
    FOLFIRI = "FOLFIRI"
    AC = "AC"
    TC = "TC"
    GEMCITABINE = "Gemcitabine"
    CARBOPLATIN_TAXOL = "Carboplatin+Taxol"
    CUSTOM = "Custom"


@dataclass
class ChemoCycle:
    cycle_id: str
    patient: Patient
    doctor: Doctor
    protocol: ChemoProtocol
    cycle_number: int
    scheduled_at: datetime
    pre_meds: list[str] = field(default_factory=list)
    drugs: list[dict] = field(default_factory=list)
    completed: bool = False
    completed_at: datetime | None = None
    delayed_reason: str = ""
    toxicity_grade: int | None = None
    notes: str = ""

    def complete(self, toxicity_grade: int | None = None) -> None:
        self.completed = True
        self.completed_at = datetime.now()
        self.toxicity_grade = toxicity_grade

    def delay(self, reason: str) -> None:
        self.delayed_reason = reason

    def to_dict(self) -> dict:
        return {
            "cycle_id": self.cycle_id,
            "patient_id": self.patient.patient_id,
            "protocol": self.protocol.value,
            "cycle_number": self.cycle_number,
            "scheduled_at": self.scheduled_at.isoformat(),
            "completed": self.completed,
            "toxicity_grade": self.toxicity_grade,
        }


class ChemoRepository:
    def __init__(self) -> None:
        self._cycles: dict[str, ChemoCycle] = {}

    def add(self, cycle: ChemoCycle) -> None:
        self._cycles[cycle.cycle_id] = cycle

    def by_patient(self, patient_id: str) -> list[ChemoCycle]:
        return sorted(
            [c for c in self._cycles.values() if c.patient.patient_id == patient_id],
            key=lambda c: c.cycle_number,
        )

    def upcoming(self) -> list[ChemoCycle]:
        now = datetime.now()
        return [c for c in self._cycles.values() if not c.completed and c.scheduled_at >= now]

    def completed_by_patient(self, patient_id: str) -> list[ChemoCycle]:
        return [c for c in self.by_patient(patient_id) if c.completed]

    def all(self) -> list[ChemoCycle]:
        return list(self._cycles.values())


# ---------------------------------------------------------------------------
# Final extended health check
# ---------------------------------------------------------------------------

def extended_health_check(system: HospitalSystem, extra_repos: dict) -> dict:
    base = full_system_health(system)
    blood_bank = extra_repos.get("blood_bank")
    rehab = extra_repos.get("rehab")
    chemo = extra_repos.get("chemo")
    dialysis = extra_repos.get("dialysis")

    extensions: dict = {}
    if blood_bank is not None:
        expiring = blood_bank.expiring_soon(days=3)
        extensions["blood_units_expiring_soon"] = len(expiring)
    if rehab is not None:
        extensions["active_rehab_plans"] = len(rehab.active())
    if chemo is not None:
        extensions["upcoming_chemo_cycles"] = len(chemo.upcoming())
    if dialysis is not None:
        extensions["dialysis_today"] = len(dialysis.scheduled_today())

    return {**base, **extensions}


# ---------------------------------------------------------------------------
# Radiology information system helpers
# ---------------------------------------------------------------------------

class ModalityWorklistEntry:
    def __init__(self, order: ImagingOrder, scheduled_at: datetime) -> None:
        self.order = order
        self.scheduled_at = scheduled_at
        self.accession_number = f"ACC{order.order_id[:8].upper()}"

    def to_dict(self) -> dict:
        return {
            "accession_number": self.accession_number,
            "order_id": self.order.order_id,
            "patient_id": self.order.patient.patient_id,
            "patient_name": self.order.patient.name,
            "imaging_type": self.order.imaging_type.value,
            "body_part": self.order.body_part,
            "scheduled_at": self.scheduled_at.isoformat(),
            "urgent": self.order.urgent,
        }


class RisService:
    """Radiology Information System helper — builds modality worklists."""

    def __init__(self, imaging: ImagingRepository) -> None:
        self.imaging = imaging

    def build_worklist(self, imaging_type: ImagingType, target_date: date) -> list[ModalityWorklistEntry]:
        orders = [
            o for o in self.imaging.all()
            if o.imaging_type == imaging_type
            and o.scheduled_at is not None
            and o.scheduled_at.date() == target_date
            and o.status in (ImagingStatus.SCHEDULED, ImagingStatus.ORDERED)
        ]
        return sorted(
            [ModalityWorklistEntry(o, o.scheduled_at) for o in orders if o.scheduled_at],
            key=lambda e: (not e.order.urgent, e.scheduled_at),
        )

    def pending_reports(self) -> list[ImagingOrder]:
        return [o for o in self.imaging.by_status(ImagingStatus.PERFORMED)]

    def reporting_stats(self) -> dict:
        all_orders = self.imaging.all()
        reported = [o for o in all_orders if o.status == ImagingStatus.REPORTED]
        pending = self.pending_reports()
        urgent_pending = [o for o in pending if o.urgent]
        return {
            "total_orders": len(all_orders),
            "reported": len(reported),
            "pending_reports": len(pending),
            "urgent_pending": len(urgent_pending),
        }


# ---------------------------------------------------------------------------
# Clinical trial management
# ---------------------------------------------------------------------------

class TrialStatus(Enum):
    RECRUITING = "recruiting"
    ACTIVE = "active"
    COMPLETED = "completed"
    SUSPENDED = "suspended"
    TERMINATED = "terminated"


class TrialPhase(Enum):
    PHASE_1 = "phase_1"
    PHASE_2 = "phase_2"
    PHASE_3 = "phase_3"
    PHASE_4 = "phase_4"
    OBSERVATIONAL = "observational"


@dataclass
class ClinicalTrial:
    trial_id: str
    title: str
    phase: TrialPhase
    principal_investigator_id: str
    start_date: date
    end_date: date | None
    status: TrialStatus = TrialStatus.RECRUITING
    target_enrollment: int = 100
    enrolled_count: int = 0
    sponsor: str = ""
    description: str = ""
    inclusion_criteria: list[str] = field(default_factory=list)
    exclusion_criteria: list[str] = field(default_factory=list)

    def can_enroll(self) -> bool:
        return (
            self.status == TrialStatus.RECRUITING
            and self.enrolled_count < self.target_enrollment
        )

    def enroll(self) -> None:
        if not self.can_enroll():
            raise ValueError(f"Trial {self.trial_id} cannot enroll more participants")
        self.enrolled_count += 1
        if self.enrolled_count >= self.target_enrollment:
            self.status = TrialStatus.ACTIVE

    def to_dict(self) -> dict:
        return {
            "trial_id": self.trial_id,
            "title": self.title[:60],
            "phase": self.phase.value,
            "status": self.status.value,
            "enrolled": self.enrolled_count,
            "target": self.target_enrollment,
        }


@dataclass
class TrialEnrollment:
    enrollment_id: str
    trial: ClinicalTrial
    patient: Patient
    consented_at: date
    enrolled_at: datetime = field(default_factory=datetime.now)
    withdrawn: bool = False
    withdrawn_at: datetime | None = None
    withdrawal_reason: str = ""
    arm: str = "main"

    def withdraw(self, reason: str = "") -> None:
        self.withdrawn = True
        self.withdrawn_at = datetime.now()
        self.withdrawal_reason = reason

    def to_dict(self) -> dict:
        return {
            "enrollment_id": self.enrollment_id,
            "trial_id": self.trial.trial_id,
            "patient_id": self.patient.patient_id,
            "arm": self.arm,
            "withdrawn": self.withdrawn,
        }


class TrialRepository:
    def __init__(self) -> None:
        self._trials: dict[str, ClinicalTrial] = {}
        self._enrollments: dict[str, TrialEnrollment] = {}

    def add_trial(self, trial: ClinicalTrial) -> None:
        self._trials[trial.trial_id] = trial

    def add_enrollment(self, enrollment: TrialEnrollment) -> None:
        self._enrollments[enrollment.enrollment_id] = enrollment

    def get_trial(self, trial_id: str) -> ClinicalTrial | None:
        return self._trials.get(trial_id)

    def recruiting_trials(self) -> list[ClinicalTrial]:
        return [t for t in self._trials.values() if t.status == TrialStatus.RECRUITING]

    def enrollments_by_patient(self, patient_id: str) -> list[TrialEnrollment]:
        return [e for e in self._enrollments.values() if e.patient.patient_id == patient_id]

    def active_enrollments_for_trial(self, trial_id: str) -> list[TrialEnrollment]:
        return [
            e for e in self._enrollments.values()
            if e.trial.trial_id == trial_id and not e.withdrawn
        ]

    def all_trials(self) -> list[ClinicalTrial]:
        return list(self._trials.values())


class ClinicalTrialService:
    def __init__(
        self,
        trials: TrialRepository,
        patients: PatientRepository,
    ) -> None:
        self.trials = trials
        self.patients = patients

    def enroll_patient(self, trial_id: str, patient_id: str, arm: str = "main") -> TrialEnrollment:
        trial = self.trials.get_trial(trial_id)
        if trial is None:
            raise KeyError(f"Trial not found: {trial_id}")
        patient = self.patients.get_or_raise(patient_id)

        existing = [
            e for e in self.trials.enrollments_by_patient(patient_id)
            if e.trial.trial_id == trial_id and not e.withdrawn
        ]
        if existing:
            raise ValueError(f"Patient {patient_id} already enrolled in trial {trial_id}")

        trial.enroll()
        enrollment = TrialEnrollment(
            enrollment_id=str(uuid.uuid4()),
            trial=trial,
            patient=patient,
            consented_at=date.today(),
            arm=arm,
        )
        self.trials.add_enrollment(enrollment)
        logger.info("Patient %s enrolled in trial %s (arm=%s)", patient_id, trial_id, arm)
        return enrollment

    def enrollment_summary(self, trial_id: str) -> dict:
        trial = self.trials.get_trial(trial_id)
        if trial is None:
            raise KeyError(f"Trial not found: {trial_id}")
        active = self.trials.active_enrollments_for_trial(trial_id)
        arm_counts: dict[str, int] = {}
        for e in active:
            arm_counts[e.arm] = arm_counts.get(e.arm, 0) + 1
        return {
            "trial_id": trial_id,
            "title": trial.title,
            "phase": trial.phase.value,
            "status": trial.status.value,
            "active_enrollments": len(active),
            "target": trial.target_enrollment,
            "by_arm": arm_counts,
        }


# ---------------------------------------------------------------------------
# Pain management
# ---------------------------------------------------------------------------

class PainScale(Enum):
    NUMERIC_RATING = "NRS"   # 0–10
    VISUAL_ANALOG = "VAS"    # 0–100
    WONG_BAKER = "WBS"       # 0–10 faces
    FLACC = "FLACC"          # 0–10 (pediatric)


@dataclass
class PainAssessment:
    assessment_id: str
    patient: Patient
    scale: PainScale
    score: int
    location: str = ""
    character: str = ""
    radiation: bool = False
    aggravating_factors: list[str] = field(default_factory=list)
    relieving_factors: list[str] = field(default_factory=list)
    assessed_by: str = ""
    assessed_at: datetime = field(default_factory=datetime.now)
    notes: str = ""

    def __post_init__(self) -> None:
        max_score = 100 if self.scale == PainScale.VISUAL_ANALOG else 10
        if not 0 <= self.score <= max_score:
            raise ValueError(f"Score out of range for {self.scale.value}: {self.score}")

    def severity(self) -> str:
        normalized = self.score / (100 if self.scale == PainScale.VISUAL_ANALOG else 10)
        if normalized < 0.3:
            return "mild"
        if normalized < 0.7:
            return "moderate"
        return "severe"

    def to_dict(self) -> dict:
        return {
            "assessment_id": self.assessment_id,
            "patient_id": self.patient.patient_id,
            "scale": self.scale.value,
            "score": self.score,
            "severity": self.severity(),
            "location": self.location,
            "assessed_at": self.assessed_at.isoformat(),
        }


class PainRepository:
    def __init__(self) -> None:
        self._assessments: dict[str, PainAssessment] = {}

    def add(self, assessment: PainAssessment) -> None:
        self._assessments[assessment.assessment_id] = assessment

    def by_patient(self, patient_id: str) -> list[PainAssessment]:
        return sorted(
            [a for a in self._assessments.values() if a.patient.patient_id == patient_id],
            key=lambda a: a.assessed_at,
            reverse=True,
        )

    def recent_for_patient(self, patient_id: str, n: int = 5) -> list[PainAssessment]:
        return self.by_patient(patient_id)[:n]

    def high_pain_patients(self, threshold: int = 7) -> list[PainAssessment]:
        latest: dict[str, PainAssessment] = {}
        for a in self._assessments.values():
            pid = a.patient.patient_id
            if pid not in latest or a.assessed_at > latest[pid].assessed_at:
                latest[pid] = a
        return [a for a in latest.values() if a.score >= threshold]

    def all(self) -> list[PainAssessment]:
        return list(self._assessments.values())


# ---------------------------------------------------------------------------
# Final summary / master report
# ---------------------------------------------------------------------------

def build_master_report(
    system: HospitalSystem,
    wards: list[Ward],
    blood_bank: BloodBankRepository | None = None,
    chemo_repo: ChemoRepository | None = None,
    rehab_repo: RehabRepository | None = None,
) -> str:
    reporter = HospitalReporter(system)
    sections = [
        "=" * 70,
        "MASTER HOSPITAL REPORT".center(70),
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}".center(70),
        "=" * 70,
        "",
        reporter.daily_appointment_summary(date.today()),
        "",
        reporter.bed_occupancy_report(wards),
        "",
        reporter.revenue_report(),
        "",
        reporter.critical_alerts(),
        "",
        reporter.overdue_invoices_report(),
    ]

    if blood_bank:
        summary = blood_bank.stock_summary()
        sections.append("")
        sections.append("=== Blood Bank Summary ===")
        for bt, products in summary.items():
            total = sum(products.values())
            sections.append(f"  {bt:5s}: {total} units total")

    if chemo_repo:
        upcoming = chemo_repo.upcoming()
        sections.append("")
        sections.append(f"=== Upcoming Chemotherapy Cycles: {len(upcoming)} ===")

    if rehab_repo:
        active_plans = rehab_repo.active()
        sections.append("")
        sections.append(f"=== Active Rehabilitation Plans: {len(active_plans)} ===")

    sections.append("")
    sections.append("=" * 70)
    sections.append("END OF REPORT".center(70))
    sections.append("=" * 70)

    return "\n".join(sections)


# ---------------------------------------------------------------------------
# Nutrition / dietary management
# ---------------------------------------------------------------------------

class DietType(Enum):
    REGULAR = "regular"
    SOFT = "soft"
    LIQUID = "liquid"
    DIABETIC = "diabetic"
    LOW_SODIUM = "low_sodium"
    LOW_FAT = "low_fat"
    RENAL = "renal"
    HIGH_PROTEIN = "high_protein"
    NPO = "npo"  # nothing by mouth
    CUSTOM = "custom"


@dataclass
class MealOrder:
    order_id: str
    patient: Patient
    diet_type: DietType
    meal_date: date
    allergies_noted: list[str] = field(default_factory=list)
    special_instructions: str = ""
    delivered: bool = False
    delivered_at: datetime | None = None
    calories_estimate: int | None = None
    ordered_by: str = ""

    def deliver(self) -> None:
        self.delivered = True
        self.delivered_at = datetime.now()

    def to_dict(self) -> dict:
        return {
            "order_id": self.order_id,
            "patient_id": self.patient.patient_id,
            "diet_type": self.diet_type.value,
            "meal_date": self.meal_date.isoformat(),
            "delivered": self.delivered,
        }


class NutritionRepository:
    def __init__(self) -> None:
        self._orders: dict[str, MealOrder] = {}

    def add(self, order: MealOrder) -> None:
        self._orders[order.order_id] = order

    def by_patient(self, patient_id: str) -> list[MealOrder]:
        return [o for o in self._orders.values() if o.patient.patient_id == patient_id]

    def pending_delivery(self, for_date: date) -> list[MealOrder]:
        return [o for o in self._orders.values() if o.meal_date == for_date and not o.delivered]

    def delivered_today(self) -> list[MealOrder]:
        today = date.today()
        return [o for o in self._orders.values() if o.meal_date == today and o.delivered]

    def all(self) -> list[MealOrder]:
        return list(self._orders.values())


class NutritionService:
    def __init__(self, nutrition: NutritionRepository, patients: PatientRepository) -> None:
        self.nutrition = nutrition
        self.patients = patients

    def order_meal(
        self,
        patient_id: str,
        diet_type: DietType,
        meal_date: date,
        ordered_by: str,
        special_instructions: str = "",
    ) -> MealOrder:
        patient = self.patients.get_or_raise(patient_id)
        order = MealOrder(
            order_id=str(uuid.uuid4()),
            patient=patient,
            diet_type=diet_type,
            meal_date=meal_date,
            allergies_noted=list(patient.allergies),
            special_instructions=special_instructions,
            ordered_by=ordered_by,
        )
        self.nutrition.add(order)
        return order

    def delivery_list(self, for_date: date) -> str:
        pending = self.nutrition.pending_delivery(for_date)
        lines = [f"=== Meal Delivery List: {for_date} ({len(pending)} pending) ===", ""]
        for order in sorted(pending, key=lambda o: o.patient.name):
            allergy_note = f"  [ALLERGY: {', '.join(order.allergies_noted)}]" if order.allergies_noted else ""
            lines.append(f"  {order.patient.name:20s}  {order.diet_type.value:15s}{allergy_note}")
        return "\n".join(lines)

    def diet_summary(self, for_date: date) -> dict[str, int]:
        orders = [o for o in self.nutrition.all() if o.meal_date == for_date]
        counts: dict[str, int] = {}
        for order in orders:
            counts[order.diet_type.value] = counts.get(order.diet_type.value, 0) + 1
        return counts


# ---------------------------------------------------------------------------
# Patient education tracking
# ---------------------------------------------------------------------------

class EducationTopic(Enum):
    DIABETES_MANAGEMENT = "diabetes_management"
    HYPERTENSION = "hypertension"
    MEDICATION_COMPLIANCE = "medication_compliance"
    WOUND_CARE = "wound_care"
    DIET_NUTRITION = "diet_nutrition"
    EXERCISE = "exercise"
    FALL_PREVENTION = "fall_prevention"
    POST_OP_CARE = "post_op_care"
    DISCHARGE_INSTRUCTIONS = "discharge_instructions"


@dataclass
class PatientEducation:
    education_id: str
    patient: Patient
    topic: EducationTopic
    educator_id: str
    method: str  # verbal, written, video, demonstration
    completed: bool = False
    completed_at: datetime | None = None
    comprehension_score: int | None = None  # 0–10
    follow_up_needed: bool = False
    notes: str = ""
    created_at: datetime = field(default_factory=datetime.now)

    def complete(self, comprehension_score: int | None = None) -> None:
        self.completed = True
        self.completed_at = datetime.now()
        self.comprehension_score = comprehension_score
        if comprehension_score is not None and comprehension_score < 7:
            self.follow_up_needed = True

    def to_dict(self) -> dict:
        return {
            "education_id": self.education_id,
            "patient_id": self.patient.patient_id,
            "topic": self.topic.value,
            "method": self.method,
            "completed": self.completed,
            "comprehension_score": self.comprehension_score,
            "follow_up_needed": self.follow_up_needed,
        }


class EducationRepository:
    def __init__(self) -> None:
        self._records: dict[str, PatientEducation] = {}

    def add(self, record: PatientEducation) -> None:
        self._records[record.education_id] = record

    def by_patient(self, patient_id: str) -> list[PatientEducation]:
        return [r for r in self._records.values() if r.patient.patient_id == patient_id]

    def pending_follow_up(self) -> list[PatientEducation]:
        return [r for r in self._records.values() if r.follow_up_needed and r.completed]

    def completion_rate_by_topic(self) -> dict[str, float]:
        topic_totals: dict[str, int] = {}
        topic_completed: dict[str, int] = {}
        for r in self._records.values():
            t = r.topic.value
            topic_totals[t] = topic_totals.get(t, 0) + 1
            if r.completed:
                topic_completed[t] = topic_completed.get(t, 0) + 1
        return {
            t: round(topic_completed.get(t, 0) / total, 3)
            for t, total in topic_totals.items()
        }

    def all(self) -> list[PatientEducation]:
        return list(self._records.values())
