#pragma once
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

void audio_push_frame(uint32_t emulator_generation);
void audio_frame_pacing(uint32_t js_buffer_dist);

#ifdef __cplusplus
}
#endif
