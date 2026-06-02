# Open-Float-Archery

## BLE Telemetry Test Client

The host-side BLE validation script is:

```text
tools/openfloat_ble_client.py
```

Install its Python dependency:

```powershell
python -m pip install bleak
```

Scan for an OpenFloat BLE peripheral and print decoded telemetry:

```powershell
python tools\openfloat_ble_client.py --name-prefix OpenFloat --every
```

Run for 30 seconds and save decoded samples:

```powershell
python tools\openfloat_ble_client.py --duration 30 --csv openfloat_ble_capture.csv
```

If the first firmware bring-up uses Nordic UART Service instead of the custom
OpenFloat GATT UUIDs, add `--nus`:

```powershell
python tools\openfloat_ble_client.py --nus --name-prefix OpenFloat --every
```
