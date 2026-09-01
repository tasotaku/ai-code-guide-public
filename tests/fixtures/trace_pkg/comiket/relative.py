from . import PACKAGE_TAG
from .models import Circle


def merge_wants(items):
    out = []
    for it in items:
        out.append(Circle(it, len(PACKAGE_TAG)))
    return out
