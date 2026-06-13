cmake_minimum_required(VERSION 3.16)

idf_component_register(
    SRCS
        adler32.c compress.c crc32.c deflate.c
        gzclose.c gzlib.c gzread.c gzwrite.c
        infback.c inffast.c inflate.c inftrees.c
        trees.c uncompr.c zutil.c
    INCLUDE_DIRS "."
)

target_compile_options(${COMPONENT_LIB} PRIVATE
    -Wno-implicit-function-declaration
    -D_FORTIFY_SOURCE=0
)
