/* SPDX-License-Identifier: Apache-2.0 */
#include "settings_read.h"
#include <errno.h>
#include <string.h>
#include <zephyr/sys/hash_function.h>
#include "settings/settings_zms.h"

#if !defined(CONFIG_SETTINGS_ZMS) || defined(CONFIG_SETTINGS_ZMS_LEGACY)
#error "Strict Settings reads require the configured non-legacy ZMS backend"
#endif

int openfloat_settings_read(struct zms_fs *fs, const char *key, void *data, size_t capacity)
{
	if (!fs || !fs->ready) return -EACCES;
	size_t length = strlen(key);
	if (!length || length >= SETTINGS_FULL_NAME_LEN) return -EINVAL;
	uint32_t hash = sys_hash32(key, length) & ZMS_HASH_MASK;
	for (unsigned int collision = 0; collision <= ZMS_MAX_COLLISIONS; collision++) {
		uint32_t name_id = ZMS_NAME_ID_FROM_HASH(ZMS_UPDATE_COLLISION_NUM(hash, collision));
		ssize_t rc = zms_get_data_length(fs, name_id);
		if (rc == -ENOENT) continue;
		if (rc < 0) return (int)rc;
		if ((size_t)rc != length) continue;
		char name[SETTINGS_FULL_NAME_LEN];
		rc = zms_read(fs, name_id, name, length);
		if (rc < 0) return (int)rc;
		if ((size_t)rc != length) return -EBADMSG;
		if (memcmp(name, key, length)) continue;
		uint32_t value_id = ZMS_DATA_ID_FROM_NAME(name_id);
		rc = zms_get_data_length(fs, value_id);
		if (rc == -ENOENT || rc == 0) return -EBADMSG;
		if (rc < 0) return (int)rc;
		if ((size_t)rc > capacity) return -EMSGSIZE;
		size_t size = (size_t)rc;
		rc = zms_read(fs, value_id, data, size);
		return rc < 0 ? (int)rc : ((size_t)rc == size ? (int)rc : -EBADMSG);
	}
	return 0;
}
