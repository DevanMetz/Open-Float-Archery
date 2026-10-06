"""Check restored stored-shot frames with the actual Python bench decoder."""
import contextlib
import io
import sys
from pathlib import Path

from openfloat_ble_client import parse_binary_frame


def main():
    data = Path(sys.argv[1]).read_bytes()
    cases = [(65535, 0xfedcba98), (0, 0), (65535, 0xba98), (0, 65535),
             (65535, 0xba98), (0, 65535), (65535, 0xffffffff)]
    assert len(data) == len(cases) * 29
    for index, (count, shot_id) in enumerate(cases):
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            assert parse_binary_frame(data[index * 29:(index + 1) * 29]) is None
        assert output.getvalue().strip() == f"OFSTORED(ble) shot_count={count} shot_id={shot_id}"
    print("Verified Python decoding of C-restored shot logs: legacy and complete 32-bit capture IDs.")


if __name__ == "__main__":
    main()
