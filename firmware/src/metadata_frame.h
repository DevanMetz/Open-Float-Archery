/* SPDX-License-Identifier: Apache-2.0 */
#ifndef OPENFLOAT_METADATA_FRAME_H
#define OPENFLOAT_METADATA_FRAME_H

#include <stdint.h>

/* Type 2/3 v2: retain the 29-byte envelope and release sequence at 26.
 * Former reserved timing words at 22/24 carry the upper counter halves.
 */
static inline void openfloat_write_shot_counters(uint8_t frame[29],
					       uint32_t count, uint32_t shot_id)
{
	frame[2] = 2;
	frame[4] = (uint8_t)count;
	frame[5] = (uint8_t)(count >> 8);
	frame[6] = (uint8_t)shot_id;
	frame[7] = (uint8_t)(shot_id >> 8);
	frame[22] = (uint8_t)(shot_id >> 16);
	frame[23] = (uint8_t)(shot_id >> 24);
	frame[24] = (uint8_t)(count >> 16);
	frame[25] = (uint8_t)(count >> 24);
}

/* Type 5 v2: the former reserved word at 18 extends the lifetime count. */
static inline void openfloat_write_storage_count(uint8_t frame[29], uint32_t count)
{
	frame[2] = 2;
	frame[4] = (uint8_t)count;
	frame[5] = (uint8_t)(count >> 8);
	frame[18] = (uint8_t)(count >> 16);
	frame[19] = (uint8_t)(count >> 24);
}

#endif
