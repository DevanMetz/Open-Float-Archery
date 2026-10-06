"""Verify C counter transitions and extended traces with the Python BLE clients."""
import contextlib
import io
import sys
from pathlib import Path

from openfloat_ble_client import parse_binary_frame
from verify_offline_queue import parse_trace_chunk


data = Path(sys.argv[1]).read_bytes()
expected = [
    "OFSHOT(ble) shot_count=100 shot_id=70000 shot_sequence=0",
    "OFCOUNT(ble) shot_count=10",
    "OFSHOT(ble) shot_count=11 shot_id=70001 shot_sequence=0",
    "OFCOUNT(ble) shot_count=0",
    "OFSHOT(ble) shot_count=1 shot_id=70002 shot_sequence=0",
]
recovery = [(51, 70003), (1, 70005), (201, 90001), (4294967295, 1),
            (101, 1), (1, 0), (1, 0), (12346, 70002)]
assert len(data) == (len(expected) + 2 + len(recovery)) * 29
for index, text in enumerate(expected):
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert parse_binary_frame(data[index * 29:(index + 1) * 29]) is None
    assert output.getvalue().strip() == text
for index in range(2):
    frame = data[(len(expected) + index) * 29:(len(expected) + index + 1) * 29]
    assert parse_trace_chunk(frame) == (70002, index, 2, bytes(15 if index == 0 else 6), 7)

for index, (count, capture_id) in enumerate(recovery):
    offset = (len(expected) + 2 + index) * 29
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        assert parse_binary_frame(data[offset:offset + 29]) is None
    assert output.getvalue().strip() == f"OFSHOT(ble) shot_count={count} shot_id={capture_id} shot_sequence=0"

# Full-width indexes, legacy compatibility, and corrupt/version bounds.
extended = bytearray(data[len(expected) * 29:(len(expected) + 1) * 29])
extended[8:10] = (256).to_bytes(2, "little")
extended[10:12] = (300).to_bytes(2, "little")
assert parse_trace_chunk(extended) == (70002, 256, 300, bytes(15), 7)
for offset, value in ((2, 3), (12, 16), (12, 0), (13, 0x88)):
    invalid = bytearray(extended); invalid[offset] = value
    assert parse_trace_chunk(invalid) is None
invalid = bytearray(extended); invalid[8:10] = (300).to_bytes(2, "little")
assert parse_trace_chunk(invalid) is None
legacy = bytearray(29); legacy[:4] = b"OF\x01\x06"
legacy[4:9] = b"\x01\x00\x00\x01\x07"; legacy[28] = 7
assert parse_trace_chunk(legacy) == (1, 0, 1, bytes(7), 7)
assert parse_trace_chunk(b"OF") is None
print("Verified Python counter transitions, boot ID recovery/wrap, full-ID traces, legacy chunks, and malformed frame rejection.")
