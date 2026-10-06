/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_SETTINGS_READ_H
#define OPENFLOAT_SETTINGS_READ_H

#include <stddef.h>
struct zms_fs;

/* Boot-only read of an existing Settings/ZMS key. Unlike the SDK's name lookup,
 * preserve storage errors instead of treating them as absent settings. Returns
 * the exact value length, zero for a missing key, or a negative error. A name
 * whose value is missing is malformed, rather than a fresh-device default.
 * Oversized values return -EMSGSIZE without reading into the destination.
 * The caller initializes Settings and serializes against all Settings writers.
 */
int openfloat_settings_read(struct zms_fs *fs, const char *key, void *data, size_t capacity);

#endif
