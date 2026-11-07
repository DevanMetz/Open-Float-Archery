#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
FIRMWARE_DIR="$REPO_ROOT/firmware"

NCS_VERSION="${NCS_VERSION:-v3.3.0}"
NCS_WORKSPACE="${NCS_WORKSPACE:-$HOME/ncs/workspace}"

if [[ -n "${NRFUTIL:-}" ]]; then
    NRFUTIL_BIN="$NRFUTIL"
elif command -v nrfutil >/dev/null 2>&1; then
    NRFUTIL_BIN="$(command -v nrfutil)"
elif [[ -x "$HOME/.local/bin/nrfutil" ]]; then
    NRFUTIL_BIN="$HOME/.local/bin/nrfutil"
else
    printf 'Error: nrfutil was not found. Install it or set NRFUTIL to its path.\n' >&2
    exit 1
fi

if ! command -v git >/dev/null 2>&1; then
    printf 'Error: git is required to update the repository.\n' >&2
    exit 1
fi

if [[ ! -d "$NCS_WORKSPACE/.west" ]]; then
    printf 'Error: NCS west workspace not found at %s.\n' "$NCS_WORKSPACE" >&2
    printf 'Set NCS_WORKSPACE to the workspace initialized for NCS %s.\n' "$NCS_VERSION" >&2
    exit 1
fi

if ! git -C "$REPO_ROOT" diff-index --quiet HEAD --; then
    printf 'Error: repository has tracked changes. Commit or stash them before updating.\n' >&2
    exit 1
fi

printf 'Updating repository from the current branch upstream...\n'
git -C "$REPO_ROOT" pull --ff-only

build_variant() {
    local device_id="$1"
    local config_file="$2"
    local build_dir="$FIRMWARE_DIR/build-$device_id"
    local expected_name="OpenFloat-$device_id"
    local config_output="$build_dir/firmware/zephyr/.config"
    local image="$build_dir/$expected_name.hex"

    printf '\nBuilding %s...\n' "$expected_name"
    "$NRFUTIL_BIN" toolchain-manager launch \
        --ncs-version "$NCS_VERSION" \
        --chdir "$NCS_WORKSPACE" \
        -- west build -p always \
        -b xiao_nrf54l15/nrf54l15/cpuapp \
        -d "$build_dir" \
        "$FIRMWARE_DIR" \
        -- "-DOVERLAY_CONFIG=$FIRMWARE_DIR/$config_file"

    if ! grep -Fqx "CONFIG_BT_DEVICE_NAME=\"$expected_name\"" "$config_output"; then
        printf 'Error: built configuration does not advertise as %s.\n' "$expected_name" >&2
        exit 1
    fi

    if [[ ! -s "$build_dir/merged.hex" ]]; then
        printf 'Error: build did not produce %s.\n' "$build_dir/merged.hex" >&2
        exit 1
    fi

    cp -- "$build_dir/merged.hex" "$image"
    printf 'Created %s\n' "$image"
}

build_variant RLFA1 prj_RLFA1.conf
build_variant RLFA2 prj_RLFA2.conf

printf '\nBoth firmware images are ready to flash.\n'
