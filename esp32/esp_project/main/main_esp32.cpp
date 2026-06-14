// =========================================================================
// main_esp32.cpp — point d'entrée ESP32-S3 pour PinMAME (mode BLE)
// Périphérique BLE "PinMAME" avec les UUIDs identiques au runtime Node.js
// =========================================================================

#include <stdio.h>
#include <string.h>
#include <stdint.h>

#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_log.h"
#include "esp_spiffs.h"
#include "nvs_flash.h"
#include "nvs.h"
#include "esp_system.h"
#include "esp_heap_caps.h"
#include "esp_task_wdt.h"

// NimBLE
#include "nimble/nimble_port.h"
#include "nimble/nimble_port_freertos.h"
#include "host/ble_hs.h"
#include "host/util/util.h"
#include "services/gap/ble_svc_gap.h"
#include "services/gatt/ble_svc_gatt.h"

static const char* TAG = "PinMAME";

static char ROM_NAME[32] = "bonebstr";  // modifiable via @rom:name=

// Lire/écrire le nom de ROM dans NVS
static void nvs_load_rom(void) {
    nvs_handle_t h;
    if (nvs_open("pinmame", NVS_READONLY, &h) == ESP_OK) {
        size_t len = sizeof(ROM_NAME);
        nvs_get_str(h, "rom", ROM_NAME, &len);
        nvs_close(h);
    }
}
static void nvs_save_rom(const char* name) {
    nvs_handle_t h;
    if (nvs_open("pinmame", NVS_READWRITE, &h) == ESP_OK) {
        nvs_set_str(h, "rom", name);
        nvs_commit(h);
        nvs_close(h);
    }
}

// ─── UUIDs — identiques au runtime Node.js (LSB-first pour NimBLE) ──────────
// Service :  ab120001-b5a3-f393-e0a9-e50e24dcca9e
// OUT(notify): ab120002-…    IN(write): ab120003-…
static const ble_uuid128_t ble_svc_uuid = {
    .u     = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x9e,0xca,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
               0x93,0xf3,0xa3,0xb5,0x01,0x00,0x12,0xab }
};
static const ble_uuid128_t ble_out_uuid = {
    .u     = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x9e,0xca,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
               0x93,0xf3,0xa3,0xb5,0x02,0x00,0x12,0xab }
};
static const ble_uuid128_t ble_in_uuid = {
    .u     = { .type = BLE_UUID_TYPE_128 },
    .value = { 0x9e,0xca,0xdc,0x24,0x0e,0xe5,0xa9,0xe0,
               0x93,0xf3,0xa3,0xb5,0x03,0x00,0x12,0xab }
};

// ─── État global BLE ─────────────────────────────────────────────────────────
uint16_t g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
uint16_t g_ble_out_handle  = 0;   // handle valeur de la caractéristique OUT

// Dernier état connu — renvoyé au client à la connexion
static char s_last_display[128] = {};
static char s_last_lamp[64]     = {};
static char s_last_status[128]  = {};

extern "C" void     ble_resend_last_state(void);
extern "C" uint8_t* pinmame_get_dsprom_ptr(void);

// ─── Parsing des commandes BLE entrantes ─────────────────────────────────────
static void handle_ble_command(const char* line) {
    uint8_t* corridor = pinmame_get_dsprom_ptr();
    ESP_LOGI(TAG, "[BLE←] \"%s\"", line);

    // @set:id=N&state=S  →  corridor[100 + N] = S
    if (strncmp(line, "@set:id=", 8) == 0) {
        int id = 0, state = 0;
        const char* p = line + 8;
        while (*p >= '0' && *p <= '9') id = id * 10 + (*p++ - '0');
        const char* s = strstr(p, "&state=");
        if (s) state = atoi(s + 7);
        if (id >= 0 && id < 80) {
            corridor[100 + id] = (uint8_t)(state ? 1 : 0);
            ESP_LOGI(TAG, "  → sw[%d] = %d (corridor[%d])", id, state, 100 + id);
        } else {
            ESP_LOGW(TAG, "  → id=%d hors limites (0-79)", id);
        }
        return;
    }

    // @sound:cmd=N  →  corridor[1060] = N
    if (strncmp(line, "@sound:cmd=", 11) == 0) {
        int cmd = atoi(line + 11);
        corridor[1060] = (uint8_t)cmd;
        ESP_LOGI(TAG, "  → sound cmd=%d", cmd);
        return;
    }

    // @connect:  →  renvoyer l'état courant
    if (strncmp(line, "@connect:", 9) == 0) {
        ESP_LOGI(TAG, "  → @connect, renvoi état");
        ble_resend_last_state();
        return;
    }

    // @reboot:  →  redémarrage immédiat
    if (strncmp(line, "@reboot:", 8) == 0) {
        ESP_LOGI(TAG, "  → reboot");
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
        return;
    }

    // @rom:name=<name>  →  sauvegarder en NVS + reboot
    if (strncmp(line, "@rom:name=", 10) == 0) {
        const char* name = line + 10;
        // décoder %XX simple (juste les cas courants)
        char decoded[32] = {};
        int di = 0;
        for (int si = 0; name[si] && di < 31; ) {
            if (name[si] == '%' && name[si+1] && name[si+2]) {
                char hex[3] = { name[si+1], name[si+2], 0 };
                decoded[di++] = (char)strtol(hex, NULL, 16);
                si += 3;
            } else {
                decoded[di++] = name[si++];
            }
        }
        ESP_LOGI(TAG, "  → changement ROM : %s", decoded);
        nvs_save_rom(decoded);
        vTaskDelay(pdMS_TO_TICKS(200));
        esp_restart();
        return;
    }

    // Commandes ignorées silencieusement (audio, capture, dip, scope…)
    if (strncmp(line, "@audio:", 7) == 0 ||
        strncmp(line, "@dip:",   5) == 0 ||
        strncmp(line, "@capture:", 9) == 0 ||
        strncmp(line, "@scope:", 7) == 0) {
        return;
    }

    ESP_LOGW(TAG, "  → commande non reconnue : %s", line);
}

// ─── Buffer d'assemblage des chunks IN ───────────────────────────────────────
static char  s_in_buf[512] = {};
static int   s_in_len      = 0;

// ─── GATT handlers ───────────────────────────────────────────────────────────
static int gatt_out_access(uint16_t conn_handle, uint16_t attr_handle,
                           struct ble_gatt_access_ctxt* ctxt, void* arg) {
    return 0;
}

static int gatt_in_access(uint16_t conn_handle, uint16_t attr_handle,
                          struct ble_gatt_access_ctxt* ctxt, void* arg) {
    if (ctxt->op != BLE_GATT_ACCESS_OP_WRITE_CHR) return 0;

    uint16_t pktlen = OS_MBUF_PKTLEN(ctxt->om);
    if (pktlen < 1) return 0;

    uint8_t flag = 0;
    os_mbuf_copydata(ctxt->om, 0, 1, &flag);
    ESP_LOGI(TAG, "[BLE chunk] flag=0x%02x len=%d", flag, pktlen);

    uint16_t dlen = pktlen - 1;
    if (dlen > 0 && s_in_len + (int)dlen < (int)sizeof(s_in_buf) - 1) {
        os_mbuf_copydata(ctxt->om, 1, dlen, s_in_buf + s_in_len);
        s_in_len += (int)dlen;
    }

    if (flag == 0x01) {  // dernier chunk — ligne complète
        s_in_buf[s_in_len] = '\0';
        // trim \n
        while (s_in_len > 0 && (s_in_buf[s_in_len-1] == '\n' || s_in_buf[s_in_len-1] == '\r'))
            s_in_buf[--s_in_len] = '\0';
        if (s_in_len > 0)
            handle_ble_command(s_in_buf);
        s_in_len = 0;
    }
    return 0;
}

static const struct ble_gatt_svc_def gatt_svcs[] = {
    {
        .type            = BLE_GATT_SVC_TYPE_PRIMARY,
        .uuid            = &ble_svc_uuid.u,
        .characteristics = (struct ble_gatt_chr_def[]) {
            {
                .uuid       = &ble_out_uuid.u,
                .access_cb  = gatt_out_access,
                .flags      = BLE_GATT_CHR_F_NOTIFY,
                .val_handle = &g_ble_out_handle,
            },
            {
                .uuid      = &ble_in_uuid.u,
                .access_cb = gatt_in_access,
                .flags     = BLE_GATT_CHR_F_WRITE | BLE_GATT_CHR_F_WRITE_NO_RSP,
            },
            { 0 }
        },
    },
    { 0 }
};

// ─── GAP ─────────────────────────────────────────────────────────────────────
static void start_advertising(void);

static int gap_event_cb(struct ble_gap_event* event, void* arg) {
    switch (event->type) {
    case BLE_GAP_EVENT_CONNECT:
        if (event->connect.status == 0) {
            g_ble_conn_handle = event->connect.conn_handle;
            ESP_LOGI(TAG, "BLE connecté (handle=%d)", g_ble_conn_handle);
            // Renvoi de l'état courant au nouveau client
            vTaskDelay(pdMS_TO_TICKS(50));  // laisser le CCCD s'activer
            ble_resend_last_state();
        } else {
            g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
            start_advertising();
        }
        break;
    case BLE_GAP_EVENT_DISCONNECT:
        ESP_LOGI(TAG, "BLE déconnecté (raison=%d)", event->disconnect.reason);
        g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
        start_advertising();
        break;
    case BLE_GAP_EVENT_MTU:
        ESP_LOGI(TAG, "BLE MTU négocié : %d octets", event->mtu.value);
        break;
    default:
        break;
    }
    return 0;
}

static void start_advertising(void) {
    struct ble_hs_adv_fields fields = {};
    const char* name           = "PINMAME_esp32";
    fields.flags               = BLE_HS_ADV_F_DISC_GEN | BLE_HS_ADV_F_BREDR_UNSUP;
    fields.name                = (const uint8_t*)name;
    fields.name_len            = (uint8_t)strlen(name);
    fields.name_is_complete    = 1;
    fields.uuids128            = &ble_svc_uuid;
    fields.num_uuids128        = 1;
    fields.uuids128_is_complete = 1;

    int rc = ble_gap_adv_set_fields(&fields);
    if (rc) { ESP_LOGE(TAG, "ble_gap_adv_set_fields: %d", rc); return; }

    struct ble_gap_adv_params adv_params = {};
    adv_params.conn_mode = BLE_GAP_CONN_MODE_UND;
    adv_params.disc_mode = BLE_GAP_DISC_MODE_GEN;

    rc = ble_gap_adv_start(BLE_OWN_ADDR_PUBLIC, NULL, BLE_HS_FOREVER,
                           &adv_params, gap_event_cb, NULL);
    if (rc) { ESP_LOGE(TAG, "ble_gap_adv_start: %d", rc); return; }
    ESP_LOGI(TAG, "BLE advertising 'PinMAME'");
}

static void ble_sync_cb(void) {
    ble_hs_util_ensure_addr(0);
    start_advertising();
}

static void ble_reset_cb(int reason) {
    ESP_LOGW(TAG, "BLE reset (raison=%d)", reason);
    g_ble_conn_handle = BLE_HS_CONN_HANDLE_NONE;
}

// ─── Tâche NimBLE ─────────────────────────────────────────────────────────────
static void ble_host_task(void* param) {
    nimble_port_run();           // bloquant jusqu'à nimble_port_stop()
    nimble_port_freertos_deinit();
}

// ─── Tâche d'émulation ───────────────────────────────────────────────────────
extern "C" {
    uint8_t* pinmame_get_dsprom_ptr(void);
    void     pinmame_web_boot(void);
}

static void emulation_task(void* arg) {
    (void)arg;
    // Laisser le BLE s'initialiser avant de démarrer l'émulation
    vTaskDelay(pdMS_TO_TICKS(1500));
    // La tâche monopolise intentionnellement le core 1 — désactiver le watchdog
    esp_task_wdt_delete(xTaskGetCurrentTaskHandle());
    ESP_LOGI(TAG, "Démarrage émulation ROM: %s", ROM_NAME);
    pinmame_web_boot();
    ESP_LOGI(TAG, "osd_exit — émulation terminée");
    vTaskDelete(NULL);
}

// ─── app_main ────────────────────────────────────────────────────────────────
extern "C" void app_main(void) {
    ESP_LOGI(TAG, "PinMAME ESP32-S3 démarrage (mode BLE)...");

    // NVS
    esp_err_t ret = nvs_flash_init();
    if (ret == ESP_ERR_NVS_NO_FREE_PAGES || ret == ESP_ERR_NVS_NEW_VERSION_FOUND) {
        nvs_flash_erase();
        nvs_flash_init();
    }

    // SPIFFS
    esp_vfs_spiffs_conf_t spiffs_conf = {
        .base_path              = "/spiffs",
        .partition_label        = NULL,
        .max_files              = 20,
        .format_if_mount_failed = false,
    };
    ret = esp_vfs_spiffs_register(&spiffs_conf);
    if (ret != ESP_OK) {
        ESP_LOGE(TAG, "Échec montage SPIFFS (%s)", esp_err_to_name(ret));
    } else {
        size_t total = 0, used = 0;
        esp_spiffs_info(NULL, &total, &used);
        ESP_LOGI(TAG, "SPIFFS monté : %u Ko / %u Ko", (unsigned)(used/1024), (unsigned)(total/1024));
    }

    // Charger le nom de ROM depuis NVS (si sauvegardé via @rom:name=)
    nvs_load_rom();
    ESP_LOGI(TAG, "ROM : %s", ROM_NAME);

    // Nom de la ROM dans le corridor partagé
    uint8_t* corridor = pinmame_get_dsprom_ptr();
    strncpy((char*)(corridor + 1000), ROM_NAME, 20);
    corridor[1000 + strnlen(ROM_NAME, 20)] = '\0';

    // NimBLE
    ret = nimble_port_init();
    if (ret != ESP_OK) { ESP_LOGE(TAG, "nimble_port_init failed: %d", ret); return; }

    ble_hs_cfg.sync_cb  = ble_sync_cb;
    ble_hs_cfg.reset_cb = ble_reset_cb;

    ble_svc_gap_init();
    ble_svc_gatt_init();
    ble_svc_gap_device_name_set("PINMAME_esp32");

    ble_gatts_count_cfg(gatt_svcs);
    ble_gatts_add_svcs(gatt_svcs);

    nimble_port_freertos_init(ble_host_task);

    // Émulation sur Core 1
    BaseType_t ok = xTaskCreatePinnedToCore(
        emulation_task, "pinmame", 32768, NULL, 5, NULL, 1
    );
    if (ok != pdPASS)
        ESP_LOGE(TAG, "Impossible de créer la tâche PinMAME");
}
