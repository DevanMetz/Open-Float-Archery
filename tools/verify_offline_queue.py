#!/usr/bin/env python3
"""Verify OpenFloat BLE offline shot queueing and trace download.

Connects to an OpenFloat BLE sensor, resets the shot log, triggers a simulated shot,
verifies that storage status updates, downloads the stored shot, retrieves the
frozen trace chunks, reassembles them, and acknowledges the shot to clear the queue.
"""

from __future__ import annotations

import argparse
import asyncio
import struct
import sys
import time
from dataclasses import dataclass
from typing import Optional


OPENFLOAT_SERVICE_UUID = "8f3f3b10-0f5a-4f4c-9a2d-000000000001"
OPENFLOAT_LIVE_UUID = "8f3f3b10-0f5a-4f4c-9a2d-000000000002"
OPENFLOAT_CONTROL_UUID = "8f3f3b10-0f5a-4f4c-9a2d-000000000003"


@dataclass
class StorageStatus:
    shot_count: int
    pending: int
    upload_id: int
    requested: bool
    dropped: int
    retries: int


@dataclass
class StoredShot:
    shot_count: int
    shot_id: int
    ax: int
    ay: int
    az: int
    threshold: float
    roll: float
    pitch: float
    yaw: float
    clicker: int
    impact: int


async def find_device(name_prefix: str, scan_timeout: float):
    try:
        from bleak import BleakScanner
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: bleak. Install it with:\n"
            "  python -m pip install bleak"
        ) from exc

    print(f"Scanning for BLE device with prefix '{name_prefix}' for {scan_timeout:.1f}s...")
    devices = await BleakScanner.discover(timeout=scan_timeout)
    for device in devices:
        name = device.name or ""
        if name.startswith(name_prefix):
            print(f"Found {name} at {device.address}")
            return device

    print("No matching BLE device found.")
    print("Visible devices:")
    for device in devices:
        print(f"  {device.address}  {device.name or '(unnamed)'}")
    raise SystemExit(2)


async def run_verification(args) -> None:
    try:
        from bleak import BleakClient
    except ImportError as exc:
        raise SystemExit(
            "Missing dependency: bleak. Install it with:\n"
            "  python -m pip install bleak"
        ) from exc

    device = await find_device(args.name_prefix, args.scan_timeout)
    
    # Async queues to receive decoded frames from notification callback
    storage_status_queue = asyncio.Queue()
    stored_shot_queue = asyncio.Queue()
    trace_chunk_queue = asyncio.Queue()
    trace_status_queue = asyncio.Queue()

    loop = asyncio.get_running_loop()

    def on_notify(_sender, data: bytearray) -> None:
        for offset in range(0, len(data), 29):
            frame = data[offset:offset+29]
            if len(frame) < 29 or frame[0:2] != b"OF":
                continue
            frame_type = frame[3]
            
            if frame_type == 5:
                # Storage Status
                shot_count, pending, upload_id_low, requested, dropped, upload_id_high, retries = struct.unpack("<HHHHHHH", frame[4:18])
                upload_id = upload_id_low + upload_id_high * 0x10000
                status = StorageStatus(
                    shot_count=shot_count,
                    pending=pending,
                    upload_id=upload_id,
                    requested=requested == 1,
                    dropped=dropped,
                    retries=retries
                )
                loop.call_soon_threadsafe(storage_status_queue.put_nowait, status)
                
            elif frame_type == 4:
                # Stored Shot
                shot_count, shot_id_low, ax, ay, az, threshold, roll, pitch, yaw, clicker, impact, shot_id_high = struct.unpack("<HHhhhHhhhHHH", frame[4:28])
                shot_id = shot_id_low + shot_id_high * 0x10000
                shot = StoredShot(
                    shot_count=shot_count,
                    shot_id=shot_id,
                    ax=ax,
                    ay=ay,
                    az=az,
                    threshold=threshold / 100.0,
                    roll=roll / 100.0,
                    pitch=pitch / 100.0,
                    yaw=yaw / 100.0,
                    clicker=clicker,
                    impact=impact
                )
                loop.call_soon_threadsafe(stored_shot_queue.put_nowait, shot)
                
            elif frame_type == 6:
                # Trace Chunk
                shot_id_low, chunk_index, total_chunks, payload_len = struct.unpack("<HBBB", frame[4:9])
                payload = bytes(frame[9:9+payload_len])
                point_stride = frame[28] if chunk_index == 0 else 0
                loop.call_soon_threadsafe(trace_chunk_queue.put_nowait, (shot_id_low, chunk_index, total_chunks, payload, point_stride))
                
            elif frame_type == 7:
                # Trace Status
                shot_id_low, shot_id_high, status_code = struct.unpack("<HHB", frame[4:9])
                shot_id = shot_id_low + shot_id_high * 0x10000
                loop.call_soon_threadsafe(trace_status_queue.put_nowait, (shot_id, status_code))

    async with BleakClient(device) as client:
        print(f"Connected to {device.address}")
        
        # Subscribing to notifications
        await client.start_notify(OPENFLOAT_LIVE_UUID, on_notify)
        print("Subscribed to telemetry notifications.")

        # Step 1: shotreset to clear queue
        print("Sending command: shotreset")
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, b"shotreset")
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, b"shotdump")
        
        # Verify pending is 0
        try:
            status: StorageStatus = await asyncio.wait_for(storage_status_queue.get(), timeout=3.0)
            print(f"Verified initial storage status: pending={status.pending}, shot_count={status.shot_count}")
            assert status.pending == 0, f"Expected 0 pending stored shots, got {status.pending}"
        except asyncio.TimeoutError:
            print("Timeout waiting for storage status after shotreset")
            sys.exit(1)

        # Step 2: shottrigger to simulate a shot
        print("Sending command: shottrigger (simulate shot)")
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, b"shottrigger")
        
        # Wait for the trace follow-through window to freeze in RAM (default ~1.5s)
        print("Waiting 2.5 seconds for follow-through trace freeze...")
        await asyncio.sleep(2.5)

        # Step 3: Request upload/dump
        print("Sending command: shotdump")
        # Drain queue first
        while not storage_status_queue.empty():
            storage_status_queue.get_nowait()
            
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, b"shotdump")

        # Verify pending is 1
        try:
            status = await asyncio.wait_for(storage_status_queue.get(), timeout=3.0)
            print(f"Verified post-trigger storage status: pending={status.pending}, upload_id={status.upload_id}")
            assert status.pending == 1, f"Expected 1 pending stored shot, got {status.pending}"
        except asyncio.TimeoutError:
            print("Timeout waiting for storage status after shottrigger")
            sys.exit(1)

        # Step 4: Receive stored shot
        try:
            shot: StoredShot = await asyncio.wait_for(stored_shot_queue.get(), timeout=3.0)
            print(f"Received Stored Shot: count={shot.shot_count}, id={shot.shot_id}, "
                  f"accel=({shot.ax},{shot.ay},{shot.az})mg, angles=(roll={shot.roll},pitch={shot.pitch},yaw={shot.yaw})")
            assert shot.shot_id > 0, "Expected positive shot_id"
        except asyncio.TimeoutError:
            print("Timeout waiting for stored shot frame")
            sys.exit(1)

        # Step 5: Request trace for the stored shot
        print(f"Sending command: tracereq:{shot.shot_id}")
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, f"tracereq:{shot.shot_id}".encode("utf-8"))

        # Collect trace chunks
        trace_chunks = {}
        total_chunks = None
        point_stride = None
        
        start_time = time.monotonic()
        while time.monotonic() - start_time < 5.0:
            if total_chunks is not None and len(trace_chunks) == total_chunks:
                break
            
            try:
                # Wait for either chunk or status
                chunk_task = asyncio.create_task(trace_chunk_queue.get())
                status_task = asyncio.create_task(trace_status_queue.get())
                
                done, pending = await asyncio.wait([chunk_task, status_task], return_when=asyncio.FIRST_COMPLETED, timeout=1.0)
                
                for task in pending:
                    task.cancel()
                    
                for task in done:
                    res = task.result()
                    if task == chunk_task:
                        shot_id_low, idx, tot, payload, stride = res
                        print(f"Received trace chunk {idx+1}/{tot} for low_id {shot_id_low} ({len(payload)} bytes)")
                        trace_chunks[idx] = payload
                        if total_chunks is None:
                            total_chunks = tot
                        if idx == 0:
                            point_stride = stride
                    elif task == status_task:
                        req_id, status_code = res
                        print(f"Received trace status for shot {req_id}: status={status_code}")
                        if status_code == 0:
                            print("Trace not found on device!")
                            sys.exit(1)
            except asyncio.TimeoutError:
                pass

        assert total_chunks is not None and len(trace_chunks) == total_chunks, "Did not receive all trace chunks"
        print(f"Successfully downloaded all {total_chunks} trace chunks. Reassembling...")
        
        # Reassemble the trace
        raw_bytes = bytearray()
        for idx in sorted(trace_chunks.keys()):
            raw_bytes.extend(trace_chunks[idx])
            
        print(f"Total reassembled trace size: {len(raw_bytes)} bytes, point_stride: {point_stride}")
        assert len(raw_bytes) > 0, "Reassembled trace is empty"
        assert point_stride in (4, 6, 7, 8), f"Invalid point stride: {point_stride}"

        # Decode some points
        num_points = len(raw_bytes) // point_stride
        print(f"Decoded {num_points} trace points from firmware trace")
        
        # Step 6: Acknowledge stored shot to clear queue
        print(f"Sending command: shotack:{shot.shot_id}")
        # Clear status queue
        while not storage_status_queue.empty():
            storage_status_queue.get_nowait()
            
        await client.write_gatt_char(OPENFLOAT_CONTROL_UUID, f"shotack:{shot.shot_id}".encode("utf-8"))

        # Verify pending returns to 0
        try:
            status = await asyncio.wait_for(storage_status_queue.get(), timeout=3.0)
            print(f"Verified final storage status: pending={status.pending}")
            assert status.pending == 0, f"Expected 0 pending stored shots, got {status.pending}"
        except asyncio.TimeoutError:
            print("Timeout waiting for final storage status")
            sys.exit(1)

        print("\nPASS: Offline shot queue and trace reassembly verified successfully!")


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify BLE offline queue and trace download.")
    parser.add_argument("--name-prefix", default="OpenFloat", help="BLE name prefix to scan for.")
    parser.add_argument("--scan-timeout", type=float, default=8.0, help="BLE scan time in seconds.")
    args = parser.parse_args()
    
    try:
        asyncio.run(run_verification(args))
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
