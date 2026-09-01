from comiket.models import Circle


def merge_wants(items):
    out = []
    for it in items:
        out.append(Circle(it, it * 2))
    return out
