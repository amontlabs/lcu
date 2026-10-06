"""Print the NONPRINTABLE export of lcu/compat/pyerr_tables.mjs: the code point ranges (>= U+00A0)
for which Python 3.12's str.isprintable() is False (repr() escapes them). Appended by build_pyerr_tables.py."""
import sys
import unicodedata


def ranges():
    out, start = [], None
    for cp in range(0xa0, 0x110001):
        bad = cp <= 0x10ffff and not chr(cp).isprintable()
        if bad and start is None:
            start = cp
        elif not bad and start is not None:
            out.append(f'{start:x}-{cp - 1:x}' if cp - 1 != start else f'{start:x}')
            start = None
    return out


def table():
    if sys.version_info[:2] != (3, 12):
        sys.exit('run with Python 3.12 so the table matches the release the port replaces')
    return ('// Python %s str.isprintable() is False for these code points >= U+00A0 (Unicode %s).\n'
            'export const NONPRINTABLE_UNICODE = %r;\n'
            'export const NONPRINTABLE = %r;' % (sys.version.split()[0], unicodedata.unidata_version,
                                                 unicodedata.unidata_version, ' '.join(ranges())))


if __name__ == '__main__':
    print(table())
