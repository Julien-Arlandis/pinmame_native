cmake_minimum_required(VERSION 3.16)

# =========================================================================
# main/CMakeLists.txt — composant principal PinMAME pour ESP32-S3
# =========================================================================

# Racine du dépôt PinMAME (intouchable)
set(PM "${CMAKE_CURRENT_SOURCE_DIR}/../../../workspace/pinmame_stock")
# Racine du projet pinmame_native (api.cpp, esp32/)
set(ROOT "${CMAKE_CURRENT_SOURCE_DIR}/../../..")

# --- Sources PinMAME core -------------------------------------------------
set(PINMAME_SRCS
    ${PM}/src/mame.c
    ${PM}/src/common.c
    ${PM}/src/cpuintrf.c
    ${PM}/src/memory.c
    ${PM}/src/timer.c
    ${PM}/src/palette.c
    ${PM}/src/state.c
    ${PM}/src/cpuexec.c
    ${PM}/src/sndintrf.c
    ${PM}/src/fileio.c
    ${PM}/src/inptport.c
    ${PM}/src/hash.c
    ${PM}/src/cpuint.c
    ${PM}/src/unzip.c
    ${PM}/src/md5.c
    ${PM}/src/sha1.c
    ${PM}/src/config.c
    ${PM}/src/input.c
    # CPU
    ${PM}/src/cpu/m6502/m6502.c
    # WPC / GTS80
    ${PM}/src/wpc/gts80.c
    ${PM}/src/wpc/gts80s.c
    ${PM}/src/wpc/gts80games.c
    ${PM}/src/wpc/core.c
    ${PM}/src/wpc/sim.c
    ${PM}/src/wpc/sndbrd.c
    ${PM}/src/wpc/snd_cmd.c
    ${PM}/src/wpc/mech.c
    # Machines
    ${PM}/src/machine/6532riot.c
    ${PM}/src/machine/6530riot.c
    # Son
    ${PM}/src/sound/dac.c
    ${PM}/src/sound/ym2151.c
    ${PM}/src/sound/2151intf.c
    ${PM}/src/sound/fm.c
    ${PM}/src/sound/streams.c
    ${ROOT}/esp32/mixer_patched.c
    ${PM}/src/sound/filter.c
    ${PM}/src/sound/ay8910.c
    ${PM}/src/sound/sp0250.c
    ${PM}/src/sound/samples.c
    ${PM}/src/sound/votrax.c
    # fileio Unix (osd_display_loading_rom_message renommé pour éviter doublon)
    ${PM}/src/unix/fileio.c
)

# --- Sources HAL + APP ----------------------------------------------------
set(APP_SRCS
    main_esp32.cpp
    ${ROOT}/api.cpp
    ${ROOT}/esp32/hal_esp32.cpp
    ${ROOT}/esp32/stubs_native.c
    ${ROOT}/esp32/driver0_native.c
    ${ROOT}/esp32/double_as_float.c
)

# --- Includes -------------------------------------------------------------
set(PINMAME_INCS
    ${CMAKE_CURRENT_SOURCE_DIR}      # pinmame_config.h
    ${ROOT}                          # pour api.cpp (-I ROOT_DIR du build natif)
    ${PM}/src
    ${PM}/src/wpc
    ${PM}/src/machine
    ${PM}/src/unix
    ${PM}/src/cpu
    ${PM}/src/sound
)

# --- Enregistrement du composant ------------------------------------------
idf_component_register(
    SRCS        ${PINMAME_SRCS} ${APP_SRCS}
    INCLUDE_DIRS ${PINMAME_INCS}
    REQUIRES    esp_timer freertos nvs_flash spiffs app_update esp_system zlib bt usb
    LDFRAGMENTS "linker.lf"
)


# --- Options de compilation communes à toutes les sources -----------------
target_compile_options(${COMPONENT_LIB} PRIVATE
    -include ${CMAKE_CURRENT_SOURCE_DIR}/pinmame_config.h
    -DINLINE=static\ inline
    -D_FORTIFY_SOURCE=0
    -Wno-implicit-function-declaration
    -Wno-int-conversion
    -Wno-incompatible-pointer-types
    -Wno-unused-function
    -Wno-format
    -Wno-error=format
    -Wno-char-subscripts
    -Wno-unused-const-variable
    -Wno-pointer-sign
    -O2
)

# --- api.cpp : force déclaration logerror (comme le build natif) ----------
set_source_files_properties(${ROOT}/api.cpp PROPERTIES
    COMPILE_FLAGS "-DMAME_DEBUG -std=gnu++17"
)

# --- hal_esp32.cpp & main_esp32.cpp : C++17 --------------------------------
set_source_files_properties(
    ${ROOT}/esp32/hal_esp32.cpp
    main_esp32.cpp
    PROPERTIES COMPILE_FLAGS "-std=gnu++17"
)

# --- unix/fileio.c : renommer osd_display_loading_rom_message --------------
set_source_files_properties(${PM}/src/unix/fileio.c PROPERTIES
    COMPILE_FLAGS "-Dosd_display_loading_rom_message=esp32_broken_osd_msg"
)

# --- FPU : intercepte les routines double ROM → float hardware -------------
# __adddf3/__subdf3 etc. sont dans la ROM ESP32 (pas de FPU DP matériel).
# --wrap redirige tous les appels vers nos versions float (double_as_float.c).
target_link_libraries(${COMPONENT_LIB} INTERFACE
    -Wl,--wrap=__adddf3
    -Wl,--wrap=__subdf3
    -Wl,--wrap=__muldf3
    -Wl,--wrap=__divdf3
    -Wl,--wrap=__ltdf2
    -Wl,--wrap=__ledf2
    -Wl,--wrap=__gtdf2
    -Wl,--wrap=__gedf2
    -Wl,--wrap=__eqdf2
    -Wl,--wrap=__nedf2
    -Wl,--wrap=__floatsidf
    -Wl,--wrap=__floatunsidf
    -Wl,--wrap=__floatdidf
    -Wl,--wrap=__fixdfsi
    -Wl,--wrap=__fixdfdi
    -Wl,--wrap=__extendsfdf2
    -Wl,--wrap=__truncdfsf2
    # GTS80B : neutralise cpu_boost_interleave une fois le CPU audio suspendu
    # (sinon le timer NMI orphelin de gts80s.c continue à hacher le scheduler)
    -Wl,--wrap=cpu_boost_interleave
)

