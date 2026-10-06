/* SPDX-License-Identifier: Apache-2.0 */
#include "settings_retry.h"
#include "sleep_flush.h"

void settings_retry_request(struct settings_retry *queue, uint32_t mask, uint32_t now_ms)
{
	mask &= SETTINGS_ALL;
	queue->pending_mask |= mask;
	queue->failed_mask &= ~mask;
	for (unsigned int key = 0; key < SETTING_COUNT; key++) {
		if (!(mask & (UINT32_C(1) << key))) continue;
		queue->token[key]++;
		queue->attempts[key] = 0;
		queue->due_ms[key] = now_ms;
	}
}

int settings_retry_take(struct settings_retry *queue, uint32_t now_ms, uint32_t *token)
{
	for (unsigned int i = 0; i < SETTING_COUNT; i++) {
		unsigned int key = (queue->next_key + i) % SETTING_COUNT;
		uint32_t bit = UINT32_C(1) << key;
		if (!(queue->pending_mask & bit) || (int32_t)(now_ms - queue->due_ms[key]) < 0) continue;
		queue->pending_mask &= ~bit;
		queue->attempts[key]++;
		queue->next_key = (key + 1) % SETTING_COUNT;
		*token = queue->token[key];
		return (int)key;
	}
	return -1;
}

void settings_retry_finish(struct settings_retry *queue, enum openfloat_setting key,
			   uint32_t token, int result, uint32_t now_ms)
{
	if (queue->token[key] != token) return;
	uint32_t bit = UINT32_C(1) << key;
	if (!result) {
		queue->failed_mask &= ~bit;
	} else {
		queue->failed_mask |= bit;
		if (queue->attempts[key] < SETTINGS_RETRY_ATTEMPTS) {
			queue->pending_mask |= bit;
			queue->due_ms[key] = now_ms + SETTINGS_RETRY_DELAY_MS;
		}
	}
}

uint32_t settings_retry_delay(const struct settings_retry *queue, uint32_t now_ms)
{
	uint32_t delay = UINT32_MAX;
	for (unsigned int key = 0; key < SETTING_COUNT; key++) {
		if (!(queue->pending_mask & (UINT32_C(1) << key))) continue;
		int32_t remaining = (int32_t)(queue->due_ms[key] - now_ms);
		if (remaining <= 0) return 0;
		if ((uint32_t)remaining < delay) delay = (uint32_t)remaining;
	}
	return delay;
}

void settings_retry_settle(struct settings_retry *queue, enum openfloat_setting key, int result)
{
	uint32_t bit = UINT32_C(1) << key;
	queue->pending_mask &= ~bit;
	if (result) queue->failed_mask |= bit;
	else queue->failed_mask &= ~bit;
}

const char *settings_retry_key(enum openfloat_setting key)
{
	static const char *const names[] = {
		"openfloat/shots", "openfloat/shotlog", "openfloat/wakesens", "openfloat/sleeptime",
		"openfloat/sleepsens", "openfloat/bufrate", "openfloat/bufnvs", "openfloat/autosleep",
		"openfloat/streamrate", "openfloat/followms", "openfloat/cant_offset", "openfloat/pitch_offset",
	};
	_Static_assert(sizeof(names) / sizeof(names[0]) == SETTING_COUNT, "Settings key list changed");
	return names[key];
}

int settings_retry_save(enum openfloat_setting key, const struct sleep_flush_values *values,
			int (*write)(void *context, const char *key, const void *data, size_t size), void *context)
{
	const void *const data[] = {
		&values->counters, values->queue, &values->wakesens, &values->sleeptime,
		&values->sleepsens, &values->bufrate, &values->bufnvs, &values->autosleep,
		&values->streamrate, &values->followms, &values->cant_offset, &values->pitch_offset,
	};
	_Static_assert(sizeof(data) / sizeof(data[0]) == SETTING_COUNT, "Settings value list changed");
	size_t size = key == SETTING_SHOTS ? sizeof(values->counters) :
		(key == SETTING_SHOTLOG ? sizeof(*values->queue) : sizeof(uint32_t));
	return write(context, settings_retry_key(key), data[key], size);
}
