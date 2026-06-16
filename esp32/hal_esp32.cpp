// =========================================================================
// hal_esp32.cpp — HAL PinMAME pour ESP32-S3 (mode BLE)
// Protocol identique au runtime Node.js (@abandonware/bleno) :
//   premier octet du paquet = 0x00 (suite) ou 0x01 (dernier chunk)
//   reste du paquet = UTF-8
// Lignes envoyées : !display:action=text&data=<url>  !lamp:<24hex>  @status:…
// =========================================================================

#include <stdio.h>
#include <string.h>
#include <stdint.h>
#include <stdlib.h>
#include "esp_timer.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/stream_buffer.h"
#include "esp_log.h"

// NimBLE
#include "host/ble_hs.h"
#include "host/ble_att.h"

static const char* TAG = "HAL";

extern "C" void esp_loge_fps(float fps) {
    ESP_LOGE("FPS", "emulation: %.1f fps", fps);
}

typedef int64_t hal_cycles_t;

// Déclarés dans main_esp32.cpp
extern uint16_t g_ble_conn_handle;
extern uint16_t g_ble_out_handle;

// DAC depuis api.cpp
extern "C" {
    int  api_get_dac_count(int c);
    int* api_get_dac_buffer(int c);
    void api_reset_dac_buffer(int c);
}

// ─── Dernier état — renvoyé au client qui se connecte ────────────────────────
static char s_last_display[256] = {};
static char s_last_lamp[64]     = {};
static char s_last_status[256]  = {};

// ─── URL encode (A-Z a-z 0-9 -_.~ → tel quel, reste → %XX) ──────────────────
static void url_encode(const char* src, char* dst, size_t dstlen) {
    static const char hex[] = "0123456789ABCDEF";
    size_t j = 0;
    for (size_t i = 0; src[i] && j + 4 < dstlen; i++) {
        uint8_t c = (uint8_t)src[i];
        if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
            (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~') {
            dst[j++] = (char)c;
        } else {
            dst[j++] = '%';
            dst[j++] = hex[c >> 4];
            dst[j++] = hex[c & 0xf];
        }
    }
    dst[j] = '\0';
}

// ─── bleSend : envoie une ligne via BLE notify (chunking identique Node.js) ──
static void bleSend(const char* line) {
    if (g_ble_conn_handle == BLE_HS_CONN_HANDLE_NONE) return;
    if (!g_ble_out_handle) return;

    // Buffer = line + '\n'
    char buf[512];
    size_t total = (size_t)snprintf(buf, sizeof(buf) - 1, "%s\n", line);
    if (total >= sizeof(buf)) total = sizeof(buf) - 1;

    // MTU : ATT MTU - 3 (header ATT) - 1 (byte protocole) = max data par chunk
    uint16_t att_mtu = ble_att_mtu(g_ble_conn_handle);
    if (att_mtu < 4) att_mtu = 23;
    int chunk_size = (int)(att_mtu - 3 - 1);
    if (chunk_size < 1) chunk_size = 1;

    size_t offset = 0;
    while (offset < total) {
        size_t chunk = (size_t)chunk_size;
        if (offset + chunk > total) chunk = total - offset;
        bool is_last = (offset + chunk >= total);

        // Packet : [0x00|0x01][data...]
        uint8_t packet[512];
        packet[0] = is_last ? 0x01 : 0x00;
        memcpy(packet + 1, buf + offset, chunk);

        struct os_mbuf* om = ble_hs_mbuf_from_flat(packet, chunk + 1);
        if (!om) break;

        int rc = ble_gatts_notify_custom(g_ble_conn_handle, g_ble_out_handle, om);
        if (rc != 0) {
            // om consommé par ble_gatts_notify_custom même en erreur
            g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            break;
        }

        offset += chunk;
    }
}

// ─── Renvoi de l'état au client qui vient de se connecter ────────────────────
extern "C" void ble_resend_last_state(void) {
    if (s_last_status[0])  bleSend(s_last_status);
    if (s_last_display[0]) bleSend(s_last_display);
    if (s_last_lamp[0])    bleSend(s_last_lamp);
}

// ─── Prototype audio-over-BLE ─────────────────────────────────────────────
// Paquet = [0x02][échantillons mono 8-bit, 11025Hz] — tag 0x02 distinct des
// flags texte (0x00/0x01) utilisés par bleSend(). Pas de réassemblage côté
// navigateur : chaque notify est un chunk audio autonome.
extern "C" int api_get_ble_audio_chunk(uint8_t *out, int max_bytes);

static void ble_audio_task(void*) {
    static uint8_t packet[247];
    for (;;) {
        if (g_ble_conn_handle != BLE_HS_CONN_HANDLE_NONE && g_ble_out_handle) {
            uint16_t att_mtu = ble_att_mtu(g_ble_conn_handle);
            if (att_mtu < 4) att_mtu = 23;
            int max_payload = (int)att_mtu - 3 - 1;
            if (max_payload > (int)sizeof(packet) - 1) max_payload = (int)sizeof(packet) - 1;
            if (max_payload > 0) {
                int n = api_get_ble_audio_chunk(packet + 1, max_payload);
                if (n > 0) {
                    packet[0] = 0x02;
                    struct os_mbuf* om = ble_hs_mbuf_from_flat(packet, n + 1);
                    if (om) {
                        int rc = ble_gatts_notify_custom(g_ble_conn_handle, g_ble_out_handle, om);
                        if (rc != 0) g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
                    }
                }
            }
        }
        vTaskDelay(pdMS_TO_TICKS(20));
    }
}

extern "C" void ble_audio_task_start(void) {
    xTaskCreate(ble_audio_task, "ble_audio", 4096, NULL, 5, NULL);
}

extern "C" {

hal_cycles_t hal_cycles(void) {
    return (hal_cycles_t)(esp_timer_get_time() * 1000LL);
}

hal_cycles_t hal_cycles_per_second(void) { return 1000000000LL; }

void hal_sleep_ms(int ms) {
    if (ms > 0) vTaskDelay(pdMS_TO_TICKS(ms));
}

void hal_osd_exit(void) {
    ESP_LOGI(TAG, "osd_exit");
}

// ─── Audio USB ───────────────────────────────────────────────────────────────
// 735 samples stéréo 16-bit par frame × 2 octets = 2940 octets/frame
// 16 frames de tampon ≈ 267 ms de latence max
#define USB_AUDIO_FRAME_BYTES  2940
#define USB_AUDIO_SB_SIZE      (USB_AUDIO_FRAME_BYTES * 16)

static StreamBufferHandle_t g_audio_sb = NULL;

extern "C" void usb_audio_init(void) {
    g_audio_sb = xStreamBufferCreate(USB_AUDIO_SB_SIZE, USB_AUDIO_FRAME_BYTES);
}

extern "C" size_t usb_audio_read(void* dst, size_t want, uint32_t timeout_ms) {
    if (!g_audio_sb) return 0;
    return xStreamBufferReceive(g_audio_sb, dst, want, pdMS_TO_TICKS(timeout_ms));
}

void hal_push_audio(uintptr_t ptr, int count, uint32_t gen) {
    (void)gen;
    for (int c = 0; c < 2; c++) api_reset_dac_buffer(c);
    if (!g_audio_sb || !ptr || count <= 0) return;
    // count = nombre de INT16 (stéréo interleaved) → count*2 octets
    xStreamBufferSend(g_audio_sb, (const void*)ptr, (size_t)(count * 2), 0);
}

void hal_push_display(uintptr_t ptr, uint32_t gen) {
    (void)gen;
    if (!ptr) return;

    // Format identique au runtime WASM : "!display:action=raw&data=<160 hex chars>"
    // 40 uint16_t little-endian, chacun en 4 hex chars
    const uint8_t* p = (const uint8_t*)ptr;
    char line[200]; // 25 + 160 + 1
    memcpy(line, "!display:action=raw&data=", 25);
    int off = 25;
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 40; i++) {
        uint16_t val = (uint16_t)(p[i * 2] | ((uint16_t)p[i * 2 + 1] << 8));
        line[off++] = hex[(val >> 12) & 0xf];
        line[off++] = hex[(val >>  8) & 0xf];
        line[off++] = hex[(val >>  4) & 0xf];
        line[off++] = hex[ val        & 0xf];
    }
    line[off] = '\0';

    strncpy(s_last_display, line, sizeof(s_last_display) - 1);
    bleSend(line);
}

// ─── Display texte → !display:action=text&data=<urlencode> ───────────────────
void hal_push_display_text(const char* text, uint32_t gen) {
    // Non utilisé côté ESP32 : hal_push_display (action=raw) est le format rendu
    (void)text; (void)gen;
}

// ─── Lampes → !lamp:<24 hex chars> (12 octets = lampMatrix[0..11]) ───────────
void hal_push_lamps(uintptr_t ptr, uint32_t gen) {
    (void)gen;
    if (!ptr) return;

    const uint8_t* lamp = (const uint8_t*)ptr;
    char line[32];
    // "!lamp:" + 24 hex chars + '\0' = 31 chars
    int off = 0;
    line[off++] = '!'; line[off++] = 'l'; line[off++] = 'a';
    line[off++] = 'm'; line[off++] = 'p'; line[off++] = ':';
    static const char hex[] = "0123456789abcdef";
    for (int i = 0; i < 12; i++) {
        line[off++] = hex[lamp[i] >> 4];
        line[off++] = hex[lamp[i] & 0xf];
    }
    line[off] = '\0';

    strncpy(s_last_lamp, line, sizeof(s_last_lamp) - 1);
    bleSend(line);
}

void hal_push_solens(uint32_t state, uint32_t gen) {
    (void)gen; (void)state;
}

// ─── Machine info → @status:state=ready&<info> ───────────────────────────────
void hal_post_machine_info(const char* info) {
    ESP_LOGI(TAG, "[MACHINE] %s", info);
    ESP_LOGE("MEM", "heap_free=%u internal_free=%u",
        (unsigned)esp_get_free_heap_size(),
        (unsigned)esp_get_free_internal_heap_size());
    char line[256];
    snprintf(line, sizeof(line), "@status:state=ready&%s", info ? info : "");
    strncpy(s_last_status, line, sizeof(s_last_status) - 1);
    bleSend(line);
}

void hal_post_log(uint32_t cmd, uint32_t gen) {
    (void)gen;
    ESP_LOGD(TAG, "[SND] cmd=0x%02X", (unsigned)cmd);
}

const char* hal_rompath(void) { return "/spiffs/roms"; }

} // extern "C"
