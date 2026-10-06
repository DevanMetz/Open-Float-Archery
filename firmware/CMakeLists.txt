# SPDX-License-Identifier: Apache-2.0

cmake_minimum_required(VERSION 3.20.0)

set(DTC_OVERLAY_FILE ${CMAKE_CURRENT_SOURCE_DIR}/app.overlay CACHE STRING "" FORCE)

find_package(Zephyr REQUIRED HINTS $ENV{ZEPHYR_BASE})
project(openfloat-serial)

target_sources(app PRIVATE src/main.c src/trace_buffer.c src/trace_store.c src/shot_log.c src/sleep_flush.c src/settings_read.c src/boot_restore.c src/settings_retry.c src/shot_recovery.c)
# The pinned SDK header defines existing Settings/ZMS IDs. Strict boot reads
# preserve errors hidden by the SDK's bulk and single-key Settings loaders.
target_include_directories(app PRIVATE ${ZEPHYR_BASE}/subsys/settings/include)
# Reject undefined shifts, including narrow literals in 128-bit UUID encoders.
target_compile_options(app PRIVATE -Werror=shift-count-overflow)
target_link_libraries(app PRIVATE m)
